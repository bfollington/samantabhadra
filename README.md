# 🧘 Samantabhadra - Conversational Knowledge Graph Assistant

A chat-notebook application that builds a growing knowledge graph from your conversations, creating an interconnected web of ideas that resurfaces contextually during discussions.

_The idea is to just chat, sometimes ask to store and search for fragments in plain language and see what resurfaces later_.

## What is Samantabhadra?

Samantabhadra is an AI-powered conversational assistant that:

- **Captures knowledge fragments** ("toks") from conversations as atomic units of information
- **Creates semantic connections** between related concepts using directed, labeled relationships
- **Builds a personal knowledge graph** that grows with every conversation
- **Resurfaces relevant context** using vector embeddings and semantic search
- **Maintains higher-level memos** for broader notes and insights
- **Enables workflow automation** by saving and replaying conversation patterns

Think of it as a chat interface that remembers everything and builds an evolving map of your discussions, making connections you might have missed.

## Key Features

### 🧩 Fragments (Toks)

- Atomic snippets of knowledge extracted from conversations
- Each fragment has a unique slug, content, speaker, timestamp, and metadata
- Fragments can be linked with semantic relationships (e.g., "example_of", "abstracts", "generalizes_to")
- Full-text and semantic similarity search capabilities
- Automatic vector embedding generation for semantic search

### 📝 Memos

- Higher-level notes that can reference multiple fragments
- Support for backlinks using `[[slug]]` syntax
- Headers for metadata (title, description, type)
- Bidirectional link tracking
- Vector embeddings for semantic search

### 🤖 AI Agent

- Powered by OpenAI GPT-4o or Anthropic Claude models
- Streaming responses with real-time updates
- Tool system with human-in-the-loop confirmation for sensitive operations
- Automatic context building from relevant fragments and memos
- System prompt optimized for knowledge graph construction

### 🔧 Workflow System (Ben: this is defunct)

- Save conversation patterns as reusable workflows
- Execute workflows with parameters
- List and manage saved workflows
- Useful for repetitive tasks or complex procedures

### 🔍 Search & Discovery

- Full-text search across fragments and memos
- Semantic similarity search using vector embeddings
- Graph visualization for exploring connections
- API endpoints for programmatic access

### 🌐 REST API

The application exposes several REST API endpoints:

- `/list-fragments` - List all fragments with pagination
- `/fragment?slug=...` - Get a specific fragment by slug
- `/fragment-graph` - Get the entire fragment graph structure
- `/fragment-exists?slug=...` - Check if a fragment exists
- `/list-memos` - List all memos
- `/get-memo?slug=...` - Get a specific memo
- `/search-memos-vector?query=...` - Semantic search for memos
- `/create-memo`, `/edit-memo`, `/delete-memo` - Memo management

## Technology Stack

- **Runtime**: Cloudflare Workers with Durable Objects
- **Database**: SQLite (via Durable Objects)
- **Vector Database**: Cloudflare Vectorize
- **Embeddings**: Cloudflare AI (BGE base model)
- **LLM Providers**: OpenAI GPT-4o, Anthropic Claude
- **Framework**: React with TypeScript
- **UI Components**: Radix UI, Tailwind CSS
- **Build Tools**: Vite, Wrangler
- **Agent Framework**: Cloudflare Agents SDK with Model Context Protocol (MCP)

## Environment Configuration

Create a `.dev.vars` file with the following variables:

```env
# Required - At least one AI provider key
OPENAI_API_KEY=sk-proj-...
ANTHROPIC_API_KEY=sk-ant-...

# Optional - Cloudflare AI Gateway for rate limiting and caching
GATEWAY_BASE_URL=https://gateway.ai.cloudflare.com/v1/...
```

## Setup & Development

1. Install dependencies:

```bash
npm install
```

2. Configure environment variables (see above)

3. Run locally:

```bash
npm start
```

4. Deploy to Cloudflare:

```bash
npm run deploy
```

## Architecture Notes

This is a prototype demonstration focusing on the user experience. The codebase reflects rapid iteration and experimentation:

- **Server**: `src/server.ts` - Main Durable Object handling chat sessions, embeddings, and database operations
- **Tools**: Various tool files (`fragment-tools.ts`, `memo-tools.ts`, `workflow-tools.ts`) define AI capabilities
- **UI**: React components in `src/components/` provide the interface
- **API**: REST endpoints handled directly in the Durable Object's `onRequest` method

The application uses Cloudflare's Durable Objects for persistent state, SQLite for structured data, and Vectorize for semantic search capabilities. The architecture enables real-time collaboration and knowledge graph construction at the edge.

## Core Concepts

### Backlink Syntax

Use `[[slug]]` syntax in chat or memo content to create clickable references to other fragments or memos.

### Knowledge Graph Building

1. Fragments capture atomic facts from conversations
2. Relationships connect related fragments semantically
3. Memos provide higher-level synthesis and notes
4. Vector embeddings enable semantic discovery
5. The graph grows organically through natural conversation

### Working Principles

- Check for existing knowledge before adding duplicates
- Use descriptive relationship verbs when linking fragments
- Keep fragments atomic and memos comprehensive
- Let the system surface relevant context automatically

## License

MIT
