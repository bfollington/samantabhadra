import { routeAgentRequest, type AgentNamespace, type Schedule } from "agents";

import { unstable_getSchedulePrompt } from "agents/schedule";

import { AIChatAgent } from "agents/ai-chat-agent";
import { MCPClientManager } from "agents/mcp/client";
import {
  createDataStreamResponse,
  generateId,
  generateText,
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

      const embedding = await this.env.AI.run("@cf/baai/bge-base-en-v1.5", {
        text: text
      });

      return embedding.data[0];
    } catch (error) {
      // Only log in development if it's not an authentication error
      if (!(error instanceof Error && error.message.includes('Authentication error'))) {
        console.error('Error creating embeddings:', error);
      } else {
        console.log('Embeddings unavailable in development mode (authentication error)');
      }
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

    // POST /agents/chat/<id>/create-fragment
    if (url.pathname.endsWith("create-fragment") && request.method === "POST") {
      try {
        const data = await request.json() as {
          title: string;
          content: string;
          source_memo_id?: string;
        };
        const { title, content, source_memo_id } = data;

        if (!title || !content) {
          return new Response("Missing required fields", { status: 400 });
        }

        // Ensure fragments table exists
        await this.sql`
          CREATE TABLE IF NOT EXISTS fragments (
            id        TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
            slug      TEXT UNIQUE NOT NULL,
            content   TEXT NOT NULL,
            speaker   TEXT,
            ts        TEXT NOT NULL,
            convo_id  TEXT,
            metadata  TEXT NOT NULL,
            created   TEXT NOT NULL,
            modified  TEXT NOT NULL
          )`;

        const now = new Date().toISOString();
        const slug = title.toLowerCase()
          .replace(/[^a-z0-9\s]/g, "")
          .trim()
          .split(/\s+/)
          .slice(0, 6)
          .join("-") || `fragment-${Date.now()}`;

        const metadata = JSON.stringify({
          source_memo_id: source_memo_id || null,
          extracted_by: "auto"
        });

        const result = await this.sql`
          INSERT INTO fragments (slug, content, speaker, ts, convo_id, metadata, created, modified)
          VALUES (${slug}, ${content}, 'system', ${now}, null, ${metadata}, ${now}, ${now})
          RETURNING id
        `;

        const fragmentId = result[0].id;

        // Create vector embedding for the fragment
        try {
          const embedding = await this.env.AI.run("@cf/baai/bge-base-en-v1.5", {
            text: content
          });

          await this.env.VECTORIZE.upsert([{
            id: fragmentId,
            values: embedding.data[0],
            metadata: {
              content: content,
              type: "fragment",
              slug: slug
            }
          }]);
        } catch (vectorError) {
          if (!(vectorError instanceof Error && (vectorError.message.includes('Authentication error') || vectorError.message.includes('VECTOR_UPSERT_ERROR')))) {
            console.error("Error creating vector embedding for fragment:", vectorError);
          } else {
            console.log('Fragment vector embedding unavailable in development mode');
          }
          // Continue without vector embedding
        }

        return Response.json({
          success: true,
          id: fragmentId,
          slug: slug,
          message: "Fragment created successfully"
        });
      } catch (error) {
        console.error("Error creating fragment:", error);
        return Response.json({
          success: false,
          error: error instanceof Error ? error.message : "Internal server error"
        }, { status: 500 });
      }
    }

    // POST /agents/chat/<id>/link-fragments
    if (url.pathname.endsWith("link-fragments") && request.method === "POST") {
      try {
        const data = await request.json() as {
          from_memo_id: string;
          to_fragment_id: string;
          relationship: string;
        };
        const { from_memo_id, to_fragment_id, relationship } = data;

        if (!from_memo_id || !to_fragment_id || !relationship) {
          return new Response("Missing required fields", { status: 400 });
        }

        // Ensure fragment_edges table exists
        await this.sql`
          CREATE TABLE IF NOT EXISTS fragment_edges (
            id       TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
            from_id  TEXT NOT NULL,
            to_id    TEXT NOT NULL,
            rel      TEXT NOT NULL,
            weight   REAL,
            metadata TEXT NOT NULL,
            created  TEXT NOT NULL
          )`;

        const now = new Date().toISOString();
        const metadata = JSON.stringify({
          from_memo_id: from_memo_id,
          relationship_type: "memo_to_fragment"
        });

        await this.sql`
          INSERT INTO fragment_edges (from_id, to_id, rel, weight, metadata, created)
          VALUES (${from_memo_id}, ${to_fragment_id}, ${relationship}, 1.0, ${metadata}, ${now})
        `;

        return Response.json({
          success: true,
          message: "Fragment link created successfully"
        });
      } catch (error) {
        console.error("Error creating fragment link:", error);
        return Response.json({
          success: false,
          error: error instanceof Error ? error.message : "Internal server error"
        }, { status: 500 });
      }
    }

    return null;
  }

  /**
   * Get an entire thread starting from a memo slug
   * Returns the root memo and all descendants in tree structure
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

      // Get ALL memos in this thread recursively
      const allThreadMemos = [];
      const processedIds = new Set();
      const toProcess = [rootMemo.id];

      // Add the root memo first
      allThreadMemos.push(rootMemo);
      processedIds.add(rootMemo.id);

      // Recursively find all descendants
      while (toProcess.length > 0) {
        const currentId = toProcess.shift();
        const children = await this.sql`
          SELECT * FROM memos WHERE parent_id = ${currentId} ORDER BY created ASC
        `;

        for (const child of children) {
          if (!processedIds.has(child.id)) {
            allThreadMemos.push(child);
            processedIds.add(child.id);
            toProcess.push(child.id);
          }
        }
      }

      console.log("All thread memos found:", allThreadMemos.length);

      // Fetch reactions for all memos in the thread
      const memoIds = allThreadMemos.map(memo => memo.id);
      let reactions = [];

      if (memoIds.length > 0) {
        try {
          // Create reactions table if it doesn't exist
          await this.sql`
            CREATE TABLE IF NOT EXISTS reactions (
              id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
              memo_id TEXT NOT NULL,
              emoji TEXT NOT NULL,
              user_id TEXT NOT NULL,
              created TEXT DEFAULT CURRENT_TIMESTAMP,
              UNIQUE(memo_id, emoji, user_id),
              FOREIGN KEY (memo_id) REFERENCES memos (id) ON DELETE CASCADE
            )
          `;

          // Fetch reactions for these memos
          for (const memoId of memoIds) {
            const memoReactions = await this.sql`
              SELECT memo_id, emoji, user_id
              FROM reactions
              WHERE memo_id = ${memoId}
            `;
            reactions.push(...memoReactions);
          }
        } catch (error) {
          console.error('Error fetching reactions for thread:', error);
          // Continue without reactions if there's an error
        }
      }

      // Group reactions by memo_id and emoji
      const reactionsByMemo: { [memoId: string]: { [emoji: string]: string[] } } = {};

      reactions.forEach((reaction: any) => {
        if (!reactionsByMemo[reaction.memo_id]) {
          reactionsByMemo[reaction.memo_id] = {};
        }
        if (!reactionsByMemo[reaction.memo_id][reaction.emoji]) {
          reactionsByMemo[reaction.memo_id][reaction.emoji] = [];
        }
        reactionsByMemo[reaction.memo_id][reaction.emoji].push(reaction.user_id);
      });

      // Build tree structure with reply counts
      const memoMap = new Map();

      // First pass: create memo objects with reply count, reactions, and empty replies array
      for (const memo of allThreadMemos) {
        const replyCount = allThreadMemos.filter(m => m.parent_id === memo.id).length;
        memoMap.set(memo.id, {
          ...memo,
          replies: [],
          replyCount,
          reactions: reactionsByMemo[memo.id] || {}
        });
      }

      // Second pass: build parent-child relationships
      for (const memo of allThreadMemos) {
        const memoWithReplies = memoMap.get(memo.id);
        if (memo.parent_id && memoMap.has(memo.parent_id)) {
          const parent = memoMap.get(memo.parent_id);
          parent.replies.push(memoWithReplies);
        }
      }

      // Get the root with full tree structure
      const rootWithTree = memoMap.get(rootMemo.id);

      // Get the focused memo with its replies
      const focusedMemoWithReplies = memoMap.get(memoResult[0].id);

      console.log("Tree structure built - root has", rootWithTree?.replies?.length || 0, "direct replies");
      console.log("Focused memo has", focusedMemoWithReplies?.replies?.length || 0, "direct replies");

      return {
        root: rootMemo,
        tree: rootWithTree, // The root with its complete tree structure
        memos: allThreadMemos,     // Flat list for compatibility
        total: allThreadMemos.length,
        focusedMemo: focusedMemoWithReplies // The requested memo with its replies
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
        const data = await request.json() as { memo_id: string; persona_id?: string; emoji?: string };
        const { memo_id, persona_id, emoji } = data;

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

        // Build thread context
        const threadContext = thread.memos
          .filter((memo: any) => memo.content !== "Thinking...")
          .map((memo: any) => `${memo.author === 'assistant' ? 'Assistant' : 'User'}: ${memo.content}`)
          .join('\n\n');

        // Build semantic context using existing methods
        const fragmentContext = await this.buildContextFromFragments(threadContext);
        const memoContext = await this.buildContextFromMemos(threadContext);

        let contextBlocks = "";
        if (fragmentContext) {
          contextBlocks += `\n\n---- Related fragments ----\n${fragmentContext}\n--------------------------------\n`;
        }
        if (memoContext) {
          contextBlocks += `\n\n---- Related memos ----\n${memoContext}\n--------------------------------\n`;
        }

        // Get persona if specified
        let persona = null;
        let personaModel = null;
        if (persona_id || emoji) {
          // Initialize emoji personas table first
          await this.sql`
            CREATE TABLE IF NOT EXISTS emoji_personas (
              id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
              emoji TEXT NOT NULL UNIQUE,
              name TEXT NOT NULL,
              description TEXT NOT NULL,
              instructions TEXT NOT NULL,
              model_preference TEXT,
              created TEXT DEFAULT CURRENT_TIMESTAMP,
              modified TEXT DEFAULT CURRENT_TIMESTAMP
            )
          `;

          if (persona_id) {
            const personaResult = await this.sql`
              SELECT * FROM emoji_personas WHERE id = ${persona_id}
            `;
            if (personaResult.length > 0) {
              persona = personaResult[0];
            }
          } else if (emoji) {
            const personaResult = await this.sql`
              SELECT * FROM emoji_personas WHERE emoji = ${emoji}
            `;
            if (personaResult.length > 0) {
              persona = personaResult[0];
            }
          }

          // Set model based on persona preference
          if (persona?.model_preference) {
            personaModel = setCurrentModel(persona.model_preference);
            console.log(`Using persona "${persona.name}" with model: ${persona.model_preference}`);
          }
        }

        // Build system prompt with persona instructions
        let baseSystemPrompt = `${SYSTEM_PROMPT}${contextBlocks}

Thread context:
${threadContext}`;

        let systemPrompt = baseSystemPrompt;
        if (persona) {
          systemPrompt = `${baseSystemPrompt}

PERSONA INSTRUCTIONS:
You are responding as "${persona.name}" (${persona.emoji}) - ${persona.description}

${persona.instructions}

Please respond in character as this persona while being helpful and continuing the conversation thread.`;
        } else {
          systemPrompt = `${baseSystemPrompt}

Please provide a helpful response to continue this conversation thread.`;
        }

        console.log("Starting AI text generation...");
        if (persona) {
          console.log(`Generating response with persona: ${persona.name} (${persona.emoji})`);
        }

        // Simple text generation - no tools
        const result = await generateText({
          model: personaModel || currentModel,
          prompt: systemPrompt,
        });

        console.log("AI generation completed, updating memo...");

        // Update the placeholder memo with persona info
        const response = result.text || "Sorry, I couldn't generate a response.";
        const now = new Date().toISOString();
        
        // Add persona metadata to author field if persona is used
        let authorField = 'assistant';
        if (persona) {
          authorField = `assistant:${persona.emoji}:${persona.name}`;
        }

        await this.sql`
          UPDATE memos
          SET content = ${response}, modified = ${now}, author = ${authorField}
          WHERE id = ${memo_id}
        `;

        console.log("Generated response updated in memo:", memo_id);
        return Response.json({ success: true, message: "Response generated successfully", content: response });
      } catch (error) {
        console.error("Error generating response:", error);

        // Update placeholder with error message
        try {
          const now = new Date().toISOString();
          await this.sql`
            UPDATE memos
            SET content = "Sorry, I encountered an error while generating a response.", modified = ${now}
            WHERE id = ${memo_id}
          `;
        } catch (updateError) {
          console.error("Error updating memo with error message:", updateError);
        }

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

    // Handle add reaction endpoint
    if (url.pathname.endsWith("/add-reaction") && request.method === "POST") {
      try {
        const data = await request.json() as { memo_id: string; emoji: string; user_id: string };
        const { memo_id, emoji, user_id } = data;

        if (!memo_id || !emoji || !user_id) {
          return new Response("Missing required fields", { status: 400 });
        }

        // Initialize reactions table
        await this.sql`
          CREATE TABLE IF NOT EXISTS reactions (
            id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
            memo_id TEXT NOT NULL,
            emoji TEXT NOT NULL,
            user_id TEXT NOT NULL,
            created TEXT DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(memo_id, emoji, user_id),
            FOREIGN KEY (memo_id) REFERENCES memos (id) ON DELETE CASCADE
          )
        `;

        // Add reaction (INSERT OR IGNORE to handle duplicates)
        await this.sql`
          INSERT OR IGNORE INTO reactions (memo_id, emoji, user_id)
          VALUES (${memo_id}, ${emoji}, ${user_id})
        `;

        return Response.json({ success: true, message: "Reaction added successfully" });
      } catch (error) {
        console.error("Error adding reaction:", error);
        return Response.json({ success: false, error: error instanceof Error ? error.message : "Internal server error" }, { status: 500 });
      }
    }

    // Handle remove reaction endpoint
    if (url.pathname.endsWith("/remove-reaction") && request.method === "POST") {
      try {
        const data = await request.json() as { memo_id: string; emoji: string; user_id: string };
        const { memo_id, emoji, user_id } = data;

        if (!memo_id || !emoji || !user_id) {
          return new Response("Missing required fields", { status: 400 });
        }

        // Remove reaction
        await this.sql`
          DELETE FROM reactions
          WHERE memo_id = ${memo_id} AND emoji = ${emoji} AND user_id = ${user_id}
        `;

        return Response.json({ success: true, message: "Reaction removed successfully" });
      } catch (error) {
        console.error("Error removing reaction:", error);
        return Response.json({ success: false, error: error instanceof Error ? error.message : "Internal server error" }, { status: 500 });
      }
    }

    // Handle extract fragments endpoint
    if (url.pathname.endsWith("/extract-fragments") && request.method === "POST") {
      try {
        const data = await request.json() as {
          memo_id: string;
          memo_content: string;
          thread_context: string;
          parent_memo_id: string
        };
        const { memo_id, memo_content, thread_context, parent_memo_id } = data;

        if (!memo_id || !memo_content || !thread_context) {
          return new Response("Missing required fields", { status: 400 });
        }

        console.log("Starting fragment extraction for memo:", memo_id);

        // Search for similar existing fragments using vector similarity
        let vectorResults = { matches: [] };
        try {
          const embedding = await this.env.AI.run("@cf/baai/bge-base-en-v1.5", {
            text: memo_content
          });

          vectorResults = await this.env.VECTORIZE.query(embedding.data[0], {
            topK: 5,
            returnMetadata: true
          });
        } catch (error) {
          if (!(error instanceof Error && error.message.includes('Authentication error'))) {
            console.error('Error in vector similarity search:', error);
          } else {
            console.log('Vector search unavailable in development mode');
          }
          // Continue with empty results
        }

        const similarFragments = vectorResults.matches
          .filter((match: any) => match.score > 0.7)
          .map((match: any) => ({
            id: match.id,
            content: match.metadata?.content || '',
            score: match.score
          }));

        // Build context for LLM
        const similarFragmentsContext = similarFragments.length > 0
          ? `\n\nSimilar existing fragments:\n${similarFragments.map(f => `- ${f.content} (similarity: ${f.score.toFixed(2)})`).join('\n')}`
          : '';

        const extractionPrompt = `You are analyzing a conversation thread to extract key concepts and insights as fragments for a knowledge base.

Thread Context:
${thread_context}

New Reply to Extract From:
${memo_content}

${similarFragmentsContext}

Please analyze this conversation and the new reply to identify:
1. Key concepts, insights, or knowledge that should be preserved as fragments
2. Connections to existing similar fragments (if any)
3. Relationships between the newly extracted fragments

Output your analysis as valid JSON in this exact format:
{
  "fragments": [
    {
      "title": "Brief descriptive title",
      "content": "The key insight or concept to preserve",
      "reason": "Why this is worth preserving"
    }
  ],
  "links": [
    {
      "existing_fragment_id": "id_of_existing_fragment_to_link_to",
      "relationship": "How this new content relates to the existing fragment"
    }
  ],
  "internal_links": [
    {
      "from_fragment_index": 0,
      "to_fragment_index": 1,
      "relationship": "How these two extracted fragments relate to each other"
    }
  ]
}

Only extract fragments that contain genuinely useful insights, concepts, or knowledge. Avoid generic statements.
If no fragments should be created, return empty arrays.
Use internal_links to connect related fragments extracted from the same message.`;

        console.log("Calling LLM for fragment extraction...");

        const result = await generateText({
          model: currentModel,
          prompt: extractionPrompt,
        });

        console.log("LLM response:", result.text);

        let extractionPlan;
        try {
          // Try to parse JSON from the response
          const jsonMatch = result.text.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            extractionPlan = JSON.parse(jsonMatch[0]);
          } else {
            throw new Error("No JSON found in response");
          }
        } catch (parseError) {
          console.error("Failed to parse LLM response as JSON:", parseError);
          return Response.json({
            success: false,
            error: "Failed to parse extraction plan",
            raw_response: result.text
          }, { status: 500 });
        }

        console.log("Parsed extraction plan:", extractionPlan);

        const createdFragments = [];
        const createdLinks = [];

        // Create fragments
        if (extractionPlan.fragments && extractionPlan.fragments.length > 0) {
          for (const fragment of extractionPlan.fragments) {
            try {
              // Create fragment using the fragments API
              const fragmentResponse = await fetch(`${new URL(request.url).origin}/agents/chat/default/create-fragment`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  title: fragment.title,
                  content: fragment.content,
                  source_memo_id: memo_id
                })
              });

              if (fragmentResponse.ok) {
                const fragmentResult = await fragmentResponse.json();
                createdFragments.push({
                  ...fragment,
                  id: fragmentResult.id
                });
                console.log("Created fragment:", fragment.title);
              }
            } catch (error) {
              console.error("Error creating fragment:", error);
            }
          }
        }

        // Create internal links between newly created fragments
        if (extractionPlan.internal_links && extractionPlan.internal_links.length > 0 && createdFragments.length > 1) {
          for (const internalLink of extractionPlan.internal_links) {
            try {
              const fromFragment = createdFragments[internalLink.from_fragment_index];
              const toFragment = createdFragments[internalLink.to_fragment_index];

              if (fromFragment && toFragment) {
                // Create bidirectional links between fragments
                const linkResponse = await fetch(`${new URL(request.url).origin}/agents/chat/default/link-fragments`, {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                  },
                  body: JSON.stringify({
                    from_memo_id: fromFragment.id,
                    to_fragment_id: toFragment.id,
                    relationship: internalLink.relationship
                  })
                });

                if (linkResponse.ok) {
                  createdLinks.push({
                    from: fromFragment.id,
                    to: toFragment.id,
                    relationship: internalLink.relationship
                  });
                  console.log("Created internal link:", fromFragment.id, "->", toFragment.id);
                }
              }
            } catch (error) {
              console.error("Error creating internal fragment link:", error);
            }
          }
        }

        // Create links to existing fragments
        if (extractionPlan.links && extractionPlan.links.length > 0) {
          for (const link of extractionPlan.links) {
            try {
              // Create link using the fragments API
              const linkResponse = await fetch(`${new URL(request.url).origin}/agents/chat/default/link-fragments`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  from_memo_id: memo_id,
                  to_fragment_id: link.existing_fragment_id,
                  relationship: link.relationship
                })
              });

              if (linkResponse.ok) {
                createdLinks.push(link);
                console.log("Created link to fragment:", link.existing_fragment_id);
              }
            } catch (error) {
              console.error("Error creating fragment link:", error);
            }
          }
        }

        return Response.json({
          success: true,
          message: "Fragment extraction completed",
          created_fragments: createdFragments.length,
          created_links: createdLinks.length,
          created_internal_links: extractionPlan.internal_links ? extractionPlan.internal_links.length : 0,
          extraction_plan: extractionPlan
        });

      } catch (error) {
        console.error("Error in fragment extraction:", error);
        return Response.json({
          success: false,
          error: error instanceof Error ? error.message : "Internal server error"
        }, { status: 500 });
      }
    }

    // Handle generate thread summary endpoint
    if (url.pathname.endsWith("/generate-thread-summary") && request.method === "POST") {
      try {
        const data = await request.json() as {
          thread_slug: string;
          conversation_context: string;
          total_replies: number;
        };
        const { thread_slug, conversation_context, total_replies } = data;

        if (!thread_slug || !conversation_context) {
          return new Response("Missing required fields", { status: 400 });
        }

        console.log("Starting thread summary generation for:", thread_slug);
        console.log("Conversation context length:", conversation_context.length);
        console.log("Total replies:", total_replies);

        const summaryPrompt = `You are analyzing a conversation thread to create a concise, informative summary for display on a thread listing.

Conversation Content:
${conversation_context}

Thread Statistics:
- Total messages: ${total_replies}
- Root thread slug: ${thread_slug}

Please create a brief summary (1-2 sentences, max 150 characters) that captures:
1. The main topic or theme of the conversation
2. Key insights or conclusions reached
3. The general tone or type of discussion

The summary should help users quickly understand what this thread is about without reading the full conversation.

Return only the summary text, no additional formatting or explanation.`;

        console.log("Calling LLM for thread summary...");

        const result = await generateText({
          model: currentModel,
          prompt: summaryPrompt,
        });

        const summary = result.text.trim();
        console.log("Generated summary:", summary);
        console.log("Summary length:", summary.length);

        // Update the root memo with the summary
        const now = new Date().toISOString();

        console.log("Updating memo with slug:", thread_slug);
        const updateResult = await this.sql`
          UPDATE memos
          SET
            summary = ${summary},
            modified = ${now}
          WHERE slug = ${thread_slug} AND parent_id IS NULL
        `;

        console.log("Update result:", updateResult);
        console.log("Rows affected:", updateResult.changes || 'unknown');
        console.log("Thread summary updated for:", thread_slug);

        // Verify the update worked
        const verifyResult = await this.sql`
          SELECT slug, summary FROM memos WHERE slug = ${thread_slug} AND parent_id IS NULL
        `;
        console.log("Verification query result:", verifyResult);

        return Response.json({
          success: true,
          message: "Thread summary generated successfully",
          summary: summary
        });

      } catch (error) {
        console.error("Error in thread summary generation:", error);
        return Response.json({
          success: false,
          error: error instanceof Error ? error.message : "Internal server error"
        }, { status: 500 });
      }
    }

    // Handle find related content endpoint
    if (url.pathname.endsWith("/find-related-content") && request.method === "POST") {
      try {
        const data = await request.json() as {
          memo_id: string;
          content: string;
        };
        const { memo_id, content } = data;

        if (!memo_id || !content) {
          return new Response("Missing required fields", { status: 400 });
        }

        console.log("Finding related content for memo:", memo_id);

        let relatedMemos = [];
        let relatedFragments = [];

        try {
          // Generate embeddings for the content
          const embedding = await this.env.AI.run("@cf/baai/bge-base-en-v1.5", {
            text: content
          });

          // Search for similar memos
          const memoVectorResults = await this.env.VECTORIZE.query(embedding.data[0], {
            topK: 10,
            returnMetadata: true
          });

          const similarMemoIds = memoVectorResults.matches
            .filter((match: any) => match.score > 0.7 && match.metadata?.memo_id !== memo_id)
            .map((match: any) => ({
              memo_id: match.metadata?.memo_id,
              similarity: match.score
            }));

          // Fetch memo details for similar memos
          if (similarMemoIds.length > 0) {
            for (const { memo_id: similarMemoId, similarity } of similarMemoIds) {
              const memoResults = await this.sql`
                SELECT id, slug, content, author, created, modified, parent_id, summary
                FROM memos
                WHERE id = ${similarMemoId}
              `;

              if (memoResults.length > 0) {
                relatedMemos.push({
                  ...memoResults[0],
                  similarity
                });
              }
            }
          }

          // Search for similar fragments
          const fragmentVectorResults = await this.env.VECTORIZE.query(embedding.data[0], {
            topK: 5,
            returnMetadata: true
          });

          const similarFragmentIds = fragmentVectorResults.matches
            .filter((match: any) => match.score > 0.7 && match.metadata?.type === 'fragment')
            .map((match: any) => ({
              fragment_id: match.id,
              similarity: match.score,
              content: match.metadata?.content || ''
            }));

          relatedFragments = similarFragmentIds.slice(0, 5);

        } catch (vectorError) {
          if (!(vectorError instanceof Error && vectorError.message.includes('Authentication error'))) {
            console.error('Error in vector similarity search for related content:', vectorError);
          } else {
            console.log('Vector search unavailable in development mode for related content');
          }
          // Continue with empty results if vector search fails
        }

        console.log(`Found ${relatedMemos.length} related memos and ${relatedFragments.length} related fragments`);

        return Response.json({
          success: true,
          memos: relatedMemos,
          fragments: relatedFragments
        });

      } catch (error) {
        console.error("Error finding related content:", error);
        return Response.json({
          success: false,
          error: error instanceof Error ? error.message : "Internal server error"
        }, { status: 500 });
      }
    }

    // Handle emoji personas endpoints
    if (url.pathname.endsWith("/emoji-personas") && request.method === "GET") {
      try {
        // Initialize emoji personas table
        await this.sql`
          CREATE TABLE IF NOT EXISTS emoji_personas (
            id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
            emoji TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL,
            description TEXT NOT NULL,
            instructions TEXT NOT NULL,
            model_preference TEXT,
            created TEXT DEFAULT CURRENT_TIMESTAMP,
            modified TEXT DEFAULT CURRENT_TIMESTAMP
          )
        `;

        const personas = await this.sql`
          SELECT * FROM emoji_personas ORDER BY created ASC
        `;

        return Response.json({ success: true, personas });
      } catch (error) {
        console.error("Error fetching emoji personas:", error);
        return Response.json({ success: false, error: error instanceof Error ? error.message : "Internal server error" }, { status: 500 });
      }
    }

    if (url.pathname.endsWith("/emoji-personas") && request.method === "POST") {
      try {
        const data = await request.json() as {
          emoji: string;
          name: string;
          description: string;
          instructions: string;
          model_preference?: string;
        };
        const { emoji, name, description, instructions, model_preference } = data;

        if (!emoji || !name || !description || !instructions) {
          return new Response("Missing required fields", { status: 400 });
        }

        // Initialize emoji personas table
        await this.sql`
          CREATE TABLE IF NOT EXISTS emoji_personas (
            id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
            emoji TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL,
            description TEXT NOT NULL,
            instructions TEXT NOT NULL,
            model_preference TEXT,
            created TEXT DEFAULT CURRENT_TIMESTAMP,
            modified TEXT DEFAULT CURRENT_TIMESTAMP
          )
        `;

        const now = new Date().toISOString();
        await this.sql`
          INSERT INTO emoji_personas (emoji, name, description, instructions, model_preference, created, modified)
          VALUES (${emoji}, ${name}, ${description}, ${instructions}, ${model_preference || null}, ${now}, ${now})
        `;

        return Response.json({ success: true, message: "Emoji persona created successfully" });
      } catch (error) {
        console.error("Error creating emoji persona:", error);
        return Response.json({ success: false, error: error instanceof Error ? error.message : "Internal server error" }, { status: 500 });
      }
    }

    if (url.pathname.endsWith("/emoji-personas") && request.method === "PUT") {
      try {
        const data = await request.json() as {
          id: string;
          emoji: string;
          name: string;
          description: string;
          instructions: string;
          model_preference?: string;
        };
        const { id, emoji, name, description, instructions, model_preference } = data;

        if (!id || !emoji || !name || !description || !instructions) {
          return new Response("Missing required fields", { status: 400 });
        }

        const now = new Date().toISOString();
        await this.sql`
          UPDATE emoji_personas
          SET emoji = ${emoji}, name = ${name}, description = ${description}, 
              instructions = ${instructions}, model_preference = ${model_preference || null}, modified = ${now}
          WHERE id = ${id}
        `;

        return Response.json({ success: true, message: "Emoji persona updated successfully" });
      } catch (error) {
        console.error("Error updating emoji persona:", error);
        return Response.json({ success: false, error: error instanceof Error ? error.message : "Internal server error" }, { status: 500 });
      }
    }

    if (url.pathname.endsWith("/emoji-personas") && request.method === "DELETE") {
      try {
        const data = await request.json() as { id: string };
        const { id } = data;

        if (!id) {
          return new Response("Missing required fields", { status: 400 });
        }

        await this.sql`
          DELETE FROM emoji_personas WHERE id = ${id}
        `;

        return Response.json({ success: true, message: "Emoji persona deleted successfully" });
      } catch (error) {
        console.error("Error deleting emoji persona:", error);
        return Response.json({ success: false, error: error instanceof Error ? error.message : "Internal server error" }, { status: 500 });
      }
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
