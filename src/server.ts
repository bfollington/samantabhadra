import { routeAgentRequest, type AgentNamespace, type Schedule } from "agents";

import { unstable_getSchedulePrompt } from "agents/schedule";

import { AIChatAgent } from "agents/ai-chat-agent";
import { MCPClientManager } from "agents/mcp/client";
import {
  createDataStreamResponse,
  generateId,
  streamText,
  type StreamTextOnFinishCallback,
} from "ai";
import { openai } from "@ai-sdk/openai";
import { anthropic } from "@ai-sdk/anthropic";
import { processToolCalls } from "./utils";
import { tools, executions } from "./tools";
import { fragmentTools } from "./fragment-tools";
import { AsyncLocalStorage } from "node:async_hooks";
import type {
  Tool,
  Prompt,
  Resource,
} from "@modelcontextprotocol/sdk/types.js";
import { handleMemosApi } from './memos-api';
import type { Ai, Vectorize } from "@cloudflare/workers-types/experimental";
import { SYSTEM_PROMPT } from "./prompt";
// import { env } from "cloudflare:workers";

// Models configuration
const OPENAI_MODEL_NAME = "gpt-4.1-2025-04-14";
const ANTHROPIC_MODEL_NAME = "claude-sonnet-4-20250514";

const openaiModel = openai(OPENAI_MODEL_NAME);
const anthropicModel = anthropic(ANTHROPIC_MODEL_NAME);

// Default to OpenAI model
let currentModel = openaiModel;

// Function to set the current model
function setCurrentModel(modelName: string) {
  if (modelName === ANTHROPIC_MODEL_NAME) {
    currentModel = anthropicModel;
  } else {
    currentModel = openaiModel;
  }
  return currentModel;
}

// Cloudflare AI Gateway
// const openai = createOpenAI({
//   apiKey: env.OPENAI_API_KEY,
//   baseURL: env.GATEWAY_BASE_URL,
// });

type Env = {
  Chat: AgentNamespace<Chat>;
  HOST: string;
  OPENAI_API_KEY: string;
  ANTHROPIC_API_KEY: string;
  VECTORIZE: Vectorize;
  AI: Ai;
};

export type Server = {
  url: string;
  state: "authenticating" | "connecting" | "ready" | "discovering" | "failed";
  authUrl?: string;
};

export type State = {
  servers: Record<string, Server>;
  tools: (Tool & { serverId: string })[];
  prompts: (Prompt & { serverId: string })[];
  resources: (Resource & { serverId: string })[];
  currentModelName: string;
};

// we use ALS to expose the agent context to the tools
export const agentContext = new AsyncLocalStorage<Chat>();
/**
 * Chat Agent implementation that handles real-time AI chat interactions
 */
export class Chat extends AIChatAgent<Env, State> {
  /**
   * Track which user messages have already been turned into fragments so we
   * don\'t create duplicates every render.
   */
  private processedUserMessageIds = new Set<string>();

  // Holds slugs of fragments auto-created during the current turn so we can
  // inform the language model via the system prompt.
  private autoFragmentSlugs: string[] = [];

  /**
   * When we compute semantically related fragments in the background we store
   * them here and inject them into the *next* turn's system prompt.
   */


  /**
   * Opportunistically create a fragment from the most recent user message if
   * we haven\'t done so yet and the content is long enough to be meaningful.
   */
  async maybeCreateFragment() {
    // Grab the latest user message
    const lastMsg = [...this.messages].reverse().find((m) => m.role === "user");
    if (!lastMsg) return;

    if (this.processedUserMessageIds.has(lastMsg.id)) {
      return; // already handled
    }

    // Simple heuristic: skip if the message is very short
    if (typeof lastMsg.content !== "string" || lastMsg.content.trim().length < 20) {
      return;
    }

    // Generate a slug from first few words
    function slugify(text: string) {
      return text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, "")
        .trim()
        .split(/\s+/)
        .slice(0, 6)
        .join("-");
    }

    let baseSlug = slugify(lastMsg.content);
    if (!baseSlug) {
      baseSlug = `fragment-${crypto.randomUUID().slice(0, 8)}`;
    }

