# Configuration Guide - Samantabhadra

## Environment Variables

Use `.dev.vars` for local development.

### Required Variables

At least one AI provider API key must be configured:

```env
# OpenAI API Key (for GPT-4o model)
OPENAI_API_KEY=sk-proj-...

# Anthropic API Key (for Claude model)
ANTHROPIC_API_KEY=sk-ant-...
```

### Optional Variables

```env
# Cloudflare AI Gateway URL (for rate limiting and caching)
GATEWAY_BASE_URL=https://gateway.ai.cloudflare.com/v1/...
```

## Cloudflare Configuration

### wrangler.jsonc

The project uses the following Cloudflare services configured in `wrangler.jsonc`:

```jsonc
{
  "name": "samantabhadra",
  "main": "src/server.ts",
  "compatibility_date": "2025-02-04",
  "compatibility_flags": [
    "nodejs_compat",
    "nodejs_compat_populate_process_env",
  ],
  "vars": {
    "HOST": "https://samantabhadra.bfollington.workers.dev/",
  },
  "vectorize": [
    {
      "binding": "VECTORIZE",
      "index_name": "embeddings-index",
    },
  ],
  "ai": {
    "binding": "AI",
  },
  "durable_objects": {
    "bindings": [
      {
        "name": "Chat",
        "class_name": "Chat",
      },
    ],
  },
}
```

### Required Cloudflare Services

1. **Vectorize**: Create an index named `embeddings-index` in your Cloudflare dashboard
2. **Workers AI**: Enabled automatically with the AI binding
3. **Durable Objects**: Enabled with SQLite storage

## Initial Setup

Note: these should be crearted automatically when deploying to CF. You can create them manually if you desire.

### 1. Create Vectorize Index

```bash
# Using wrangler CLI
wrangler vectorize create embeddings-index --dimensions=768 --metric=cosine
```

### 2. Set Environment Variables

For local development:

```bash
# Create .dev.vars file
cp .dev.vars.example .dev.vars
# Edit .dev.vars with your API keys
```

For production:

```bash
# Set secrets using wrangler
wrangler secret put OPENAI_API_KEY
wrangler secret put ANTHROPIC_API_KEY
```

### 3. Database Initialization

The database tables are created automatically on first use. No manual initialization required.

## Model Configuration

### Switching AI Models

The application supports switching between OpenAI and Anthropic models via the UI or API:

```bash
# Via API
curl -X POST https://your-worker.workers.dev/agents/chat/your-id/set-model \
  -H "Content-Type: application/json" \
  -d '{"modelName": "gpt-4o-2024-11-20"}'

# or
curl -X POST https://your-worker.workers.dev/agents/chat/your-id/set-model \
  -H "Content-Type: application/json" \
  -d '{"modelName": "claude-3-5-sonnet-20241022"}'
```

### Available Models

- **OpenAI**: `gpt-4o-2024-11-20`
- **Anthropic**: `claude-3-5-sonnet-20241022`

## Deployment Configuration

### Development

```bash
# Install dependencies
npm install

# Run locally with hot reload
npm start

# Access at http://localhost:5173
```

### Production

```bash
# Build and deploy
npm run deploy

# Or separately
npm run build
wrangler deploy
```

### Custom Domain

To use a custom domain:

1. Add domain to Cloudflare
2. Create Worker route in dashboard
3. Update `HOST` variable in `wrangler.jsonc`

## Advanced Configuration

### Vectorize Index Settings

The default configuration uses:

- **Dimensions**: 768 (BGE model output)
- **Metric**: Cosine similarity
- **Namespace**: Default

To customize, create a new index with different parameters:

```bash
wrangler vectorize create custom-index --dimensions=1536 --metric=euclidean
```

Then update `wrangler.jsonc`:

```jsonc
"vectorize": [
  {
    "binding": "VECTORIZE",
    "index_name": "custom-index"
  }
]
```

### AI Gateway Configuration

To use Cloudflare AI Gateway for caching and rate limiting:

1. Create an AI Gateway in Cloudflare dashboard
2. Copy the gateway URL
3. Set `GATEWAY_BASE_URL` in environment variables
4. Uncomment gateway configuration in `server.ts`

### Memory and Performance Tuning

Durable Objects have the following limits:

- **Memory**: 128MB per instance
- **CPU**: 30 seconds per request
- **Storage**: 10GB SQLite per DO

For large knowledge graphs, consider:

- Implementing data archival strategies
- Using multiple DO instances with sharding
- Optimizing vector search with pre-filtering

## Troubleshooting

### Common Issues

1. **"No agent found" errors**: Ensure Durable Object namespace is properly configured
2. **Vector search failures**: Check Vectorize index exists and dimensions match
3. **API key errors**: Verify environment variables are set correctly
4. **CORS issues**: Check `HOST` variable matches your deployment URL

### Debug Mode

Enable verbose logging by setting:

```javascript
// In server.ts
const DEBUG = true;
```

This will log:

- SQL queries
- Vector operations
- API calls
- Tool executions
