/**
 * API handlers for memo functionality
 */
import { create } from "domain";
import type { Chat } from "./server";

interface Memo {
  id: string;
  slug: string;
  content: string;
  headers: string;
  links: string;
  created: string;
  modified: string;
  vector_id?: string;
}

interface EmbeddingResponse {
  data: number[][];
}

interface VectorizeVector {
  id: string;
  values: number[];
  metadata?: Record<string, any>;
}

interface CreateMemoData {
  slug: string;
  content: string;
  headers?: string;
}

// Add this type to represent the Agent context
type AgentEnv = {
  VECTORIZE: {
    upsert: (vectors: VectorizeVector[]) => Promise<any>;
    query: (vector: number[], options: { topK: number; returnMetadata: boolean }) => Promise<any>;
    deleteOne?: (id: string) => Promise<any>;
    delete?: (ids: string[]) => Promise<any>;
  };
  AI: {
    run: (model: string, input: any) => Promise<any>;
  };
};

interface EditMemoData {
  id: string;
  slug: string;
  content: string;
  headers?: string;
  links?: string;
}

/**
 * Initialize the memos table in the database
 */
export async function initMemosTable(agent: Chat): Promise<boolean> {
  try {
    // Create the memos table if it doesn't exist
    await agent.sql`
      CREATE TABLE IF NOT EXISTS memos (
        id TEXT PRIMARY KEY,
        slug TEXT UNIQUE NOT NULL,
        content TEXT NOT NULL,
        headers TEXT NOT NULL,
        links TEXT NOT NULL,
        created TEXT NOT NULL,
        modified TEXT NOT NULL,
        summary TEXT
      )
    `;

    // Check if vector_id column exists, add it if it doesn't
    try {
      // First try to query using vector_id to see if it exists
      await agent.sql`SELECT vector_id FROM memos LIMIT 1`;
      console.log('vector_id column already exists');
    } catch (error) {
      // If error occurs, the column doesn't exist yet, so add it
      console.log('Adding vector_id column to memos table');
      await agent.sql`ALTER TABLE memos ADD COLUMN vector_id TEXT`;
    }

    // Check if parent_id column exists, add it if it doesn't
    try {
      await agent.sql`SELECT parent_id FROM memos LIMIT 1`;
      console.log('parent_id column already exists');
    } catch (error) {
      console.log('Adding parent_id column to memos table');
      await agent.sql`ALTER TABLE memos ADD COLUMN parent_id TEXT`;
    }

    // Check if author column exists, add it if it doesn't
    try {
      await agent.sql`SELECT author FROM memos LIMIT 1`;
      console.log('author column already exists');
    } catch (error) {
      console.log('Adding author column to memos table');
      await agent.sql`ALTER TABLE memos ADD COLUMN author TEXT DEFAULT 'user'`;
    }

    // Ensure the summary column exists
    try {
      await agent.sql`SELECT summary FROM memos LIMIT 1`;
      console.log('summary column already exists');
    } catch (error) {
      console.log('Adding summary column to memos table');
      await agent.sql`ALTER TABLE memos ADD COLUMN summary TEXT`;
    }

    // Create an index on the slug for faster lookups
    await agent.sql`
      CREATE INDEX IF NOT EXISTS idx_memos_slug ON memos(slug)
    `;

    // Create an index on parent_id for thread lookups
    await agent.sql`
      CREATE INDEX IF NOT EXISTS idx_memos_parent ON memos(parent_id)
    `;

    return true;
  } catch (error) {
    console.error("Error initializing memos table:", error);
    return false;
  }
}

/**
 * Get a list of all memos, with optional sorting
 */
