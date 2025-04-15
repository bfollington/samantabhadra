/**
 * Memo management tools for the AI chat agent
 * Includes tools for creating, editing, searching, and deleting memos
 */
import { tool } from "ai";
import { z } from "zod";

import { agentContext } from "./server";

// Define memo schema
export type Memo = {
  id: string;
  slug: string;
  content: string;
  headers: string; // JSON string for headers
  links: string;   // JSON string for links
  created: string; // ISO datetime string
  modified: string; // ISO datetime string
};

/**
 * Initializes the memos database table if it doesn't exist
 */
async function initMemosTable() {
  const agent = agentContext.getStore();
  if (!agent) {
    throw new Error("No agent found");
  }

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
    throw error;
  }
}

/**
 * Generate a unique ID for a memo
 */
function generateMemoId() {
  return crypto.randomUUID();
}

/**
 * Extract backlinks from memo content
 * Finds all occurrences of [[slug]] pattern and returns unique slugs
 */
function extractBacklinks(content: string): string[] {
  const backlinksRegex = /\[\[(.*?)\]\]/g;
  const matches = content.match(backlinksRegex) || [];
  
  // Extract unique slugs from the matches
  const links = matches
    .map(match => match.slice(2, -2).trim()) // Remove [[ and ]]
    .filter((slug, index, self) => slug && self.indexOf(slug) === index); // Unique non-empty slugs
  
  return links;
}

/**
 * Update backlinks in the database
 * This function manages the links column for memos
 */
async function updateBacklinks(agent: any, slug: string, content: string) {
  // Extract backlinks from the content
  const backlinks = extractBacklinks(content);
  
  // Get the current memo's links first to preserve any incoming links
  const currentLinks = await agent.sql<{ links: string }>`
    SELECT links FROM memos WHERE slug = ${slug}
  `;
  
  let linksObj = { incoming: [], outgoing: backlinks };
  
  // If the memo already has links, preserve its incoming links
  if (currentLinks && currentLinks.length > 0) {
    try {
      const existingLinks = JSON.parse(currentLinks[0]?.links || '{}');
      linksObj.incoming = existingLinks.incoming || [];
    } catch (e) {
      // If parsing fails, use the default empty array
    }
  }
  
  // Update the current memo's links
  await agent.sql`
    UPDATE memos
    SET links = ${JSON.stringify(linksObj)}
    WHERE slug = ${slug}
  `;
  
  // For each extracted backlink, update the target memo's incoming links
  for (const targetSlug of backlinks) {
    // Check if the target memo exists
    const targetExists = await agent.sql<{ count: number }>`
      SELECT COUNT(*) as count FROM memos WHERE slug = ${targetSlug}
    `;
    
    if (targetExists[0]?.count > 0) {
      // Get the current links of the target memo
      const targetLinks = await agent.sql<{ links: string }>`
        SELECT links FROM memos WHERE slug = ${targetSlug}
      `;
      
      let linksObj = { incoming: [], outgoing: [] };
      try {
        linksObj = JSON.parse(targetLinks[0]?.links || '{}');
      } catch (e) {
        // If links is not valid JSON, initialize it
      }
      
      // Make sure the incoming array exists
      if (!linksObj.incoming) {
        linksObj.incoming = [];
      }
      
      // Add the current slug to incoming links if not already there
      if (!linksObj.incoming.includes(slug)) {
        linksObj.incoming.push(slug);
        
        // Update the target memo's links
        await agent.sql`
          UPDATE memos
          SET links = ${JSON.stringify(linksObj)}
          WHERE slug = ${targetSlug}
        `;
      }
    }
  }
  
  return backlinks;
}

/**
 * Tool to create a new memo
 * This executes automatically without requiring human confirmation
 */
