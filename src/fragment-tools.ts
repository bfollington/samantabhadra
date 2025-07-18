/**
 * Fragment ("tok") management tools for the AI chat agent
 * -------------------------------------------------------
 * A first-cut implementation modelled on memo-tools.ts but trimmed down
 * to the absolutely essential operations so we can iterate quickly.
 *
 * Tables
 *  - fragments        (nodes)
 *  - fragment_edges   (directed, labelled edges between fragments)
 *
 * The schema is intentionally generic so we can add new relationship
 * verbs or additional metadata without a database migration.
 */
import { tool } from "ai";
import { z } from "zod";

import { agentContext } from "./server";
import type { Chat } from "./server";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export type Fragment = {
  id: string;
  slug: string;
  content: string;
  speaker?: string | null;
  ts: string; // ISO time of source utterance
  convo_id?: string | null;
  metadata: string; // JSON blob
  vector_id?: string | null;
  created: string; // ISO
  modified: string; // ISO
};

export type FragmentEdge = {
  id: string;
  from_id: string;
  to_id: string;
  rel: string;
  weight: number | null;
  metadata: string; // JSON
  created: string; // ISO
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function generateId() {
  return crypto.randomUUID();
}

/**
 * Ensure both tables exist. This runs on every call (cheap) so callers don't
 * have to remember.
 */
async function initFragmentTables() {
  const agent = agentContext.getStore();
  if (!agent) {
    throw new Error("No agent found");
  }

  // fragments table
  await agent.sql`
    CREATE TABLE IF NOT EXISTS fragments (
      id        TEXT PRIMARY KEY,
      slug      TEXT UNIQUE NOT NULL,
      content   TEXT NOT NULL,
      speaker   TEXT,
      ts        TEXT NOT NULL,
      convo_id  TEXT,
      metadata  TEXT NOT NULL,
      vector_id TEXT,
      created   TEXT NOT NULL,
      modified  TEXT NOT NULL
    )`;

  await agent.sql`CREATE INDEX IF NOT EXISTS idx_fragments_convo  ON fragments(convo_id)`;
  await agent.sql`CREATE INDEX IF NOT EXISTS idx_fragments_vector ON fragments(vector_id)`;

  // fragment_edges table
  await agent.sql`
    CREATE TABLE IF NOT EXISTS fragment_edges (
      id       TEXT PRIMARY KEY,
      from_id  TEXT NOT NULL,
      to_id    TEXT NOT NULL,
      rel      TEXT NOT NULL,
      weight   REAL,
      metadata TEXT NOT NULL,
      created  TEXT NOT NULL
    )`;

  await agent.sql`CREATE INDEX IF NOT EXISTS idx_edges_from ON fragment_edges(from_id)`;
  await agent.sql`CREATE INDEX IF NOT EXISTS idx_edges_to   ON fragment_edges(to_id)`;
  await agent.sql`CREATE INDEX IF NOT EXISTS idx_edges_rel  ON fragment_edges(rel)`;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/**
 * Create a fragment ("tok").
 */
const createFragment = tool({
  description: "Create a fragment (tok) from conversation text",
  parameters: z.object({
    slug: z.string().describe("URL-friendly identifier"),
    content: z.string().describe("Raw text of the fragment"),
    speaker: z.string().optional().describe("'user' | 'assistant' | other"),
    ts: z.string().optional().describe("ISO timestmp of source utterance"),
    convo_id: z.string().optional().describe("Conversation/Transcript id"),
    metadata: z
      .string()
      .optional()
      .describe("Arbitrary JSON with tags, span, etc."),
  }),
  execute: async ({
    slug,
    content,
    speaker = null,
    ts,
    convo_id = null,
    metadata = "{}",
  }) => {
    const agent = agentContext.getStore() as Chat | null;
    if (!agent) {
      throw new Error("No agent found");
    }

    await initFragmentTables();

    // Does slug exist already?
    const existsRes = await agent.sql<{ count: number }>`
      SELECT COUNT(*) as count FROM fragments WHERE slug = ${slug}
    `;
    if (existsRes[0]?.count > 0) {
      return `Error: a fragment with slug '${slug}' already exists.`;
    }

    const id = generateId();
    const nowIso = new Date().toISOString();
    const tsIso = ts ?? nowIso;

    // Insert fragment *without* vector_id for now
    // @ts-ignore
    await agent.sql`
      INSERT INTO fragments (id, slug, content, speaker, ts, convo_id, metadata, created, modified)
      VALUES (${id}, ${slug}, ${content}, ${speaker}, ${tsIso}, ${convo_id}, ${metadata}, ${nowIso}, ${nowIso})
    `;

    // Kick off embeddings + upsert in the background so we don't block the response
    agent.ctx?.waitUntil(
      (async () => {
        try {
          const embeddings = await agent.createEmbeddings(content);
          const vector_id = `fragment-${id}`;
          await agent.storeVectorEmbedding(vector_id, embeddings, {
            fragment_id: id,
            slug,
          });

          // Update the fragment row with the vector_id once done
          // @ts-ignore
          await agent.sql`
            UPDATE fragments SET vector_id = ${vector_id} WHERE id = ${id}
          `;
        } catch (err) {
          console.error("[BG] embedding/upsert failed for fragment", err);
        }
      })()
    );

    return `Fragment created with id ${id} and slug '${slug}'.`;
  },
});

/**
 * Get a single fragment by slug.
 */
const getFragment = tool({
  description: "Fetch one fragment by slug",
  parameters: z.object({
    slug: z.string().describe("URL-friendly identifier of the fragment"),
  }),
  execute: async ({ slug }) => {
    const agent = agentContext.getStore();
    if (!agent) {
      throw new Error("No agent found");
    }
    await initFragmentTables();

    const frags = await agent.sql<Fragment>`
      SELECT * FROM fragments WHERE slug = ${slug} LIMIT 1
    `;

    if (!frags.length) {
      return `No fragment found with slug '${slug}'.`;
    }

    return frags[0];
  },
});

/**
 * Get links to/from a fragment.
 */
const getFragmentLinks = tool({
  description: "List links (incoming/outgoing) of a fragment by slug",
  parameters: z.object({
    slug: z.string().describe("URL-friendly identifier of the fragment"),
  }),
  execute: async ({ slug }) => {
    const agent = agentContext.getStore();
    if (!agent) {
      throw new Error("No agent found");
    }
    await initFragmentTables();

    // First verify the fragment exists
    const frags = await agent.sql<Fragment>`
      SELECT id FROM fragments WHERE slug = ${slug} LIMIT 1
    `;

    if (!frags.length) {
      return `No fragment found with slug '${slug}'.`;
    }

    const fragment_id = frags[0].id;

    // Get outgoing links
    const outgoing = await agent.sql`
      SELECT fe.rel, fe.to_id, f2.slug AS to_slug
      FROM fragment_edges fe
      JOIN fragments f2 ON fe.to_id = f2.id
      WHERE fe.from_id = ${fragment_id}
    `;

    // Get incoming links
    const incoming = await agent.sql`
      SELECT fe.rel, fe.from_id, f2.slug AS from_slug
      FROM fragment_edges fe
      JOIN fragments f2 ON fe.from_id = f2.id
      WHERE fe.to_id = ${fragment_id}
    `;

    return {
      fragment_slug: slug,
      outgoing: outgoing,
      incoming: incoming,
    };
  },
});

/**
 * Create a directed relationship between two fragments.
 */
const linkFragments = tool({
  description: "Link two fragments with a relationship verb (edge)",
  parameters: z.object({
    from_slug: z.string(),
    to_slug: z.string(),
    rel: z
      .string()
      .describe("Relationship verb, e.g. 'example_of', 'abstracts'"),
    weight: z.number().optional(),
    metadata: z.string().optional(),
  }),
  execute: async ({ from_slug, to_slug, rel, weight = 1, metadata = "{}" }) => {
    const agent = agentContext.getStore() as Chat | null;
    if (!agent) {
      throw new Error("No agent found");
    }

    await initFragmentTables();

    // Resolve ids
    const rows = await agent.sql<Pick<Fragment, "id" | "slug">>`
      SELECT id, slug FROM fragments WHERE slug IN (${from_slug}, ${to_slug})
    `;
    const idMap: Record<string, string> = {};
    rows.forEach((r) => (idMap[r.slug] = r.id));

    const from_id = idMap[from_slug];
    const to_id = idMap[to_slug];

    if (!from_id || !to_id) {
      return `Error: unable to find fragment(s) — missing from_slug or to_slug.`;
    }

    const edgeId = generateId();
    const nowIso = new Date().toISOString();

    // @ts-ignore
    await agent.sql`
      INSERT INTO fragment_edges (id, from_id, to_id, rel, weight, metadata, created)
      VALUES (${edgeId}, ${from_id}, ${to_id}, ${rel}, ${weight}, ${metadata}, ${nowIso})
    `;

    return `Linked '${from_slug}' → '${to_slug}' via '${rel}' (edge id ${edgeId}).`;
  },
});

/**
 * List fragments (basic pagination)
 */
const listFragments = tool({
  description: "List fragments (paginated)",
  parameters: z.object({
    limit: z.number().optional().describe("Max rows (default 20)"),
    offset: z.number().optional().describe("Offset for pagination"),
  }),
  execute: async ({ limit = 20, offset = 0 }) => {
    const agent = agentContext.getStore();
    if (!agent) {
      throw new Error("No agent found");
    }
    await initFragmentTables();

    const frags = await agent.sql<Fragment>`
      SELECT * FROM fragments ORDER BY modified DESC LIMIT ${limit} OFFSET ${offset}
    `;
    return frags.length ? frags : "No fragments found.";
  },
});

/**
 * Text search over fragment content (LIKE pattern – fast enough for now).
 */
const searchFragments = tool({
  description: "Search fragments by content (simple LIKE search)",
  parameters: z.object({
    query: z.string(),
    limit: z.number().optional(),
  }),
  execute: async ({ query, limit = 10 }) => {
    const agent = agentContext.getStore();
    if (!agent) {
      throw new Error("No agent found");
    }
    await initFragmentTables();

    const pattern = "%" + query.replace(/[%_]/g, (c) => "\\" + c) + "%";
    const rows = await agent.sql<Fragment>`
      SELECT * FROM fragments WHERE content LIKE ${pattern} ORDER BY modified DESC LIMIT ${limit}
    `;
    return rows.length ? rows : `No fragments match '${query}'.`;
  },
});

/**
 * Semantic similarity search via Vectorize. Re-uses Chat.searchSimilarVectors.
 */
const semanticSearchFragments = tool({
  description: "Semantic search for similar fragments using embedding vectors",
  parameters: z.object({
    query: z.string(),
    top_k: z.number().optional(),
    threshold: z.number().optional(),
  }),
  execute: async ({ query, top_k = 5, threshold = 0 }) => {
    const agent = agentContext.getStore() as Chat | null;
    if (!agent) {
      throw new Error("No agent found");
    }
    await initFragmentTables();

    const queryEmbedding = await agent.createEmbeddings(query);
    const vectorResults = await agent.searchSimilarVectors(
      queryEmbedding,
      top_k,
      threshold
    );

    // If no matches found, return the empty results
    if (!vectorResults?.matches?.length) {
      return vectorResults;
    }

    // Extract fragment IDs from the vector results
    const fragmentIds = vectorResults.matches
      .map((match: any) => match.metadata?.fragment_id)
      .filter(Boolean);

    if (!fragmentIds.length) {
      return vectorResults;
    }

    // Fetch the actual fragment content
    const fragmentContents: Record<string, Fragment> = {};
    for (const fragmentId of fragmentIds) {
      const fragments = await agent.sql<Fragment>`
        SELECT * FROM fragments 
        WHERE id = ${fragmentId} 
        LIMIT 1`;

      if (fragments.length > 0) {
        fragmentContents[fragmentId] = fragments[0];
      }
    }

    // Enhance the vector results with fragment content
    const enhancedMatches = vectorResults.matches.map((match: any) => {
      const fragmentId = match.metadata?.fragment_id;
      const fragment = fragmentContents[fragmentId];

      if (fragment) {
        return {
          ...match,
          fragment: {
            id: fragment.id,
            slug: fragment.slug,
            content: fragment.content,
            speaker: fragment.speaker,
            ts: fragment.ts,
            created: fragment.created,
            modified: fragment.modified,
          },
        };
      }

      return match;
    });

    return {
      ...vectorResults,
      matches: enhancedMatches,
    };
  },
});

// ---------------------------------------------------------------------------
// Export bundle
// ---------------------------------------------------------------------------
export const fragmentTools = {
  createFragment,
  linkFragments,
  listFragments,
  searchFragments,
  semanticSearchFragments,
  getFragment,
  getFragmentLinks,
};
