# Technical Documentation - Samantabhadra

## Architecture Overview

Samantabhadra is built on Cloudflare Workers using Durable Objects for persistent state management. The application follows a distributed edge architecture with the following components:

### Core Components

1. **Durable Object (Chat class)** - The main stateful component that handles:

   - Chat session management
   - SQLite database operations
   - Vector embedding creation and search
   - API request routing
   - Tool execution context

2. **Vector Database (Cloudflare Vectorize)** - Handles:

   - Semantic similarity search
   - Embedding storage with metadata
   - Fast nearest-neighbor queries

3. **AI Services**:
   - **LLM**: OpenAI GPT-4o or Anthropic Claude for conversation
   - **Embeddings**: Cloudflare AI BGE model for vector generation

## Database Schema

### Fragments Table

```sql
CREATE TABLE fragments (
  id        TEXT PRIMARY KEY,
  slug      TEXT UNIQUE NOT NULL,
  content   TEXT NOT NULL,
  speaker   TEXT,
  ts        TEXT NOT NULL,
  convo_id  TEXT,
  metadata  TEXT NOT NULL,  -- JSON blob
  vector_id TEXT,
  created   TEXT NOT NULL,
  modified  TEXT NOT NULL
);
```

### Fragment Edges Table

```sql
CREATE TABLE fragment_edges (
  id       TEXT PRIMARY KEY,
  from_id  TEXT NOT NULL,
  to_id    TEXT NOT NULL,
  rel      TEXT NOT NULL,   -- Relationship type
  weight   REAL,
  metadata TEXT NOT NULL,   -- JSON blob
  created  TEXT NOT NULL
);
```

### Memos Table

```sql
CREATE TABLE memos (
  id       TEXT PRIMARY KEY,
  slug     TEXT UNIQUE NOT NULL,
  content  TEXT NOT NULL,
  headers  TEXT NOT NULL,   -- JSON blob
  links    TEXT NOT NULL,   -- JSON blob tracking backlinks
  created  TEXT NOT NULL,
  modified TEXT NOT NULL
);
```

## Key Implementation Details

### Vector Embedding Pipeline

1. **Creation Flow**:

   - Content is sent to Cloudflare AI BGE model
   - Returns 768-dimensional embedding vector
   - Stored in Vectorize with metadata linking to source

2. **Search Flow**:
   - Query text is embedded using same model
   - Vectorize performs cosine similarity search
   - Results include similarity scores and metadata

### Backlink System

The backlink system uses a two-phase approach:

1. **Extraction**: Regex pattern `\[\[([\w-]+)\]\]` finds references
2. **Resolution**: Links are tracked bidirectionally in the database

### Tool System

Tools follow two patterns:

1. **Auto-executing**: Include `execute` function

```typescript
tool({
  description: "...",
  parameters: z.object({...}),
  execute: async (params) => { /* runs immediately */ }
})
```

2. **Confirmation Required**: No `execute` function

```typescript
tool({
  description: "...",
  parameters: z.object({...})
  // Implementation in executions object
})
```

### API Routing

The Durable Object's `onRequest` method handles all HTTP requests:

- Fragment API endpoints (`/list-fragments`, `/fragment-graph`, etc.)
- Memo API endpoints (`/list-memos`, `/search-memos-vector`, etc.)
- Chat WebSocket upgrade for streaming
- Model selection and configuration

### State Management

The Chat class maintains state including:

- `messages`: Full conversation history
- `state.servers`: MCP server connections
- `state.currentModelName`: Active AI model
- `processedUserMessageIds`: Deduplication tracking
- `autoFragmentSlugs`: Auto-generated fragment tracking

## Performance Considerations

1. **Lazy Embedding Generation**: Embeddings are created asynchronously after fragment/memo creation
2. **Pagination**: All list endpoints support limit/offset for large datasets
3. **Index Strategy**: Strategic indexes on frequently queried columns
4. **Vector Search Limits**: Configurable top-K and similarity thresholds

## Security Notes

- API keys are stored as environment variables, never in code
- No authentication system currently implemented (prototype stage)
- All data is scoped to individual Durable Object instances
- CORS headers configured for local development

## Known Limitations

1. **Scale**: Each Durable Object instance has SQLite size limits
2. **Vector Index**: Vectorize has limits on index size and query rate
3. **No Migration System**: Schema changes require manual intervention
4. **Single User**: No multi-user or access control implementation
5. **No Backup**: Data persistence relies entirely on Cloudflare's infrastructure

## Development Workflow

1. **Local Development**: Uses Wrangler's local Durable Object simulation
2. **Hot Reload**: Vite provides HMR for frontend changes
3. **Type Safety**: Full TypeScript coverage with strict mode
4. **Testing**: Vitest configured but minimal test coverage

## Future Architecture Considerations

- Implement proper authentication and multi-tenancy
- Add data export/import capabilities
- Create migration system for schema evolution
- Implement fragment/memo versioning
- Add collaborative features with CRDT or OT
- Integrate more LLM providers and embedding models
- Build proper observability and monitoring
