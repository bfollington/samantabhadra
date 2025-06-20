# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Common Development Commands

### Build and Deploy

```bash
# Install dependencies
npm install

# Run locally with hot reload (port 5173)
npm start

# Build and deploy to Cloudflare
npm run deploy

# Run tests
npm test

# Type check and lint
npm run check
```

### Environment Setup

1. Create `.dev.vars` file with API keys (at least one required):

   ```
   OPENAI_API_KEY=sk-proj-...
   ANTHROPIC_API_KEY=sk-ant-...
   GATEWAY_BASE_URL=https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}  # optional
   ```

2. Cloudflare services are auto-created on deploy, but for manual setup:
   ```bash
   wrangler vectorize create embeddings-index --dimensions=768 --metric=cosine
   ```

## High-Level Architecture

### Core Stack

- **Runtime**: Cloudflare Workers with Durable Objects for persistent state
- **Database**: SQLite (via Durable Objects) + Cloudflare Vectorize for vector search
- **AI Models**: OpenAI GPT-4o, Anthropic Claude via official SDKs
- **Frontend**: React + TypeScript, Radix UI, Tailwind CSS
- **Agent Framework**: Cloudflare Agents SDK with Model Context Protocol (MCP)

### Key Components

1. **Chat Class** (`src/server.ts`): Main Durable Object handling:

   - AI chat streaming with tool execution
   - SQLite database operations for fragments and memos
   - Vector embeddings generation and search
   - REST API routing
   - MCP server connections

2. **Data Models**:

   - **Fragments**: Atomic knowledge units with semantic relationships
   - **Memos**: Longer notes with backlink support (`[[slug]]` syntax)
   - **Threads**: Conversation threading with parent-child relationships
   - **Reactions**: Emoji reactions on memos

3. **AI Tools** (Human-in-the-loop confirmation for sensitive operations):

   - Fragment tools: create, link, search
   - Memo tools: CRUD operations
   - Custom tools: weather, scheduling, etc.

4. **Frontend** (`src/app.tsx`):
   - Real-time chat interface with streaming
   - Panels: Memos, Fragments, Threads, Graph visualization
   - Markdown rendering with backlink support

### API Patterns

- All endpoints handled in Chat class's `onRequest` method
- Streaming responses for AI chat via Server-Sent Events
- RESTful endpoints for data operations
- WebSocket support for real-time features

### Database Schema

```sql
-- Fragments: atomic knowledge units
CREATE TABLE fragments (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE,
  content TEXT,
  speaker TEXT,
  metadata TEXT,
  vector_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Fragment relationships
CREATE TABLE fragment_edges (
  from_id TEXT,
  to_id TEXT,
  rel TEXT,
  PRIMARY KEY (from_id, to_id, rel)
);

-- Memos: longer notes
CREATE TABLE memos (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE,
  content TEXT,
  parent_id TEXT,
  author TEXT,
  summary TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Reactions on memos
CREATE TABLE memo_reactions (
  memo_id TEXT,
  user_id TEXT,
  reaction TEXT,
  PRIMARY KEY (memo_id, user_id, reaction)
);
```

### Relationship Types

- `example_of`: Concrete instance
- `abstracts`: General from specific
- `generalizes_to`: Broader application
- `metaphor_for`: Analogical connection
- `requires`: Dependencies
- `contradicts`: Opposing ideas
- `supports`: Supporting evidence

### Development Notes

- This is a prototype focused on UX, reflecting rapid iteration
- Single-user system (no auth)
- Lazy embedding generation for performance
- SQLite limitations per Durable Object
- No formal migration system for schema changes

### Testing Approach

- Framework: Vitest with Cloudflare Workers pool
- Test files in `/tests/` directory
- Minimal test coverage currently
- Run individual tests with: `npm test -- path/to/test`

### Cloudflare Configuration

- Main config: `wrangler.jsonc`
- Bindings for AI, Vectorize, and Durable Objects
- Compatibility date and flags set for latest features
- Observability enabled for debugging

### Code Patterns

1. **Tool Definition**: Auto-executing tools have `execute` function, confirmation-required tools use separate executions object
2. **Async Operations**: Heavy use of async/await for AI and database operations
3. **Error Handling**: Try-catch blocks around AI calls and database operations
4. **State Management**: Maintained in Chat class including messages, model selection, MCP servers
