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
import { AsyncLocalStorage } from "node:async_hooks";
import type {
  Tool,
  Prompt,
  Resource,
} from "@modelcontextprotocol/sdk/types.js";
import { handleMemosApi } from './memos-api';
import type { Ai, Vectorize } from "@cloudflare/workers-types/experimental";
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
  async searchSimilarVectors(queryVector: number[], limit: number = 5): Promise<any> {
    try {
      if (!this.env.VECTORIZE) {
        throw new Error('Vectorize service not available');
      }
      
      return await this.env.VECTORIZE.query(queryVector, {
        topK: limit,
        returnMetadata: true
      });
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
          const processedMessages = await processToolCalls({
            messages: this.messages,
            dataStream,
            tools,
            executions,
          });

          // Stream the AI response using GPT-4
          const result = streamText({
            model,
            system: `You are a helpful assistant that can do various tasks...

You can also manage memos for the user. Memos are notes with a unique slug, content, headers (as JSON), and links (as JSON).

## Notebook with Backlinks

The notebook feature uses a special [[backlink]] syntax for referencing other memos. When you write [[slug]] in your message or in a memo, it creates a clickable link to the memo with that slug.

Examples:
- If you mention [[todo]] in a message, it will become a clickable link to the "todo" memo
- You can reference multiple memos like [[meeting-notes]] and [[project-ideas]] in the same message
- Backlinks create a network of connected notes that users can navigate through

You are encouraged to use this [[backlink]] syntax in your responses when referring to existing memos. When referencing memos in your messages, always use the [[slug]] format to create clickable links.

You can create, edit, search, delete, and list memos using the memo tools. You can also find all memos that link to a specific memo using the findBacklinks tool.

## Workflows

Workflows are special memos that contain instructions for completing specific tasks or processes. They can be created, listed, and executed using the workflow tools.

As an assistant, you can:
- List available workflows with listWorkflows
- Execute a workflow with executeWorkflow
- Save the current conversation as a workflow with saveWorkflow

When saving a workflow, abstract the general pattern of the conversation without the specific details or answers given.

Workflows are powerful for automating repetitive tasks and creating reusable processes. When executing a workflow, carefully follow the instructions and use appropriate tools to accomplish each step.
`,
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

  /**
   * Handles API requests for memos
   */
  async handleMemosApi(request: Request): Promise<Response | null> {
    // Import the memos API handlers
    return handleMemosApi(this, request);
  }

  async onRequest(request: Request): Promise<Response> {
    // First check if this is a memos API request
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