const createMemo = tool({
  description: "Create a new memo with the given information",
  parameters: z.object({
    slug: z.string().describe("A unique identifier for the memo (URL-friendly)"),
    content: z.string().describe("The content of the memo"),
    headers: z.string().optional().describe("Optional JSON string of headers metadata"),
    links: z.string().optional().describe("Optional JSON string of related links"),
  }),
  execute: async ({ slug, content, headers = "{}", links = "{}" }) => {
    const agent = agentContext.getStore();
    if (!agent) {
      throw new Error("No agent found");
    }

    try {
      // Ensure the table exists
      await initMemosTable();

      // Check if a memo with this slug already exists
      const existingMemo = await agent.sql<{ count: number }>`
        SELECT COUNT(*) as count FROM memos WHERE slug = ${slug}
      `;

      if (existingMemo[0]?.count > 0) {
        return `Error: A memo with the slug '${slug}' already exists.`;
      }

      // Create the new memo
      const now = new Date().toISOString();
      const id = generateMemoId();
      
      // Initialize with empty links - we'll update after insert
      const initialLinks = JSON.stringify({ incoming: [], outgoing: [] });

      await agent.sql`
        INSERT INTO memos (id, slug, content, headers, links, created, modified)
        VALUES (${id}, ${slug}, ${content}, ${headers}, ${initialLinks}, ${now}, ${now})
      `;
      
      // Process and update backlinks
      const backlinks = await updateBacklinks(agent, slug, content);

      return `Memo created successfully with ID: ${id} and slug: ${slug}`;
    } catch (error) {
      console.error("Error creating memo:", error);
      return `Error creating memo: ${error}`;
    }
  },
});

/**
 * Tool to edit an existing memo
 * This executes automatically without requiring human confirmation
 */
const editMemo = tool({
  description: "Edit an existing memo by its slug",
  parameters: z.object({
    slug: z.string().describe("The slug of the memo to edit"),
    content: z.string().optional().describe("The new content of the memo"),
    headers: z.string().optional().describe("Optional JSON string of headers metadata"),
    links: z.string().optional().describe("Optional JSON string of related links"),
  }),
  execute: async ({ slug, content, headers, links }) => {
    const agent = agentContext.getStore();
    if (!agent) {
      throw new Error("No agent found");
    }

    try {
      // Ensure the table exists
      await initMemosTable();

      // Check if the memo exists
      const existingMemo = await agent.sql<Memo>`
        SELECT * FROM memos WHERE slug = ${slug}
      `;

      if (!existingMemo.length) {
        return `Error: No memo found with the slug '${slug}'.`;
      }

      const memo = existingMemo[0];
      const now = new Date().toISOString();

      // Only update fields that were provided
      const updatedContent = content !== undefined ? content : memo.content;
      const updatedHeaders = headers !== undefined ? headers : memo.headers;
      const updatedLinks = links !== undefined ? links : memo.links;

      await agent.sql`
        UPDATE memos
        SET content = ${updatedContent},
            headers = ${updatedHeaders},
            modified = ${now}
        WHERE slug = ${slug}
      `;
      
      // Only process backlinks if content was updated
      if (content !== undefined) {
        // Process and update backlinks
        const backlinks = await updateBacklinks(agent, slug, updatedContent);
      }

      return `Memo '${slug}' updated successfully.`;
    } catch (error) {
      console.error("Error editing memo:", error);
      return `Error editing memo: ${error}`;
    }
  },
});

/**
 * Tool to get a memo by its slug
 * This executes automatically without requiring human confirmation
 */
const getMemo = tool({
  description: "Get a memo by its slug",
  parameters: z.object({
    slug: z.string().describe("The slug of the memo to retrieve"),
  }),
  execute: async ({ slug }) => {
    const agent = agentContext.getStore();
    if (!agent) {
      throw new Error("No agent found");
    }

    try {
      // Ensure the table exists
      await initMemosTable();

      const memo = await agent.sql<Memo>`
        SELECT * FROM memos WHERE slug = ${slug}
      `;

      if (!memo.length) {
        return `No memo found with the slug '${slug}'.`;
      }

      return memo[0];
    } catch (error) {
      console.error("Error retrieving memo:", error);
      return `Error retrieving memo: ${error}`;
    }
  },
});

/**
 * Tool to delete a memo by its slug
 * This executes automatically without requiring human confirmation
 */
const deleteMemo = tool({
  description: "Delete a memo by its slug",
  parameters: z.object({
    slug: z.string().describe("The slug of the memo to delete"),
  }),
  execute: async ({ slug }) => {
    const agent = agentContext.getStore();
    if (!agent) {
      throw new Error("No agent found");
    }

    try {
      // Ensure the table exists
      await initMemosTable();

      // Check if the memo exists
      const existingMemo = await agent.sql<{ count: number }>`
        SELECT COUNT(*) as count FROM memos WHERE slug = ${slug}
      `;

      if (existingMemo[0]?.count === 0) {
        return `Error: No memo found with the slug '${slug}'.`;
      }

      await agent.sql`
        DELETE FROM memos WHERE slug = ${slug}
      `;

      return `Memo '${slug}' deleted successfully.`;
    } catch (error) {
      console.error("Error deleting memo:", error);
      return `Error deleting memo: ${error}`;
    }
  },
});

