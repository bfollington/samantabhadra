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

const model = openai("gpt-4.1-2025-04-14");
// Cloudflare AI Gateway
// const openai = createOpenAI({
//   apiKey: env.OPENAI_API_KEY,
//   baseURL: env.GATEWAY_BASE_URL,
// });

type Env = {
  Chat: AgentNamespace<Chat>;
  HOST: string;
  OPENAI_API_KEY: string;
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
      const resultMsg = await fragmentTools.createFragment.execute({
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
          const relatedFragBlock =
            lastUser && typeof lastUser.content === "string"
              ? await this.buildContextFromFragments(lastUser.content)
              : "";

          const systemPrompt =
            relatedFragBlock
              ? SYSTEM_PROMPT +
                `\n\n---- Related fragments ----\n${relatedFragBlock}\n--------------------------------\n`
              : SYSTEM_PROMPT;

          const result = streamText({
            model,
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

  /** Build a snippet of up to 3 semantically-related fragments */
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
            `#${i + 1} [[${r.slug}]] – ${r.content.slice(0, 160)}…`
        )
        .join("\n");
    } catch (err) {
      console.warn("context-fragment lookup failed", err);
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

    // GET /agents/chat/<id>/list-fragments?limit=50
    if (url.pathname.endsWith("list-fragments") && request.method === "GET") {
      try {
        const limit = Number(url.searchParams.get("limit") || "50");

        // Ensure fragments table exists (no-op if it already does)
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

        const rows = await this.sql`
          SELECT id, slug, content, speaker, created, modified
          FROM fragments
          ORDER BY modified DESC
          LIMIT ${limit};`;

        return Response.json(rows);
      } catch (err) {
        console.error("Error listing fragments", err);
        return new Response("Error listing fragments", { status: 500 });
      }
    }
    return null;
  }

  async handleMemosApi(request: Request): Promise<Response | null> {
    // Import the memos API handlers
    return handleMemosApi(this, request);
  }

  async onRequest(request: Request): Promise<Response> {
    // First check if this is a fragments API request
    const fragmentsApiResponse = await this.handleFragmentsApi(request);
    if (fragmentsApiResponse) {
      return fragmentsApiResponse;
    }

    // Next check if this is a memos API request
    const memosApiResponse = await this.handleMemosApi(request);
    if (memosApiResponse) {
      return memosApiResponse;
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