    // Call the fragment creation tool via its execute function
    try {
      // Actually create the fragment in storage / Vectorize
      const { fragmentTools: fragTools } = await import("./fragment-tools");
      const resultMsg = await fragTools.createFragment.execute({
        slug: baseSlug,
        content: lastMsg.content as string,
        speaker: "user",
        ts: new Date().toISOString(),
        metadata: JSON.stringify({ auto: true }),
      });

      this.processedUserMessageIds.add(lastMsg.id);
      console.log(`Auto-created fragment '${baseSlug}' from latest user message.`);

      // Record the slug so we can tell the model in the system prompt for
      // this turn. We don't add any synthetic messages, keeping the timeline
      // clean so the model can generate a full reply.
      this.autoFragmentSlugs.push(baseSlug);
    } catch (err) {
      // Suppress errors (e.g., duplicate slug) to avoid interrupting the chat flow
      console.warn("maybeCreateFragment failed", err);
    }
  }
  initialState = {
    servers: {},
    tools: [],
    prompts: [],
    resources: [],
    currentModelName: OPENAI_MODEL_NAME,
  };

  /**
   * Creates embeddings for text using the AI service
   */
  async createEmbeddings(text: string): Promise<number[]> {
    try {
      if (!this.env.AI) {
        throw new Error('AI service not available');
      }

      const response = await this.env.AI.run(
        '@cf/baai/bge-base-en-v1.5',
        { text }
      );

      if (response?.data?.[0]) {
        return response.data[0];
      }

      throw new Error('Failed to generate embeddings');
    } catch (error) {
      console.error('Error creating embeddings:', error);
      throw error;
    }
  }

  /**
   * Store vector embeddings in Vectorize
   */
  async storeVectorEmbedding(id: string, values: number[], metadata: Record<string, any> = {}): Promise<void> {
    try {
      if (!this.env.VECTORIZE) {
        throw new Error('Vectorize service not available');
      }

      await this.env.VECTORIZE.upsert([{ id, values, metadata }]);
    } catch (error) {
      console.error('Error storing vector embedding:', error);
      throw error;
    }
  }

  /**
   * Delete vector embeddings from Vectorize
   */
  async deleteVectorEmbedding(id: string): Promise<void> {
    try {
      if (!this.env.VECTORIZE) {
        throw new Error('Vectorize service not available');
      }

      // For Cloudflare Vectorize, we'll need to use the available API
      // Since the exact API varies, we'll try different approaches
      try {
        // The standard Vectorize API use 'delete' with an array of IDs
        // @ts-ignore - handle type errors, as the API may vary
        await this.env.VECTORIZE.delete([id]);
      } catch (e) {
        try {
          // Some versions might use 'deleteOne' instead
          // @ts-ignore - handle type errors, as the API may vary
          await this.env.VECTORIZE.deleteOne(id);
        } catch (e2) {
          // If both methods fail, log it but don't fail the operation
          console.warn('Vector deletion not fully implemented, skipping deletion of:', id);
        }
      }
    } catch (error) {
      console.error(`Error deleting vector embedding ${id}:`, error);
      // Don't throw the error, as this is a non-critical operation
    }
  }

  /**
   * Search for similar vectors in Vectorize
   */
  async searchSimilarVectors(queryVector: number[], limit: number = 5, threshold: number = 0): Promise<any> {
    try {
      if (!this.env.VECTORIZE) {
        throw new Error('Vectorize service not available');
      }

      console.log(`Searching for similar vectors with limit: ${limit}`);
      const results = await this.env.VECTORIZE.query(queryVector, {
        topK: limit,
        returnMetadata: true,
        // Only apply threshold if it's greater than 0
        ...(threshold > 0 ? { threshold } : {})
      });

      console.log(`Found ${results?.matches?.length || 0} vector matches`);
      if (results?.matches?.length > 0) {
        console.log(`First match score: ${results.matches[0].score}`);
        if (results.matches[0].metadata) {
          console.log(`First match metadata: ${JSON.stringify(results.matches[0].metadata)}`);
        }
      }

      return results;
    } catch (error) {
      console.error('Error searching similar vectors:', error);
      throw error;
    }
  }

  mcp = new MCPClientManager("chat", "1.0.0", {
    baseCallbackUri: `${this.env.HOST}agents/chat/samantabhadra/callback`,
    storage: this.ctx.storage,
  });

  setServerState(id: string, state: Server) {
    this.setState({
      ...this.state,
      servers: {
        ...this.state.servers,
        [id]: state,
      },
    });
  }

  async refreshServerData() {
    this.setState({
      ...this.state,
      prompts: this.mcp.listPrompts(),
      tools: this.mcp.listTools(),
      resources: this.mcp.listResources(),
    });
  }

  async addMcpServer(url: string): Promise<string> {
    console.log(`Registering server: ${url}`);
    const { id, authUrl } = await this.mcp.connect(url);
    console.log(`Connected to MCP server with ID: ${id}`);
    this.setServerState(id, {
      url,
      authUrl,
      state: this.mcp.mcpConnections[id].connectionState,
    });
    return authUrl ?? "";
  }

  /**
   * Handles incoming chat messages and manages the response stream
   * @param onFinish - Callback function executed when streaming completes
   */

  // biome-ignore lint/complexity/noBannedTypes: <explanation>
  async onChatMessage(onFinish: StreamTextOnFinishCallback<{}>) {
    // Create a streaming response that handles both text and tool outputs
    return agentContext.run(this, async () => {
      const dataStreamResponse = createDataStreamResponse({
        execute: async (dataStream) => {
          // Process any pending tool calls from previous messages
          // This handles human-in-the-loop confirmations for tools
          // Proactively (but not incessantly) create a fragment from the last user message
          await this.maybeCreateFragment();

          const processedMessages = await processToolCalls({
            messages: this.messages,
            dataStream,
            tools,
            executions,
          });

          // --- build semantic context synchronously -------------
          const lastUser = [...this.messages].reverse().find((m) => m.role === "user");

          let contextBlocks = "";

          if (lastUser && typeof lastUser.content === "string") {
            // Fetch related fragments
            const relatedFragBlock = await this.buildContextFromFragments(lastUser.content);
            if (relatedFragBlock) {
              contextBlocks += `\n\n---- Related fragments ----\n${relatedFragBlock}\n--------------------------------\n`;
            }

            // Fetch related memos
            const relatedMemosBlock = await this.buildContextFromMemos(lastUser.content);
            if (relatedMemosBlock) {
              contextBlocks += `\n\n---- Related memos ----\n${relatedMemosBlock}\n--------------------------------\n`;
            }
          }

          const systemPrompt = contextBlocks
            ? SYSTEM_PROMPT + contextBlocks
            : SYSTEM_PROMPT;

          // Set the current model based on state
          const modelToUse = setCurrentModel(this.state.currentModelName || OPENAI_MODEL_NAME);

          const result = streamText({
            model: modelToUse,
            system: systemPrompt,
            messages: processedMessages,
            tools,
            onFinish,
            onError: (error) => {
              console.error("Error while streaming:", error);
            },
            maxSteps: 10,
          });

          // Merge the AI response stream with tool execution outputs
          result.mergeIntoDataStream(dataStream);
        },
      });

      return dataStreamResponse;
    });
  }
  async executeTask(description: string, task: Schedule<string>) {
    await this.saveMessages([
      ...this.messages,
      {
        id: generateId(),
        role: "user",
        content: `Running scheduled task: ${description}`,
        createdAt: new Date(),
      },
    ]);
  }

  /** Build context from up to 3 semantically-related fragments */
  private async buildContextFromFragments(text: string): Promise<string> {
    try {
      const embed = await this.createEmbeddings(text);
      const search = await this.searchSimilarVectors(embed, 3, 0.75);
      const ids = (search.matches ?? [])
        .map((m: any) => m.metadata?.fragment_id)
        .filter(Boolean);
      if (!ids.length) return "";

      const rows: { slug: string; content: string }[] = [];
      for (const fid of ids) {
        const res = await this.sql`
          SELECT slug, content FROM fragments WHERE id = ${fid} LIMIT 1`;
        if (res[0]) rows.push(res[0]);
      }

      return rows
        .map(
          (r: any, i: number) =>
            `#${i + 1} [[${r.slug}]]\n${r.content}`
        )
        .join("\n\n");
    } catch (err) {
      console.warn("context-fragment lookup failed", err);
      return "";
    }
  }

  /** Build context from up to 3 semantically-related memos */
  private async buildContextFromMemos(text: string): Promise<string> {
    try {
      const embed = await this.createEmbeddings(text);
      const search = await this.searchSimilarVectors(embed, 3, 0.75);
      const ids = (search.matches ?? [])
        .map((m: any) => m.metadata?.memo_id)
        .filter(Boolean);
      if (!ids.length) return "";

      const rows: { slug: string; content: string }[] = [];
      for (const memoId of ids) {
        const res = await this.sql`
          SELECT slug, content FROM memos WHERE id = ${memoId} LIMIT 1`;
        if (res[0]) rows.push(res[0]);
      }

      return rows
        .map(
          (r: any, i: number) =>
            `#${i + 1} [[${r.slug}]]\n${r.content}`
        )
        .join("\n\n");
    } catch (err) {
      console.warn("context-memo lookup failed", err);
      return "";
    }
  }


  /**
   * Handles API requests for memos
   */
  /**
   * Handles API requests for fragments (read-only for now)
   */
  async handleFragmentsApi(request: Request): Promise<Response | null> {
    const url = new URL(request.url);

    // GET /agents/chat/<id>/list-fragments?limit=50&offset=0&q=foo
    if (url.pathname.endsWith("list-fragments") && request.method === "GET") {
      try {
        const limit = Number(url.searchParams.get("limit") || "50");
        const offset = Number(url.searchParams.get("offset") || "0");
        const q = (url.searchParams.get("q") || "").trim();

        // Ensure fragments & edges tables exist (no-op if they already do)
        await this.sql`
          CREATE TABLE IF NOT EXISTS fragments (
            id        TEXT PRIMARY KEY,
            slug      TEXT UNIQUE NOT NULL,
            content   TEXT NOT NULL,
            speaker   TEXT,
            ts        TEXT NOT NULL,
            convo_id  TEXT,
            metadata  TEXT NOT NULL,
            created   TEXT NOT NULL,
            modified  TEXT NOT NULL
          );`;

        await this.sql`
          CREATE TABLE IF NOT EXISTS fragment_edges (
            id       TEXT PRIMARY KEY,
            from_id  TEXT NOT NULL,
            to_id    TEXT NOT NULL,
            rel      TEXT NOT NULL,
            weight   REAL,
            metadata TEXT NOT NULL,
            created  TEXT NOT NULL
          );`;

        // ------ Build queries --------------
        let totalRes;
        let rowsRes;
        if (q) {
          const likeParam = "%" + q + "%";
          totalRes = await this.sql`
            SELECT COUNT(*) AS count FROM fragments f
            WHERE lower(f.slug) LIKE lower(${likeParam}) OR lower(f.content) LIKE lower(${likeParam});`;

          rowsRes = await this.sql`
            SELECT
              f.id,
              f.slug,
              f.content,
              f.speaker,
              f.created,
              f.modified,
              (
                SELECT COUNT(*) FROM fragment_edges fe
                WHERE fe.from_id = f.id OR fe.to_id = f.id
              ) AS link_count
            FROM fragments f
            WHERE lower(f.slug) LIKE lower(${likeParam}) OR lower(f.content) LIKE lower(${likeParam})
            ORDER BY f.modified DESC
            LIMIT ${limit} OFFSET ${offset};`;
        } else {
          totalRes = await this.sql`SELECT COUNT(*) AS count FROM fragments;`;

          rowsRes = await this.sql`
            SELECT
              f.id,
              f.slug,
              f.content,
              f.speaker,
              f.created,
              f.modified,
              (
                SELECT COUNT(*) FROM fragment_edges fe
                WHERE fe.from_id = f.id OR fe.to_id = f.id
              ) AS link_count
            FROM fragments f
            ORDER BY f.modified DESC
            LIMIT ${limit} OFFSET ${offset};`;
        }

        const total = totalRes[0].count as number;
        const rows = rowsRes;

        return Response.json({ total, items: rows });
      } catch (err) {
        console.error("Error listing fragments", err);
        return new Response("Error listing fragments", { status: 500 });
      }
    }

    // GET /agents/chat/<id>/fragment-graph?limit=1000
    if (url.pathname.endsWith("fragment-graph") && request.method === "GET") {
      try {
        const limit = Number(url.searchParams.get("limit") || "1000");

        // ensure tables
        await this.sql`
          CREATE TABLE IF NOT EXISTS fragments (
            id        TEXT PRIMARY KEY,
            slug      TEXT UNIQUE NOT NULL,
            content   TEXT NOT NULL,
            speaker   TEXT,
            ts        TEXT NOT NULL,
            convo_id  TEXT,
            metadata  TEXT NOT NULL,
            created   TEXT NOT NULL,
            modified  TEXT NOT NULL
          );`;

        await this.sql`
          CREATE TABLE IF NOT EXISTS fragment_edges (
            id       TEXT PRIMARY KEY,
            from_id  TEXT NOT NULL,
            to_id    TEXT NOT NULL,
            rel      TEXT NOT NULL,
            weight   REAL,
            metadata TEXT NOT NULL,
            created  TEXT NOT NULL
          );`;

        // Nodes – most connected first (limit)
        const nodes = await this.sql`
          SELECT
            f.id,
            f.slug,
            (
              SELECT COUNT(*) FROM fragment_edges fe
              WHERE fe.from_id = f.id OR fe.to_id = f.id
            ) AS link_count
          FROM fragments f
          ORDER BY link_count DESC
          LIMIT ${limit};`;

        // Links – all edges between any two fragments
        const links = await this.sql`
          SELECT
            f1.slug AS source,
            f2.slug AS target,
            fe.rel  AS type,
            COALESCE(fe.weight, 1) AS weight
          FROM fragment_edges fe
          JOIN fragments f1 ON fe.from_id = f1.id
          JOIN fragments f2 ON fe.to_id = f2.id;`;

        return Response.json({ nodes, links });
      } catch (err) {
        console.error("Error building fragment graph", err);
        return new Response("Error building fragment graph", { status: 500 });
      }
    }

    // GET /agents/chat/<id>/fragment?slug=<slug>
    if (url.pathname.endsWith("fragment") && request.method === "GET") {
      try {
        const slug = url.searchParams.get("slug");
        if (!slug) {
          return new Response("Missing slug parameter", { status: 400 });
        }

        // Ensure tables exist
        await this.sql`
          CREATE TABLE IF NOT EXISTS fragments (
            id        TEXT PRIMARY KEY,
            slug      TEXT UNIQUE NOT NULL,
            content   TEXT NOT NULL,
            speaker   TEXT,
            ts        TEXT NOT NULL,
            convo_id  TEXT,
            metadata  TEXT NOT NULL,
            created   TEXT NOT NULL,
            modified  TEXT NOT NULL
          );`;

        await this.sql`
          CREATE TABLE IF NOT EXISTS fragment_edges (
            id       TEXT PRIMARY KEY,
            from_id  TEXT NOT NULL,
            to_id    TEXT NOT NULL,
            rel      TEXT NOT NULL,
            weight   REAL,
            metadata TEXT NOT NULL,
            created  TEXT NOT NULL
          );`;

        // 1. Get the main fragment
        const frag = await this.sql`
          SELECT * FROM fragments WHERE slug = ${slug} LIMIT 1`;

        if (!frag.length) {
          return new Response("Fragment not found", { status: 404 });
        }

        // 2. Get outgoing links
        const outgoing = await this.sql`
          SELECT fe.rel, fe.to_id, f2.slug AS to_slug
          FROM fragment_edges fe
          JOIN fragments f2 ON fe.to_id = f2.id
          WHERE fe.from_id = ${frag[0].id}`;

        // 3. Get incoming links
        const incoming = await this.sql`
          SELECT fe.rel, fe.from_id, f2.slug AS from_slug
          FROM fragment_edges fe
          JOIN fragments f2 ON fe.from_id = f2.id
          WHERE fe.to_id = ${frag[0].id}`;

        return Response.json({ fragment: frag[0], outgoing, incoming });
      } catch (err) {
        console.error("Error fetching fragment", err);
        return new Response("Error fetching fragment", { status: 500 });
      }
    }

    // GET /agents/chat/<id>/fragment-exists?slug=<slug>
    if (url.pathname.endsWith("fragment-exists") && request.method === "GET") {
      try {
        const slug = url.searchParams.get("slug");
        if (!slug) {
          return new Response("Missing slug parameter", { status: 400 });
        }

        const result = await this.sql`
          SELECT COUNT(*) as count FROM fragments WHERE slug = ${slug} LIMIT 1`;

        return Response.json({ exists: result[0]?.count > 0 });
      } catch (err) {
        console.error("Error checking fragment existence", err);
        return new Response("Error checking fragment existence", { status: 500 });
      }
    }

    return null;
  }

  /**
   * Get an entire thread starting from a memo slug
   * Returns the root memo and all descendants in order
   */
  async getThread(slug: string): Promise<any> {
    try {
      console.log("Getting thread for slug:", slug);

      // Initialize memos table to ensure parent_id and author columns exist
      const { initMemosTableWithAgent } = await import("./memo-tools");
      await initMemosTableWithAgent(this);

      // First, get the memo by slug
      const memoResult = await this.sql`
        SELECT * FROM memos WHERE slug = ${slug}
      `;

      console.log("Initial memo result:", memoResult.length);

      if (!memoResult.length) {
        return null;
      }

      let currentMemo = memoResult[0];
      console.log("Found memo:", { id: currentMemo.id, slug: currentMemo.slug, parent_id: currentMemo.parent_id });

      // Walk up to find the root of the thread
      while (currentMemo.parent_id) {
        console.log("Walking up to parent:", currentMemo.parent_id);
        const parentResult = await this.sql`
          SELECT * FROM memos WHERE id = ${currentMemo.parent_id}
        `;

        if (!parentResult.length) break;
        currentMemo = parentResult[0];
      }

      const rootMemo = currentMemo;
      console.log("Root memo found:", { id: rootMemo.id, slug: rootMemo.slug });

      // Get all memos that might be in this thread
      const allMemos = await this.sql`
        SELECT * FROM memos
        WHERE parent_id = ${rootMemo.id} OR id = ${rootMemo.id}
        ORDER BY created ASC
      `;

      console.log("Direct children found:", allMemos.length);

      // Also get any replies to replies (second level)
      const childIds = allMemos.filter(m => m.id !== rootMemo.id).map(m => m.id);
      let secondLevel: any[] = [];

      if (childIds.length > 0) {
        console.log("Looking for second level replies to:", childIds.length, "children");
        // Use a simple approach for now - get replies to each child
        for (const childId of childIds) {
          const replies = await this.sql`
            SELECT * FROM memos WHERE parent_id = ${childId} ORDER BY created ASC
          `;
          secondLevel.push(...replies);
        }
      }

      // Combine and sort all memos by created time
      const threadMemos = [...allMemos, ...secondLevel].sort((a, b) =>
        new Date(a.created).getTime() - new Date(b.created).getTime()
      );

      console.log("Total thread memos:", threadMemos.length);

      return {
        root: rootMemo,
        memos: threadMemos,
        total: threadMemos.length
      };
    } catch (error) {
      console.error("Error getting thread:", error);
      return null;
    }
  }

  async handleMemosApi(request: Request): Promise<Response | null> {
    // Import the memos API handlers
    return handleMemosApi(this, request);
  }

  async onRequest(request: Request): Promise<Response> {
    // Extract URL for all endpoint checks
    const url = new URL(request.url);

    // Check if Anthropic API key is configured
    if (url.pathname.endsWith("/check-anthropic-key") && request.method === "GET") {
      return new Response(JSON.stringify({
        success: !!this.env.ANTHROPIC_API_KEY
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    // Handle thread endpoints
    if (url.pathname.endsWith("/thread") && request.method === "GET") {
      const slug = url.searchParams.get("slug");
      console.log("Thread request for slug:", slug);

      if (!slug) {
        return new Response("Missing slug parameter", { status: 400 });
      }

      const thread = await this.getThread(slug);
      console.log("Thread result:", thread ? `Found ${thread.total} memos` : "Not found");

      if (!thread) {
        return new Response("Thread not found", { status: 404 });
      }

      return Response.json(thread);
    }

    // Handle create reply endpoint
    if (url.pathname.endsWith("/create-reply") && request.method === "POST") {
      try {
        const data = await request.json() as { parent_slug: string; content: string; author?: string };
        const { parent_slug, content, author = "user" } = data;

        console.log("Create reply request:", { parent_slug, content, author });

        if (!parent_slug || !content) {
          console.log("Missing required fields:", { parent_slug: !!parent_slug, content: !!content });
          return new Response("Missing required fields", { status: 400 });
        }

        // Initialize memos table to ensure parent_id and author columns exist
        const { initMemosTableWithAgent, memoTools } = await import("./memo-tools");
        await initMemosTableWithAgent(this);

        // Use the createReply tool with agent context
        const result = await agentContext.run(this, async () => {
          return await memoTools.createReply.execute({
            parent_slug,
            content,
            author
          });
        });

        console.log("Reply created successfully:", result);
        return Response.json({ success: true, message: result });
      } catch (error) {
        console.error("Error creating reply:", error);
        return Response.json({ success: false, error: error instanceof Error ? error.message : "Internal server error" }, { status: 500 });
      }
    }

    // Handle generate response endpoint
    if (url.pathname.endsWith("/generate-response") && request.method === "POST") {
      try {
        const data = await request.json() as { memo_id: string };
        const { memo_id } = data;

        console.log("Generate response request for memo:", memo_id);

        if (!memo_id) {
          return new Response("Missing memo_id parameter", { status: 400 });
        }

        // Initialize memos table
        const { initMemosTableWithAgent } = await import("./memo-tools");
        await initMemosTableWithAgent(this);

        // Get the placeholder memo
        const placeholderResult = await this.sql`
          SELECT * FROM memos WHERE id = ${memo_id}
        `;

        if (!placeholderResult.length) {
          return new Response("Memo not found", { status: 404 });
        }

        const placeholder = placeholderResult[0];

        // Get the thread context
        const thread = await this.getThread(placeholder.slug);
        if (!thread) {
          return new Response("Thread not found", { status: 404 });
        }

        // Build context from the thread
        const threadContext = thread.memos.map((memo: any) =>
          `${memo.author === 'assistant' ? 'Assistant' : 'User'}: ${memo.content}`
        ).join('\n\n');

        // Build context from related fragments and memos
        const fragmentContext = await this.buildContextFromFragments(threadContext);
        const memoContext = await this.buildContextFromMemos(threadContext);

        // Generate response using the AI model
        const systemPrompt = `${SYSTEM_PROMPT}

Thread context:
${threadContext}

Related fragments:
${fragmentContext}

Related memos:
${memoContext}

Please provide a helpful response to continue this conversation thread.`;

        try {
          const result = await streamText({
            model: currentModel,
            prompt: systemPrompt,
            tools: executions,
            onFinish: async (result) => {
              try {
                // Update the placeholder memo with the generated response
                const response = result.text || "Sorry, I couldn't generate a response.";
                const now = new Date().toISOString();

                await this.sql`
                  UPDATE memos
                  SET content = ${response}, modified = ${now}
                  WHERE id = ${memo_id}
                `;

                console.log("Generated response updated in memo:", memo_id);
              } catch (updateError) {
                console.error("Error updating memo with generated response:", updateError);
                // Update with error message
                const now = new Date().toISOString();
                await this.sql`
                  UPDATE memos
                  SET content = "Sorry, I encountered an error while generating a response.", modified = ${now}
                  WHERE id = ${memo_id}
                `;
              }
            }
          });

          // Return success immediately while the generation happens in background
          return Response.json({ success: true, message: "Response generation started" });
        } catch (aiError) {
          console.error("Error during AI text generation:", aiError);

          // Update placeholder with error message
          const now = new Date().toISOString();
          await this.sql`
            UPDATE memos
            SET content = "Sorry, I encountered an error while generating a response.", modified = ${now}
            WHERE id = ${memo_id}
          `;

          return Response.json({ success: false, error: "AI generation failed" }, { status: 500 });
        }
      } catch (error) {
        console.error("Error generating response:", error);
        return Response.json({ success: false, error: error instanceof Error ? error.message : "Internal server error" }, { status: 500 });
      }
    }

    if (url.pathname.endsWith("/set-model") && request.method === "POST") {
      try {
        const { modelName } = await request.json() as { modelName: string };

        // Validate model name
        if (modelName !== OPENAI_MODEL_NAME && modelName !== ANTHROPIC_MODEL_NAME) {
          return new Response(JSON.stringify({
            success: false,
            error: `Invalid model name. Supported models: ${OPENAI_MODEL_NAME}, ${ANTHROPIC_MODEL_NAME}`
          }), {
            status: 400,
            headers: { "Content-Type": "application/json" }
          });
        }

        // Check if the appropriate API key is configured
        if (modelName === ANTHROPIC_MODEL_NAME && !this.env.ANTHROPIC_API_KEY) {
          return new Response(JSON.stringify({
            success: false,
            error: "Anthropic API key is not configured. Please set the ANTHROPIC_API_KEY environment variable."
          }), {
            status: 400,
            headers: { "Content-Type": "application/json" }
          });
        }

        if (modelName === OPENAI_MODEL_NAME && !this.env.OPENAI_API_KEY) {
          return new Response(JSON.stringify({
            success: false,
            error: "OpenAI API key is not configured. Please set the OPENAI_API_KEY environment variable."
          }), {
            status: 400,
            headers: { "Content-Type": "application/json" }
          });
        }

        // Update the state with the new model name
        this.setState({
          ...this.state,
          currentModelName: modelName
        });

        return new Response(JSON.stringify({
          success: true,
          currentModel: modelName
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      } catch (err) {
        console.error("Error setting model:", err);
        return new Response(JSON.stringify({
          success: false,
          error: "Failed to set model"
        }), {
          status: 500,
          headers: { "Content-Type": "application/json" }
        });
      }
    }

    // Check if this is a get-model request
    if (url.pathname.endsWith("/get-model") && request.method === "GET") {
      return new Response(JSON.stringify({
        currentModel: this.state.currentModelName
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    // First check if this is a fragments API request
    const fragmentsApiResponse = await this.handleFragmentsApi(request);
    if (fragmentsApiResponse) {
      return fragmentsApiResponse;
    }

    // Next check if this is a memos API request
    // Handle memo API requests
    const memoApiResponse = await this.handleMemosApi(request);
    if (memoApiResponse) {
      return memoApiResponse;
    }

    if (this.mcp.isCallbackRequest(request)) {
      try {
        const { serverId } = await this.mcp.handleCallbackRequest(request);
        console.log('DEBUG', serverId, this.state);
        this.setServerState(serverId, {
          url: this.state.servers[serverId].url,
          state: this.mcp.mcpConnections[serverId].connectionState,
        });
        await this.refreshServerData();
        // Hack: autoclosing window because a redirect fails for some reason
        // return Response.redirect('http://localhost:5173/', 301)
        return new Response("<script>window.close();</script>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
        // biome-ignore lint/suspicious/noExplicitAny: just bubbling an error up
      } catch (e: any) {
        return new Response(e, { status: 401 });
      }
    }

    const reqUrl = new URL(request.url);
    if (reqUrl.pathname.endsWith("add-mcp") && request.method === "POST") {
      const mcpServer = (await request.json()) as { url: string };
      const authUrl = await this.addMcpServer(mcpServer.url);
      return new Response(authUrl, { status: 200 });
    }

    return super.onRequest(request);
  }
}

/**
 * Worker entry point that routes incoming requests to the appropriate handler
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname === "/check-open-ai-key") {
      const hasOpenAIKey = !!process.env.OPENAI_API_KEY;
      return Response.json({
        success: hasOpenAIKey,
      });
    }
    if (!process.env.OPENAI_API_KEY) {
      console.error(
        "OPENAI_API_KEY is not set, don't forget to set it locally in .dev.vars, and use `wrangler secret bulk .dev.vars` to upload it to production"
      );
    }
    return (
      // Route the request to our agent or return 404 if not found
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  },
} satisfies ExportedHandler<Env>;