export async function listMemos(agent: Chat, request: Request): Promise<Response> {
  try {
    // Parse query parameters for pagination and sorting
    const url = new URL(request.url);
    const params = new URLSearchParams(url.search);
    const limit = parseInt(params.get('limit') || '50', 10);
    const sortBy = params.get('sortBy') || 'modified';
    const sortOrder = params.get('sortOrder') || 'desc';

    // Execute the query using template literals for SQL
    let memos;
    if (sortBy === 'created') {
      if (sortOrder === 'asc') {
        memos = await agent.sql`SELECT * FROM memos ORDER BY created ASC LIMIT ${limit}`;
      } else {
        memos = await agent.sql`SELECT * FROM memos ORDER BY created DESC LIMIT ${limit}`;
      }
    } else if (sortBy === 'slug') {
      if (sortOrder === 'asc') {
        memos = await agent.sql`SELECT * FROM memos ORDER BY slug ASC LIMIT ${limit}`;
      } else {
        memos = await agent.sql`SELECT * FROM memos ORDER BY slug DESC LIMIT ${limit}`;
      }
    } else {
      // Default to 'modified'
      if (sortOrder === 'asc') {
        memos = await agent.sql`SELECT * FROM memos ORDER BY modified ASC LIMIT ${limit}`;
      } else {
        memos = await agent.sql`SELECT * FROM memos ORDER BY modified DESC LIMIT ${limit}`;
      }
    }

    // Fetch reactions for all memos
    const memoIds = memos.map((memo: any) => memo.id);
    let reactions = [];

    if (memoIds.length > 0) {
      try {
        // Create reactions table if it doesn't exist
        await agent.sql`
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
          const memoReactions = await agent.sql`
            SELECT memo_id, emoji, user_id
            FROM reactions
            WHERE memo_id = ${memoId}
          `;
          reactions.push(...memoReactions);
        }
      } catch (error) {
        console.error('Error fetching reactions:', error);
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

    // Add reactions to each memo
    const memosWithReactions = memos.map((memo: any) => ({
      ...memo,
      reactions: reactionsByMemo[memo.id] || {}
    }));

    return Response.json(memosWithReactions, {
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
}

/**
 * Find backlinks for a specific memo
 */
export async function findBacklinks(agent: Chat, request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
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
    const backlinks = await agent.sql`
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
}

/**
 * Get a single memo by slug
 */
export async function getMemo(agent: Chat, request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const params = new URLSearchParams(url.search);
    const slug = params.get('slug');

    if (!slug) {
      return Response.json(
        { error: 'Slug parameter is required' },
        { status: 400 }
      );
    }

    const memo = await agent.sql`SELECT * FROM memos WHERE slug = ${slug}`;

    if (!memo || memo.length === 0) {
      return Response.json(
        { error: `Memo with slug '${slug}' not found` },
        { status: 404 }
      );
    }

    return Response.json(memo[0], {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache'
      }
    });
  } catch (error: unknown) {
    console.error('Error fetching memo:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return Response.json(
      { error: 'Failed to retrieve memo', message: errorMessage },
      { status: 500 }
    );
  }
}

/**
 * Create a new memo
 */
export async function createMemo(agent: Chat, request: Request): Promise<Response> {
  try {
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
    const existingMemo = await agent.sql`SELECT COUNT(*) as count FROM memos WHERE slug = ${memoData.slug}`;
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

    // Properly handle headers - may already be a JSON string
    let headers = "{}";
    if (memoData.headers) {
      headers = typeof memoData.headers === 'string' ? memoData.headers : JSON.stringify(memoData.headers);
    }

    // Initialize with empty links structure
    const links = JSON.stringify({ incoming: [], outgoing: [] });

    // Generate vector embeddings for the content
    let vector_id = null;
    try {
      // Create a vector ID based on the memo ID
      vector_id = `memo-${id}`;

      // Generate embeddings using the Chat class method
      const embeddings = await agent.createEmbeddings(memoData.content);

      // Store the vector embedding
      await agent.storeVectorEmbedding(vector_id, embeddings, {
        memo_id: id,
        slug: memoData.slug
      });
    } catch (error) {
      console.error('Error generating embeddings:', error);
      vector_id = null;
      // Continue even if embedding fails - we'll still create the memo
    }

    // Create the new memo, including the vector_id if available
    if (vector_id) {
      await agent.sql`
        INSERT INTO memos (id, slug, content, headers, links, created, modified, vector_id)
        VALUES (${id}, ${memoData.slug}, ${memoData.content}, ${headers}, ${links}, ${now}, ${now}, ${vector_id})
      `;
    } else {
      await agent.sql`
        INSERT INTO memos (id, slug, content, headers, links, created, modified)
        VALUES (${id}, ${memoData.slug}, ${memoData.content}, ${headers}, ${links}, ${now}, ${now})
      `;
    }

    // Process backlinks
    // Extract backlinks from content (all [[slug]] occurrences)
    const backlinkPattern = /\[\[(.*?)\]\]/g;
    const matches = memoData.content.match(backlinkPattern) || [];
    const outgoingLinks = [...new Set(matches.map((match: string) => match.slice(2, -2)))];

    if (outgoingLinks.length > 0) {
      // Update this memo's outgoing links
      const outgoingLinksObj = JSON.stringify({ incoming: [], outgoing: outgoingLinks });
      await agent.sql`
        UPDATE memos
        SET links = ${outgoingLinksObj}
        WHERE id = ${id}
      `;

      // Update incoming links for each referenced memo
      for (const targetSlug of outgoingLinks) {
        // Check if target memo exists
        const targetExists = await agent.sql`SELECT id, links FROM memos WHERE slug = ${targetSlug}`;

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
            await agent.sql`
              UPDATE memos
              SET links = ${updatedLinksJson}
              WHERE id = ${targetId}
            `;
          }
        }
      }
    }

    // Return the newly created memo
    const created = await agent.sql`SELECT * FROM memos WHERE id = ${id}`;
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
}