/**
 * Tool to search for memos by content
 * This executes automatically without requiring human confirmation
 */
const searchMemos = tool({
  description: "Search for memos containing specific text in their content",
  parameters: z.object({
    query: z.string().describe("The text to search for in memo content"),
    limit: z.number().optional().describe("Maximum number of results to return (default: 10)"),
    field: z.enum(['content', 'slug', 'headers', 'links', 'all']).optional().describe("Field to search in (default: content)"),
  }),
  execute: async ({ query, limit = 10, field = 'content' }) => {
    const agent = agentContext.getStore();
    if (!agent) {
      throw new Error("No agent found");
    }

    try {
      // Ensure the table exists
      await initMemosTable();
      
      // Sanitize the search pattern to prevent SQL injection
      const searchPattern = '%' + query.replace(/[%_]/g, char => `\\${char}`) + '%';

      let memos;
      if (field === 'all') {
        memos = await agent.sql<Memo>`
          SELECT * FROM memos 
          WHERE content LIKE ${searchPattern} 
             OR slug LIKE ${searchPattern}
             OR headers LIKE ${searchPattern}
             OR links LIKE ${searchPattern}
          ORDER BY modified DESC 
          LIMIT ${limit}
        `;
      } else if (field === 'content') {
        memos = await agent.sql<Memo>`
          SELECT * FROM memos 
          WHERE content LIKE ${searchPattern} 
          ORDER BY modified DESC 
          LIMIT ${limit}
        `;
      } else if (field === 'slug') {
        memos = await agent.sql<Memo>`
          SELECT * FROM memos 
          WHERE slug LIKE ${searchPattern} 
          ORDER BY modified DESC 
          LIMIT ${limit}
        `;
      } else if (field === 'headers') {
        memos = await agent.sql<Memo>`
          SELECT * FROM memos 
          WHERE headers LIKE ${searchPattern} 
          ORDER BY modified DESC 
          LIMIT ${limit}
        `;
      } else { // links
        memos = await agent.sql<Memo>`
          SELECT * FROM memos 
          WHERE links LIKE ${searchPattern} 
          ORDER BY modified DESC 
          LIMIT ${limit}
        `;
      }

      if (!memos.length) {
        return `No memos found containing '${query}'.`;
      }

      return memos;
    } catch (error) {
      console.error("Error searching memos:", error);
      return `Error searching memos: ${error}`;
    }
  },
});

/**
 * Tool to list all memos
 * This executes automatically without requiring human confirmation
 */
const listMemos = tool({
  description: "List all memos, optionally limited and sorted",
  parameters: z.object({
    limit: z.number().optional().describe("Maximum number of memos to return (default: 20)"),
    sortBy: z.enum(['created', 'modified', 'slug']).optional().describe("Field to sort by (default: modified)"),
    sortOrder: z.enum(['asc', 'desc']).optional().describe("Sort order (default: desc)"),
  }),
  execute: async ({ limit = 20, sortBy = 'modified', sortOrder = 'desc' }) => {
    const agent = agentContext.getStore();
    if (!agent) {
      throw new Error("No agent found");
    }

    try {
      // Ensure the table exists
      await initMemosTable();

      // Execute the query with a simple ORDER BY clause using template literals
      let memos;
      if (sortBy === 'created') {
        if (sortOrder === 'asc') {
          memos = await agent.sql<Memo>`SELECT * FROM memos ORDER BY created ASC LIMIT ${limit}`;
        } else {
          memos = await agent.sql<Memo>`SELECT * FROM memos ORDER BY created DESC LIMIT ${limit}`;
        }
      } else if (sortBy === 'slug') {
        if (sortOrder === 'asc') {
          memos = await agent.sql<Memo>`SELECT * FROM memos ORDER BY slug ASC LIMIT ${limit}`;
        } else {
          memos = await agent.sql<Memo>`SELECT * FROM memos ORDER BY slug DESC LIMIT ${limit}`;
        }
      } else {
        // Default to 'modified'
        if (sortOrder === 'asc') {
          memos = await agent.sql<Memo>`SELECT * FROM memos ORDER BY modified ASC LIMIT ${limit}`;
        } else {
          memos = await agent.sql<Memo>`SELECT * FROM memos ORDER BY modified DESC LIMIT ${limit}`;
        }
      }

      if (!memos.length) {
        return "No memos found.";
      }

      return memos;
    } catch (error) {
      console.error("Error listing memos:", error);
      return `Error listing memos: ${error}`;
    }
  },
});

