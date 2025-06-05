# Feature Guide - Samantabhadra

## Working with Fragments

Fragments are atomic units of knowledge extracted from conversations. Think of them as the building blocks of your knowledge graph.

### Creating Fragments

The AI assistant will automatically suggest creating fragments when you discuss specific concepts, facts, or ideas. You can also explicitly ask:

```
"Create a fragment about quantum entanglement"
"Save this as a tok with slug 'react-hooks-rules'"
```

### Fragment Properties
- **Slug**: URL-friendly unique identifier (e.g., `quantum-entanglement`)
- **Content**: The actual text of the knowledge
- **Speaker**: Who said it (user/assistant)
- **Timestamp**: When it was created
- **Metadata**: Additional JSON data like tags or categories

### Linking Fragments

Create semantic relationships between fragments:

```
"Link 'quantum-entanglement' to 'particle-physics' with relationship 'part_of'"
"Connect 'react-hooks' to 'functional-components' as 'requires'"
```

Common relationship types:
- `example_of` - Concrete instance of abstract concept
- `abstracts` - General principle from specific case
- `generalizes_to` - Broader application
- `metaphor_for` - Analogical connection
- `requires` - Dependency relationship
- `contradicts` - Opposing ideas
- `supports` - Supporting evidence

### Searching Fragments

Find fragments using different search methods:

```
"Search fragments about quantum physics"
"Find semantically similar fragments to 'consciousness'"
"List all fragments"
```

## Working with Memos

Memos are longer-form notes that can reference multiple fragments and other memos.

### Creating Memos

```
"Create a memo about my understanding of quantum mechanics"
"Save a memo with slug 'project-architecture' about our system design"
```

### Memo Structure

Memos support headers for metadata:
- **Type**: Category (note, workflow, reference, etc.)
- **Title**: Human-readable title
- **Description**: Brief summary
- **Tags**: Searchable keywords

### Backlinks

Reference other memos or fragments using double brackets:

```
"As discussed in [[quantum-entanglement]], particles can be connected..."
"This builds on [[react-hooks-rules]] and [[functional-components]]..."
```

The UI will render these as clickable links.

### Managing Memos

```
"Edit the memo 'project-architecture'"
"Delete memo 'old-notes'"
"Find all memos that reference 'quantum-physics'"
```

## Using Workflows

Workflows are saved conversation patterns that can be replayed.

### Saving Workflows

After a useful conversation:

```
"Save this conversation as a workflow called 'bug-investigation-process'"
"Create a workflow from the last 5 messages for 'code-review-checklist'"
```

### Executing Workflows

```
"Execute the workflow 'bug-investigation-process'"
"Run 'code-review-checklist' workflow with parameters: {file: 'server.ts'}"
```

### Listing Workflows

```
"Show me all available workflows"
"List workflows"
```

## Semantic Search

The system uses AI embeddings to find conceptually related content.

### Vector Search

```
"Find memos semantically similar to 'consciousness and free will'"
"Search for fragments related to 'distributed systems' using vectors"
```

### Similarity Threshold

Control search precision:

```
"Find highly similar fragments to 'quantum mechanics' with threshold 0.8"
"Broad semantic search for 'philosophy' with threshold 0.3"
```

## Knowledge Graph Navigation

### Viewing the Graph

```
"Show me the fragment graph"
"Display connections for fragment 'quantum-entanglement'"
"What links to 'react-hooks'?"
```

### Graph Queries

```
"Find all fragments connected to 'physics' within 2 hops"
"Show incoming links to 'consciousness'"
"List fragments with more than 5 connections"
```

## Scheduling and Tasks

### One-time Tasks

```
"Schedule a reminder for tomorrow at 3pm to review quantum notes"
"Schedule task for 2024-12-25: Send holiday greetings"
```

### Recurring Tasks

```
"Schedule weekly review every Monday at 9am"
"Create daily standup reminder using cron: 0 9 * * 1-5"
```

### Managing Tasks

```
"List all scheduled tasks"
"Cancel task with ID xyz123"
"Show upcoming tasks"
```

## Model Switching

### Available Models
- **GPT-4o**: OpenAI's latest model (default)
- **Claude 3.5 Sonnet**: Anthropic's latest model

### Switching Models

Via UI: Click the model selector in the header

Via conversation:
```
"Switch to Claude model"
"Use GPT-4o for this conversation"
```

## Advanced Features

### MCP Servers

Connect to Model Context Protocol servers:

```
"Add MCP server https://example.com/mcp"
"List connected MCP servers"
```

### Direct API Access

The system exposes REST endpoints for programmatic access:

```bash
# List fragments
GET /agents/chat/{id}/list-fragments?limit=10&offset=0

# Search memos semantically  
GET /agents/chat/{id}/search-memos-vector?query=quantum+physics

# Get fragment graph
GET /agents/chat/{id}/fragment-graph
```

### Export and Analysis

```
"Export all fragments as JSON"
"Generate a summary of all memos about 'project-x'"
"Analyze connections in the knowledge graph"
```

## Best Practices

1. **Use Descriptive Slugs**: Make them self-explanatory (e.g., `react-useeffect-cleanup` not `note-1`)

2. **Create Atomic Fragments**: One concept per fragment for maximum reusability

3. **Link Liberally**: More connections reveal more insights

4. **Regular Reviews**: Periodically ask "What do I know about X?" to surface connections

5. **Evolve Your Vocabulary**: Develop consistent relationship types for your domain

6. **Combine Search Methods**: Use both text and semantic search for comprehensive results

7. **Workflow Templates**: Save common interaction patterns as workflows

8. **Incremental Building**: Let the graph grow naturally through conversation rather than bulk imports