/**
 * Edit an existing memo
 */
export async function editMemo(agent: Chat, request: Request): Promise<Response> {
  try {
    const requestData = await request.json();
    const memoData = requestData as EditMemoData;

    if (!memoData.id || !memoData.slug || !memoData.content) {
      return Response.json(
        { error: 'Missing required fields (id, slug, content)' },
        { status: 400 }
      );
    }

    // Get the current memo to check if it exists and get its vector_id if any
    const existingMemo = await agent.sql`SELECT * FROM memos WHERE id = ${memoData.id}`;

    if (!existingMemo || existingMemo.length === 0) {
      return Response.json(
        { error: `Memo with ID '${memoData.id}' not found` },
        { status: 404 }
      );
    }

    // Update the memo in the database
    const now = new Date().toISOString();

    // Properly handle headers - may already be a JSON string
    let headers = "{}";
    if (memoData.headers) {
      headers = typeof memoData.headers === 'string' ? memoData.headers : JSON.stringify(memoData.headers);
    }

    // Handle links similarly
    let links = "{}";
    if (memoData.links) {
      links = typeof memoData.links === 'string' ? memoData.links : JSON.stringify(memoData.links);
    }

    // Generate updated vector embeddings for the content
    // Ensure vector_id is a string
    let vector_id = existingMemo[0].vector_id ? String(existingMemo[0].vector_id) : null;
    try {
      // Use existing vector_id or create a new one if none exists
      if (!vector_id) {
        vector_id = `memo-${memoData.id}`;
      }

      // Generate embeddings using the Chat class method
      const embeddings = await agent.createEmbeddings(memoData.content);

      // Update the vector embedding
      await agent.storeVectorEmbedding(vector_id, embeddings, {
        memo_id: memoData.id,
        slug: memoData.slug
      });
    } catch (error) {
      console.error('Error updating embeddings:', error);
      // Continue even if embedding fails - we'll still update the memo
    }

    // Build SQL query based on whether we have a vector_id or not
    if (vector_id) {
      const vector_id_str = String(vector_id);
      await agent.sql`
        UPDATE memos
        SET
          content = ${memoData.content},
          headers = ${headers},
          links = ${links},
          modified = ${now},
          vector_id = ${vector_id_str}
        WHERE id = ${memoData.id}
      `;
    } else {
      await agent.sql`
        UPDATE memos
        SET
          content = ${memoData.content},
          headers = ${headers},
          links = ${links},
          modified = ${now}
        WHERE id = ${memoData.id}
      `;
    }

    // Return the updated memo
    const updated = await agent.sql`SELECT * FROM memos WHERE id = ${memoData.id}`;
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

/**
 * Delete a memo
 */
export async function deleteMemo(agent: Chat, request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const params = new URLSearchParams(url.search);
    const id = params.get('id');

    if (!id) {
      return Response.json(
        { error: 'ID parameter is required' },
        { status: 400 }
      );
    }

    // First get the memo to ensure it exists
    const memo = await agent.sql`SELECT * FROM memos WHERE id = ${id}`;

    if (!memo || memo.length === 0) {
      return Response.json(
        { error: `Memo with ID '${id}' not found` },
        { status: 404 }
      );
    }

    // If the memo has a vector_id, delete it from Vectorize
    const vectorId = typeof memo[0].vector_id === 'string' ? memo[0].vector_id : String(memo[0].vector_id);
    if (vectorId) {
      try {
        await agent.deleteVectorEmbedding(vectorId);
      } catch (error) {
        console.error(`Error deleting vector embedding for memo ${id}:`, error);
        // Continue with deletion even if vector deletion fails
      }
    }

    // Delete the memo
    await agent.sql`DELETE FROM memos WHERE id = ${id}`;

    return Response.json({ success: true, message: 'Memo deleted successfully' }, {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache'
      }
    });
  } catch (error: unknown) {
    console.error('Error deleting memo:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return Response.json(
      { error: 'Failed to delete memo', message: errorMessage },
      { status: 500 }
    );
  }
}