/**
 * Tool to execute arbitrary SQL queries on the memos table
 * This executes automatically without requiring human confirmation
 */
const queryMemos = tool({
  description: "Execute a custom SQL query on the memos table",
  parameters: z.object({
    query: z.string().describe("The SQL query to execute (must begin with SELECT for safety)"),
  }),
  execute: async ({ query }) => {
    const agent = agentContext.getStore();
    if (!agent) {
      throw new Error("No agent found");
    }

    try {
      // Ensure the table exists
      await initMemosTable();

      // Simple security check to only allow SELECT queries
      const trimmedQuery = query.trim().toLowerCase();
      if (!trimmedQuery.startsWith('select')) {
        return "Error: Only SELECT queries are allowed for safety reasons.";
      }

      // Execute the raw query safely
      try {
        const results = await agent.sql(query);
        return results;
      } catch (error) {
        console.error('Error in custom SQL query:', error);
        return `Error executing custom query: ${error.message}`;
      }
    } catch (error) {
      console.error("Error executing query:", error);
      return `Error executing query: ${error}`;
    }
  },
});

/**
 * Tool to find all memos that link to a specific slug
 * This executes automatically without requiring human confirmation
 */
const findBacklinks = tool({
  description: "Find all memos that link to a specific memo",
  parameters: z.object({
    slug: z.string().describe("The slug of the memo to find backlinks for"),
    includeContent: z.boolean().optional().describe("Whether to include the full content of linked memos (default: false)"),
  }),
  execute: async ({ slug, includeContent = false }) => {
    const agent = agentContext.getStore();
    if (!agent) {
      throw new Error("No agent found");
    }

    try {
      // Ensure the table exists
      await initMemosTable();

      // Check if the memo exists
      const memoExists = await agent.sql<{ count: number }>`
        SELECT COUNT(*) as count FROM memos WHERE slug = ${slug}
      `;

      if (memoExists[0]?.count === 0) {
        return `Error: No memo found with the slug '${slug}'.`;
      }

      // Get all memos that might link to this one
      // First approach: Check for explicit links column references
      let linkedMemos;
      if (includeContent) {
        linkedMemos = await agent.sql<Memo>`
          SELECT * FROM memos 
          WHERE links LIKE ${'%"outgoing":%"' + slug + '"%'}
        `;
      } else {
        linkedMemos = await agent.sql<Memo>`
          SELECT id, slug, created, modified FROM memos 
          WHERE links LIKE ${'%"outgoing":%"' + slug + '"%'}
        `;
      }

      // Second approach: Check for [[slug]] pattern in content
      let contentLinkedMemos;
      if (includeContent) {
        contentLinkedMemos = await agent.sql<Memo>`
          SELECT * FROM memos 
          WHERE content LIKE ${'%[[' + slug + ']]%'}
        `;
      } else {
        contentLinkedMemos = await agent.sql<Memo>`
          SELECT id, slug, created, modified FROM memos 
          WHERE content LIKE ${'%[[' + slug + ']]%'}
        `;
      }

      // Combine results and remove duplicates
      const allMemos = [...linkedMemos];
      const existingSlugs = new Set(allMemos.map(memo => memo.slug));
      
      for (const memo of contentLinkedMemos) {
        if (!existingSlugs.has(memo.slug)) {
          allMemos.push(memo);
          existingSlugs.add(memo.slug);
        }
      }

      if (allMemos.length === 0) {
        return `No memos found that link to '${slug}'.`;
      }

      return allMemos;
    } catch (error) {
      console.error("Error finding backlinks:", error);
      return `Error finding backlinks: ${error}`;
    }
  },
});

/**
 * Export all memo-related tools
 */
export const memoTools = {
  createMemo,
  editMemo,
  getMemo,
  deleteMemo,
  searchMemos,
  listMemos,
  queryMemos,
  findBacklinks,
};