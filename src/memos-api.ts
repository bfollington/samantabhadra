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
}

interface CreateMemoData {
  slug: string;
  content: string;
  headers?: string;
}

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
        modified TEXT NOT NULL
      )
    `;

    // Create an index on the slug for faster lookups
    await agent.sql`
      CREATE INDEX IF NOT EXISTS idx_memos_slug ON memos(slug)
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

    // Create the new memo
    await agent.sql`
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

    await agent.sql`
      UPDATE memos
      SET
        content = ${memoData.content},
        headers = ${headers},
        links = ${links},
        modified = ${now}
      WHERE id = ${memoData.id}
    `;

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
  } else if (url.pathname.includes('delete-memo')) {
    return deleteMemo(agent, request);
  } else if (url.pathname.includes('realtime-token')) {
    return createRealtimeSession(agent, request);
  }

  // Not a memos API request
  return null;
}
