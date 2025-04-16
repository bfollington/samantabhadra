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
When creating or editing memos, any text in the format [[slug]] will be automatically detected as a backlink to another memo.
You can create, edit, search, delete, and list memos using the memo tools. You can also find all memos that link to a specific memo using the findBacklinks tool.
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
   * Initializes the memos table if it doesn't already exist
   */
  async initMemosTable() {
    try {
      // Create the memos table if it doesn't exist
      await this.sql`
        CREATE TABLE IF NOT EXISTS memos (
          id TEXT PRIMARY KEY,
          slug TEXT UNIQUE NOT NULL,
          content TEXT NOT NULL,
          headers TEXT NOT NULL,
          links TEXT NOT NULL,
          created TEXT NOT NULL,
          modified TEXT NOT NULL
        )
      `;

      // Create an index on the slug for faster lookups
      await this.sql`
        CREATE INDEX IF NOT EXISTS idx_memos_slug ON memos(slug)
      `;

      return true;
    } catch (error) {
      console.error("Error initializing memos table:", error);
      return false;
    }
  }

  /**
   * Handles API requests for memos
   */
  async handleMemosApi(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    const pathParts = url.pathname.split('/');
    console.log('routing', pathParts)

    // Ensure the memos table exists
    await this.initMemosTable();

    // Check which memo API we're handling
    if (url.pathname.includes('list-memos')) {
      // Handle GET request to list all memos
      try {
        // Parse query parameters for pagination and sorting
        const params = new URLSearchParams(url.search);
        const limit = parseInt(params.get('limit') || '50', 10);
        const sortBy = params.get('sortBy') || 'modified';
        const sortOrder = params.get('sortOrder') || 'desc';

        // Execute the query using template literals for SQL
        let memos;
        if (sortBy === 'created') {
          if (sortOrder === 'asc') {
            memos = await this.sql`SELECT * FROM memos ORDER BY created ASC LIMIT ${limit}`;
          } else {
            memos = await this.sql`SELECT * FROM memos ORDER BY created DESC LIMIT ${limit}`;
          }
        } else if (sortBy === 'slug') {
          if (sortOrder === 'asc') {
            memos = await this.sql`SELECT * FROM memos ORDER BY slug ASC LIMIT ${limit}`;
          } else {
            memos = await this.sql`SELECT * FROM memos ORDER BY slug DESC LIMIT ${limit}`;
          }
        } else {
          // Default to 'modified'
          if (sortOrder === 'asc') {
            memos = await this.sql`SELECT * FROM memos ORDER BY modified ASC LIMIT ${limit}`;
          } else {
            memos = await this.sql`SELECT * FROM memos ORDER BY modified DESC LIMIT ${limit}`;
          }
        }

        return Response.json(memos, {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-cache'
          }
        });
      } catch (error: unknown) {
        console.error('Error fetching memos:', error);
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return Response.json(
          { error: 'Failed to retrieve memos', message: errorMessage },
          { status: 500 }
        );
      }
    } else if (url.pathname.includes('list-backlinks')) {
      // Handle GET request to list backlinks for a slug
      try {
        const params = new URLSearchParams(url.search);
        const slug = params.get('slug');

        if (!slug) {
          return Response.json(
            { error: 'Slug parameter is required' },
            { status: 400 }
          );
        }

        // Find backlinks by searching for [[slug]] pattern in content
        const pattern = `%[[${slug}]]%`;
        const backlinks = await this.sql`
          SELECT * FROM memos
          WHERE content LIKE ${pattern}
          ORDER BY modified DESC
        `;

        return Response.json(backlinks, {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-cache'
          }
        });
      } catch (error: unknown) {
        console.error('Error fetching backlinks:', error);
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return Response.json(
          { error: 'Failed to retrieve backlinks', message: errorMessage },
          { status: 500 }
        );
      }
    } else if (url.pathname.includes('create-memo') && request.method === 'POST') {
      // Handle POST request to create a new memo
      try {
        // Define the expected type for memoData
        interface CreateMemoData {
          slug: string;
          content: string;
          headers?: string;
        }

        // Parse and cast request data
        const requestData = await request.json();
        const memoData = requestData as CreateMemoData;

        if (!memoData.slug || !memoData.content) {
          return Response.json(
            { error: 'Missing required fields (slug, content)' },
            { status: 400 }
          );
        }

        // Check if a memo with this slug already exists
        const existingMemo = await this.sql`SELECT COUNT(*) as count FROM memos WHERE slug = ${memoData.slug}`;
        const count = existingMemo[0]?.count;
        if (count && typeof count === 'number' && count > 0) {
          return Response.json(
            { error: `A memo with slug '${memoData.slug}' already exists` },
            { status: 409 }
          );
        }

        // Generate a unique ID and set timestamps
        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        const headers = memoData.headers || JSON.stringify({});
        
        // Initialize with empty links structure
        const links = JSON.stringify({ incoming: [], outgoing: [] });

        // Create the new memo
        await this.sql`
          INSERT INTO memos (id, slug, content, headers, links, created, modified)
          VALUES (${id}, ${memoData.slug}, ${memoData.content}, ${headers}, ${links}, ${now}, ${now})
        `;

        // Process backlinks
        // Extract backlinks from content (all [[slug]] occurrences)
        const backlinkPattern = /\[\[(.*?)\]\]/g;
        const matches = memoData.content.match(backlinkPattern) || [];
        const outgoingLinks = [...new Set(matches.map((match: string) => match.slice(2, -2)))];

        if (outgoingLinks.length > 0) {
          // Update this memo's outgoing links
          const outgoingLinksObj = JSON.stringify({ incoming: [], outgoing: outgoingLinks });
          await this.sql`
            UPDATE memos
            SET links = ${outgoingLinksObj}
            WHERE id = ${id}
          `;

          // Update incoming links for each referenced memo
          for (const targetSlug of outgoingLinks) {
            // Check if target memo exists
            const targetExists = await this.sql`SELECT id, links FROM memos WHERE slug = ${targetSlug}`;
            
            if (targetExists.length > 0) {
              const targetId = targetExists[0].id;
              let targetLinks: { incoming: string[], outgoing: string[] };
              
              try {
                const linksStr = targetExists[0].links as string;
                targetLinks = JSON.parse(linksStr);
              } catch {
                targetLinks = { incoming: [], outgoing: [] };
              }
              
              // Add this memo's slug to target's incoming links if not already there
              if (!targetLinks.incoming.includes(memoData.slug)) {
                targetLinks.incoming.push(memoData.slug);
                
                // Update the target memo's links
                const updatedLinksJson = JSON.stringify(targetLinks);
                await this.sql`
                  UPDATE memos
                  SET links = ${updatedLinksJson}
                  WHERE id = ${targetId}
                `;
              }
            }
          }
        }

        // Return the newly created memo
        const created = await this.sql`SELECT * FROM memos WHERE id = ${id}`;
        const createdMemo = created.length > 0 ? created[0] : null;

        return Response.json(createdMemo, {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-cache'
          }
        });
      } catch (error: unknown) {
        console.error('Error creating memo:', error);
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return Response.json(
          { error: 'Failed to create memo', message: errorMessage },
          { status: 500 }
        );
      }
    } else if (url.pathname.includes('edit-memo') && request.method === 'POST') {
      // Handle POST request to edit a memo
      try {
        const memoData = await request.json();

        if (!memoData.id || !memoData.slug || !memoData.content) {
          return Response.json(
            { error: 'Missing required fields (id, slug, content)' },
            { status: 400 }
          );
        }

        // Update the memo in the database
        const now = new Date().toISOString();
        const headers = JSON.stringify(memoData.headers || {});
        const links = JSON.stringify(memoData.links || {});

        await this.sql`
          UPDATE memos
          SET
            content = ${memoData.content},
            headers = ${headers},
            links = ${links},
            modified = ${now}
          WHERE id = ${memoData.id}
        `;

        // Return the updated memo
        const updated = await this.sql`SELECT * FROM memos WHERE id = ${memoData.id}`;
        const updatedMemo = updated.length > 0 ? updated[0] : null;

        return Response.json(updatedMemo, {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-cache'
          }
        });
      } catch (error: unknown) {
        console.error('Error editing memo:', error);
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return Response.json(
          { error: 'Failed to edit memo', message: errorMessage },
          { status: 500 }
        );
      }
    }

    // Not a memos API request we handle
    return null;
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