/**
 * Search for memos by semantic similarity using vector embeddings
 */
export async function searchMemosByVector(agent: Chat, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const params = new URLSearchParams(url.search);
  const query = params.get('query');
  const limit = parseInt(params.get('limit') || '5', 10);

  if (!query) {
    return Response.json(
      { error: 'Query parameter is required' },
      { status: 400 }
    );
  }

  try {
    // Generate embeddings for the search query
    const embeddings = await agent.createEmbeddings(query);

    // Query Vectorize for similar vectors
    const vectorResults = await agent.searchSimilarVectors(embeddings, limit);

    if (!vectorResults || !vectorResults.matches || vectorResults.matches.length === 0) {
      return Response.json({
        count: 0,
        matches: []
      }, {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache'
        }
      });
    }

    // Extract memo IDs from the vector results
    const memoIds = vectorResults.matches
      .filter((match: any) => match.metadata && typeof match.metadata === 'object' && 'memo_id' in match.metadata)
      .map((match: any) => match.metadata && typeof match.metadata === 'object' && 'memo_id' in match.metadata ? match.metadata.memo_id : '');

    if (memoIds.length === 0) {
      return Response.json({
        count: 0,
        matches: []
      }, {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache'
        }
      });
    }

    // Fetch the actual memos
    // Convert the array to a PostgreSQL-compatible format for IN clause
    const memoIdsStr = memoIds.map((id: string) => `'${id}'`).join(',');
    const memos = await agent.sql`
      SELECT * FROM memos
      WHERE id IN (${memoIdsStr})
    `;

    // Create a map of memo id to memo object for quick lookup
    const memoMap: Record<string, any> = {};
    memos.forEach((memo: any) => {
      memoMap[memo.id] = memo;
    });

    // Enhance vector results with memo content
    const enhancedMatches = vectorResults.matches.map((match: any) => {
      const memoId = match.metadata?.memo_id;
      const memo = memoMap[memoId];

      if (memo) {
        return {
          ...match,
          memo: {
            id: memo.id,
            title: memo.title,
            content: memo.content,
            created: memo.created,
            modified: memo.modified,
            is_pinned: memo.is_pinned,
            visibility: memo.visibility
          }
        };
      }

      return match;
    });

    // Return the enhanced results
    return Response.json({
      count: enhancedMatches.length,
      matches: enhancedMatches
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache'
      }
    });
  } catch (error: unknown) {
    console.error('Error in vector search:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return Response.json(
      { error: 'Failed to perform vector search', message: errorMessage },
      { status: 500 }
    );
  }
}

async function createRealtimeSession(agent: Chat, request: Request): Promise<Response> {
  try {
    const response = await fetch(
      "https://api.openai.com/v1/realtime/transcription_sessions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          input_audio_transcription: {
            model: 'gpt-4o-transcribe',
            prompt: undefined,
          },
          turn_detection: {
            type: 'server_vad',
          }
        }),
      },
    );

    const data = await response.json();
    return Response.json(data);
  } catch (error: any) {
    console.error("Token generation error:", error);
    return Response.json(
      { error: 'Failed to generate token', message: error?.message },
      { status: 500 }
    );
  }
}

/**
 * Route handler for memo-related API requests
 */
export async function handleMemosApi(agent: Chat, request: Request): Promise<Response | null> {
  const url = new URL(request.url);

  // Ensure the memos table exists
  await initMemosTable(agent);

  // Route to the appropriate handler based on the URL path
  if (url.pathname.includes('list-memos')) {
    return listMemos(agent, request);
  } else if (url.pathname.includes('find-backlinks')) {
    return findBacklinks(agent, request);
  } else if (url.pathname.includes('get-memo')) {
    return getMemo(agent, request);
  } else if (url.pathname.includes('create-memo') && request.method === 'POST') {
    return createMemo(agent, request);
  } else if (url.pathname.includes('edit-memo') && request.method === 'POST') {
    return editMemo(agent, request);
  } else if (url.pathname.includes('delete-memo') && (request.method === 'DELETE' || request.method === 'GET')) {
    return deleteMemo(agent, request);
  } else if (url.pathname.includes('search-memos-vector')) {
    return searchMemosByVector(agent, request);
  } else if (url.pathname.includes('realtime-token')) {
    return createRealtimeSession(agent, request);
  }

  // Not a memos API request
  return null;
}
