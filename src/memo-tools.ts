/**
 * Memo management tools for the AI chat agent
 * Includes tools for creating, editing, searching, and deleting memos
 */
import { tool } from "ai";
import { z } from "zod";

import { agentContext } from "./server";
import type { Chat } from "./server";
// Import the semantic search tool from dedicated file
import { semanticSearchMemos } from "./semantic-search";
// Import fragment tools for auto-fragment creation
import { fragmentTools } from "./fragment-tools";

// Define memo schema
export type Memo = {
  id: string;
  slug: string;
  content: string;
  headers: string; // JSON string for headers
  links: string; // JSON string for links
  created: string; // ISO datetime string
  modified: string; // ISO datetime string
  vector_id?: string; // Reference to vector embedding
  parent_id?: string | null; // Self-referential FK for threading
  author?: string; // "user" | "assistant" | @handle
};

/**
 * Interface for embedding API response
 */
interface EmbeddingResponse {
  data: number[][];
}

/**
 * Initializes the memos database table if it doesn't exist
 */
export async function initMemosTable() {
  const agent = agentContext.getStore();
  if (!agent) {
    throw new Error("No agent found");
  }

  return initMemosTableWithAgent(agent);
}

/**
 * Initializes the memos database table if it doesn't exist (with agent parameter)
 */
export async function initMemosTableWithAgent(agent: any) {
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

    // Check if vector_id column exists, add it if it doesn't
    try {
      // First try to query using vector_id to see if it exists
      await agent.sql`SELECT vector_id FROM memos LIMIT 1`;
      console.log("vector_id column already exists");
    } catch (error) {
      // If error occurs, the column doesn't exist yet, so add it
      console.log("Adding vector_id column to memos table");
      await agent.sql`ALTER TABLE memos ADD COLUMN vector_id TEXT`;
    }

    // Check if parent_id column exists, add it if it doesn't
    try {
      await agent.sql`SELECT parent_id FROM memos LIMIT 1`;
      console.log("parent_id column already exists");
    } catch (error) {
      console.log("Adding parent_id column to memos table");
      await agent.sql`ALTER TABLE memos ADD COLUMN parent_id TEXT`;
    }

    // Check if author column exists, add it if it doesn't
    try {
      await agent.sql`SELECT author FROM memos LIMIT 1`;
      console.log("author column already exists");
    } catch (error) {
      console.log("Adding author column to memos table");
      await agent.sql`ALTER TABLE memos ADD COLUMN author TEXT DEFAULT 'user'`;
    }

    // Ensure the summary column exists
    try {
      await agent.sql`SELECT summary FROM memos LIMIT 1`;
      console.log("summary column already exists");
    } catch (error) {
      console.log("Adding summary column to memos table");
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
    .map((match) => match.slice(2, -2).trim()) // Remove [[ and ]]
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
  const currentLinksResult = await agent.sql`
    SELECT links FROM memos WHERE slug = ${slug}
  `;

  let linksObj = { incoming: [], outgoing: backlinks };

  // If the memo already has links, preserve its incoming links
  if (currentLinksResult && currentLinksResult.length > 0) {
    try {
      const currentLinks = currentLinksResult[0]?.links;
      if (currentLinks && typeof currentLinks === "string") {
        const existingLinks = JSON.parse(currentLinks);
        linksObj.incoming = existingLinks.incoming || [];
      }
    } catch (e) {
      // If parsing fails, use the default empty array
    }
  }

  // Update the current memo's links
  if (slug && typeof slug === "string") {
    const updatedLinksJson = JSON.stringify(linksObj);
    // @ts-ignore - Type safety is manually verified above
    await agent.sql`
      UPDATE memos
      SET links = ${updatedLinksJson}
      WHERE slug = ${slug}
    `;
  }

  // For each extracted backlink, update the target memo's incoming links
  for (const targetSlug of backlinks) {
    // Check if the target memo exists
    const targetExistsResult = await agent.sql`
      SELECT COUNT(*) as count FROM memos WHERE slug = ${targetSlug}
    `;

    const targetCount = targetExistsResult[0]?.count;
    if (targetCount && typeof targetCount === "number" && targetCount > 0) {
      // Get the current links of the target memo
      const targetLinksResult = await agent.sql`
        SELECT links FROM memos WHERE slug = ${targetSlug}
      `;

      // Define typed structure for links object
      interface LinksObject {
        incoming: string[];
        outgoing: string[];
      }

      let targetLinksObj: LinksObject = { incoming: [], outgoing: [] };

      try {
        // Get links from the result
        const targetLinksStr = targetLinksResult[0]?.links;
        if (targetLinksStr && typeof targetLinksStr === "string") {
          const parsedLinks = JSON.parse(targetLinksStr);
          targetLinksObj = {
            incoming: Array.isArray(parsedLinks.incoming)
              ? (parsedLinks.incoming as string[])
              : [],
            outgoing: Array.isArray(parsedLinks.outgoing)
              ? (parsedLinks.outgoing as string[])
              : [],
          };
        }
      } catch (e) {
        // If any error, use default structure
        console.error("Error parsing links:", e);
      }

      // Add the current slug to incoming links if not already there
      if (typeof slug === "string" && !targetLinksObj.incoming.includes(slug)) {
        targetLinksObj.incoming.push(slug);

        // Update the target memo's links
        // Create a safe JSON string for SQL
        const targetLinksJsonString = JSON.stringify(targetLinksObj);

        // Update the database - Use a safer approach to avoid type issues
        if (targetSlug && typeof targetSlug === "string") {
          // Use @ts-ignore to bypass the type checker for this one statement
          // since we've already validated the types above
          // @ts-ignore
          await agent.sql`
            UPDATE memos
            SET links = ${targetLinksJsonString}
            WHERE slug = ${targetSlug}
          `;
        }
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
    slug: z
      .string()
      .describe("A unique identifier for the memo (URL-friendly)"),
    content: z.string().describe("The content of the memo"),
    headers: z
      .string()
      .optional()
      .describe("Optional JSON string of headers metadata"),
    links: z
      .string()
      .optional()
      .describe("Optional JSON string of related links"),
    parent_id: z
      .string()
      .optional()
      .describe("Optional parent memo ID for threading"),
    author: z
      .string()
      .optional()
      .describe("Author of the memo ('user' | 'assistant' | @handle)"),
  }),
  execute: async ({
    slug,
    content,
    headers = "{}",
    links = "{}",
    parent_id = null,
    author = "user",
  }) => {
    console.log("createMemo called with:", {
      slug,
      content: content.substring(0, 50) + "...",
      headers,
      links,
      parent_id,
      author,
    });

    const agent = agentContext.getStore() as Chat | null;
    if (!agent) {
      throw new Error("No agent found");
    }

    try {
      // Ensure the table exists
      await initMemosTable();

      // Check if a memo with this slug already exists
      const existingMemoResult = await agent.sql`
        SELECT COUNT(*) as count FROM memos WHERE slug = ${slug}
      `;

      const count = existingMemoResult[0]?.count;
      console.log("Existing memo check:", { slug, count });
      if (count && typeof count === "number" && count > 0) {
        return `Error: A memo with the slug '${slug}' already exists.`;
      }

      // Create the new memo
      const now = new Date().toISOString();
      const id = generateMemoId();

      console.log("Creating memo with:", { id, slug, parent_id, author, now });

      // Initialize with empty links - we'll update after insert
      const initialLinks = JSON.stringify({ incoming: [], outgoing: [] });

      // Generate vector embeddings for the content to enable semantic search
      let vector_id = null;
      try {
        // Generate embeddings using the Chat class method
        const embeddings = await agent.createEmbeddings(content);

        // Store the vector embedding
        vector_id = `memo-${id}`;
        const metadata = {
          memo_id: id,
          slug: slug,
        };
        await agent.storeVectorEmbedding(vector_id, embeddings, metadata);

        console.log(`Created vector embedding with ID: ${vector_id}`);
      } catch (error) {
        console.error("Error generating vector embeddings:", error);
        // Continue even if embedding fails - we'll still create the memo
      }

      // Insert the memo with all columns
      console.log("Inserting memo into database...");
      if (vector_id) {
        // @ts-ignore - Type safety is manually verified above
        await agent.sql`
          INSERT INTO memos (id, slug, content, headers, links, created, modified, vector_id, parent_id, author)
          VALUES (${id}, ${slug}, ${content}, ${headers}, ${initialLinks}, ${now}, ${now}, ${vector_id}, ${parent_id}, ${author})
        `;
      } else {
        // @ts-ignore - Type safety is manually verified above
        await agent.sql`
          INSERT INTO memos (id, slug, content, headers, links, created, modified, parent_id, author)
          VALUES (${id}, ${slug}, ${content}, ${headers}, ${initialLinks}, ${now}, ${now}, ${parent_id}, ${author})
        `;
      }
      console.log("Memo inserted successfully");

      // Process and update backlinks
      const backlinks = await updateBacklinks(agent, slug, content);

      // Auto-create a fragment from this memo if content is substantial
      if (content.trim().length >= 20) {
        try {
          // Generate a fragment slug from the memo slug
          const fragmentSlug = `${slug}-fragment`;

          // Create the fragment
          await fragmentTools.createFragment.execute({
            slug: fragmentSlug,
            content: content,
            speaker: author,
            ts: now,
            metadata: JSON.stringify({
              auto: true,
              source_memo: slug,
              source_type: "memo",
            }),
          });

          console.log(
            `Auto-created fragment '${fragmentSlug}' from memo '${slug}'`
          );
        } catch (err) {
          // Don't fail memo creation if fragment creation fails
          console.warn(
            `Failed to auto-create fragment for memo '${slug}':`,
            err
          );
        }
      }

      console.log("Memo creation completed successfully");
      return `Memo created successfully with ID: ${id} and slug: ${slug}`;
    } catch (error) {
      console.error("Error creating memo:", error);
      return `Error creating memo: ${error}`;
    }
  },
});

/**
 * Tool to create a reply to an existing memo
 * This executes automatically without requiring human confirmation
 */
const createReply = tool({
  description: "Create a reply to an existing memo",
  parameters: z.object({
    parent_slug: z.string().describe("The slug of the parent memo to reply to"),
    content: z.string().describe("The content of the reply"),
    author: z
      .string()
      .optional()
      .describe("Author of the reply ('user' | 'assistant' | @handle)"),
    headers: z
      .string()
      .optional()
      .describe("Optional JSON string of headers metadata"),
  }),
  execute: async ({
    parent_slug,
    content,
    author = "user",
    headers = "{}",
  }) => {
    const agent = agentContext.getStore() as Chat | null;
    if (!agent) {
      throw new Error("No agent found");
    }

    try {
      // Ensure the table exists
      await initMemosTable();

      // Check if the parent memo exists
      const parentMemoResult = await agent.sql`
        SELECT id FROM memos WHERE slug = ${parent_slug}
      `;

      console.log("Looking for parent memo with slug:", parent_slug);
      console.log("Parent memo result:", parentMemoResult);

      if (!parentMemoResult.length) {
        return `Error: Parent memo with slug '${parent_slug}' not found.`;
      }

      const parentId = parentMemoResult[0].id;
      console.log("Found parent ID:", parentId);

      // Generate a unique slug for the reply
      const timestamp = Date.now();
      const baseSlug = `${parent_slug}-reply-${timestamp}`;
      let replySlug = baseSlug;
      let counter = 1;

      // Ensure slug uniqueness
      while (true) {
        const existingResult = await agent.sql`
          SELECT COUNT(*) as count FROM memos WHERE slug = ${replySlug}
        `;

        const count = existingResult[0]?.count;
        if (count === 0) break;

        counter++;
        replySlug = `${baseSlug}-${counter}`;

        // Prevent infinite loop
        if (counter > 100) {
          throw new Error("Could not generate unique slug after 100 attempts");
        }
      }

      console.log("Generated reply slug:", replySlug);

      // Create the reply memo
      const now = new Date().toISOString();
      const id = generateMemoId();
      const initialLinks = JSON.stringify({ incoming: [], outgoing: [] });

      // Generate vector embeddings for the content
      let vector_id = null;
      try {
        const embeddings = await agent.createEmbeddings(content);
        vector_id = `memo-${id}`;
        const metadata = {
          memo_id: id,
          slug: replySlug,
        };
        await agent.storeVectorEmbedding(vector_id, embeddings, metadata);
        console.log(`Created vector embedding with ID: ${vector_id}`);
      } catch (error) {
        console.error("Error generating vector embeddings:", error);
      }

      // Insert the reply memo
      console.log("Inserting reply memo with parent_id:", parentId);

      if (vector_id) {
        await agent.sql`
          INSERT INTO memos (id, slug, content, headers, links, created, modified, vector_id, parent_id, author)
          VALUES (${id}, ${replySlug}, ${content}, ${headers}, ${initialLinks}, ${now}, ${now}, ${vector_id}, ${parentId}, ${author})
        `;
      } else {
        await agent.sql`
          INSERT INTO memos (id, slug, content, headers, links, created, modified, parent_id, author)
          VALUES (${id}, ${replySlug}, ${content}, ${headers}, ${initialLinks}, ${now}, ${now}, ${parentId}, ${author})
        `;
      }

      console.log("Reply memo inserted successfully");

      // Process and update backlinks
      const backlinks = await updateBacklinks(agent, replySlug, content);

      // Auto-create a fragment from this reply if content is substantial
      if (content.trim().length >= 20) {
        try {
          const fragmentSlug = `${replySlug}-fragment`;

          await fragmentTools.createFragment.execute({
            slug: fragmentSlug,
            content: content,
            speaker: author,
            ts: now,
            metadata: JSON.stringify({
              auto: true,
              source_memo: replySlug,
              source_type: "memo_reply",
              parent_memo: parent_slug,
            }),
          });

          console.log(
            `Auto-created fragment '${fragmentSlug}' from reply '${replySlug}'`
          );
        } catch (err) {
          console.warn(
            `Failed to auto-create fragment for reply '${replySlug}':`,
            err
          );
        }
      }

      return `Reply created successfully with ID: ${id} and slug: ${replySlug}`;
    } catch (error) {
      console.error("Error creating reply:", error);
      return `Error creating reply: ${error instanceof Error ? error.message : String(error)}`;
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
    headers: z
      .string()
      .optional()
      .describe("Optional JSON string of headers metadata"),
    links: z
      .string()
      .optional()
      .describe("Optional JSON string of related links"),
  }),
  execute: async ({ slug, content, headers, links }) => {
    const agent = agentContext.getStore() as Chat | null;
    if (!agent) {
      throw new Error("No agent found");
    }

    try {
      // Ensure the table exists
      await initMemosTable();

      // Check if the memo exists
      const existingMemoResult = await agent.sql`
        SELECT * FROM memos WHERE slug = ${slug}
      `;

      if (!existingMemoResult.length) {
        return `Error: No memo found with the slug '${slug}'.`;
      }

      const memo = existingMemoResult[0];
      const now = new Date().toISOString();

      // Only update fields that were provided
      const updatedContent = content !== undefined ? content : memo.content;
      const updatedHeaders = headers !== undefined ? headers : memo.headers;
      const updatedLinks = links !== undefined ? links : memo.links;

      // Update the vector embedding if content was updated
      if (content !== undefined) {
        try {
          // Get existing vector_id or create a new one
          const memoId = memo.id && typeof memo.id === "string" ? memo.id : "";
          let vector_id =
            memo.vector_id && typeof memo.vector_id === "string"
              ? memo.vector_id
              : `memo-${memoId}`;

          // Generate new embeddings for the updated content
          // Ensure content is a string
          const contentToEmbed =
            typeof updatedContent === "string"
              ? updatedContent
              : String(updatedContent);
          const embeddings = await agent.createEmbeddings(contentToEmbed);

          // Store the updated vector embedding
          const memoMetadata = {
            memo_id: typeof memo.id === "string" ? memo.id : "",
            slug: typeof slug === "string" ? slug : "",
          };
          await agent.storeVectorEmbedding(vector_id, embeddings, memoMetadata);

          // Update memo with content and vector_id
          if (
            vector_id &&
            typeof vector_id === "string" &&
            slug &&
            typeof slug === "string"
          ) {
            // @ts-ignore - Type safety is manually verified above
            await agent.sql`
              UPDATE memos
              SET content = ${updatedContent},
                  headers = ${updatedHeaders},
                  modified = ${now},
                  vector_id = ${vector_id}
              WHERE slug = ${slug}
            `;
          }

          console.log(`Updated vector embedding with ID: ${vector_id}`);
        } catch (error) {
          console.error("Error updating vector embeddings:", error);

          // If embedding fails, still update the content without vector_id
          if (slug && typeof slug === "string") {
            // @ts-ignore - Type safety is manually verified above
            await agent.sql`
              UPDATE memos
              SET content = ${updatedContent},
                  headers = ${updatedHeaders},
                  modified = ${now}
              WHERE slug = ${slug}
            `;
          }
        }

        // Process and update backlinks when content changes
        // Ensure slug and content are strings
        const slugStr = typeof slug === "string" ? slug : "";
        const contentStr =
          typeof updatedContent === "string"
            ? updatedContent
            : String(updatedContent);
        const backlinks = await updateBacklinks(agent, slugStr, contentStr);
      } else {
        // If content wasn't updated, just update the other fields
        if (slug && typeof slug === "string") {
          // @ts-ignore - Type safety is manually verified above
          await agent.sql`
            UPDATE memos
            SET headers = ${updatedHeaders},
                modified = ${now}
            WHERE slug = ${slug}
          `;
        }
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
    const agent = agentContext.getStore() as Chat | null;
    if (!agent) {
      throw new Error("No agent found");
    }

    try {
      // Ensure the table exists
      await initMemosTable();

      // Get the memo to check if it exists and to get its vector_id
      const memoResult = await agent.sql`
        SELECT id, vector_id FROM memos WHERE slug = ${slug}
      `;

      if (!memoResult.length) {
        return `Error: No memo found with the slug '${slug}'.`;
      }

      // Delete the associated vector embedding if it exists
      const vectorId = memoResult[0]?.vector_id;
      if (vectorId && typeof vectorId === "string") {
        try {
          await agent.deleteVectorEmbedding(vectorId);
          console.log(`Deleted vector embedding with ID: ${vectorId}`);
        } catch (error) {
          console.error(
            `Error deleting vector embedding for memo ${slug}:`,
            error
          );
          // Continue with memo deletion even if vector deletion fails
        }
      }

      // Delete the memo from the database
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
    limit: z
      .number()
      .optional()
      .describe("Maximum number of results to return (default: 10)"),
    field: z
      .enum(["content", "slug", "headers", "links", "all"])
      .optional()
      .describe("Field to search in (default: content)"),
  }),
  execute: async ({ query, limit = 10, field = "content" }) => {
    const agent = agentContext.getStore();
    if (!agent) {
      throw new Error("No agent found");
    }

    try {
      // Ensure the table exists
      await initMemosTable();

      // Sanitize the search pattern to prevent SQL injection
      const searchPattern =
        "%" + query.replace(/[%_]/g, (char) => `\\${char}`) + "%";

      let memos;
      if (field === "all") {
        memos = await agent.sql<Memo>`
          SELECT * FROM memos
          WHERE content LIKE ${searchPattern}
             OR slug LIKE ${searchPattern}
             OR headers LIKE ${searchPattern}
             OR links LIKE ${searchPattern}
          ORDER BY modified DESC
          LIMIT ${limit}
        `;
      } else if (field === "content") {
        memos = await agent.sql<Memo>`
          SELECT * FROM memos
          WHERE content LIKE ${searchPattern}
          ORDER BY modified DESC
          LIMIT ${limit}
        `;
      } else if (field === "slug") {
        memos = await agent.sql<Memo>`
          SELECT * FROM memos
          WHERE slug LIKE ${searchPattern}
          ORDER BY modified DESC
          LIMIT ${limit}
        `;
      } else if (field === "headers") {
        memos = await agent.sql<Memo>`
          SELECT * FROM memos
          WHERE headers LIKE ${searchPattern}
          ORDER BY modified DESC
          LIMIT ${limit}
        `;
      } else {
        // links
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
    limit: z
      .number()
      .optional()
      .describe("Maximum number of memos to return (default: 20)"),
    sortBy: z
      .enum(["created", "modified", "slug"])
      .optional()
      .describe("Field to sort by (default: modified)"),
    sortOrder: z
      .enum(["asc", "desc"])
      .optional()
      .describe("Sort order (default: desc)"),
  }),
  execute: async ({ limit = 20, sortBy = "modified", sortOrder = "desc" }) => {
    const agent = agentContext.getStore();
    if (!agent) {
      throw new Error("No agent found");
    }

    try {
      // Ensure the table exists
      await initMemosTable();

      // Execute the query with a simple ORDER BY clause using template literals
      let memos;
      if (sortBy === "created") {
        if (sortOrder === "asc") {
          memos =
            await agent.sql<Memo>`SELECT * FROM memos ORDER BY created ASC LIMIT ${limit}`;
        } else {
          memos =
            await agent.sql<Memo>`SELECT * FROM memos ORDER BY created DESC LIMIT ${limit}`;
        }
      } else if (sortBy === "slug") {
        if (sortOrder === "asc") {
          memos =
            await agent.sql<Memo>`SELECT * FROM memos ORDER BY slug ASC LIMIT ${limit}`;
        } else {
          memos =
            await agent.sql<Memo>`SELECT * FROM memos ORDER BY slug DESC LIMIT ${limit}`;
        }
      } else {
        // Default to 'modified'
        if (sortOrder === "asc") {
          memos =
            await agent.sql<Memo>`SELECT * FROM memos ORDER BY modified ASC LIMIT ${limit}`;
        } else {
          memos =
            await agent.sql<Memo>`SELECT * FROM memos ORDER BY modified DESC LIMIT ${limit}`;
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
    query: z
      .string()
      .describe("The SQL query to execute (must begin with SELECT for safety)"),
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
      if (!trimmedQuery.startsWith("select")) {
        return "Error: Only SELECT queries are allowed for safety reasons.";
      }

      // Execute the raw query safely
      try {
        // We need to use a safer method since we can't directly pass a string to sql tagged template
        // @ts-ignore - Ignoring type error for now
        const results = await agent.sql(query);
        return results;
      } catch (error: any) {
        console.error("Error in custom SQL query:", error);
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
    includeContent: z
      .boolean()
      .optional()
      .describe(
        "Whether to include the full content of linked memos (default: false)"
      ),
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
          WHERE content LIKE ${"%[[" + slug + "]]%"}
        `;
      } else {
        contentLinkedMemos = await agent.sql<Memo>`
          SELECT id, slug, created, modified FROM memos
          WHERE content LIKE ${"%[[" + slug + "]]%"}
        `;
      }

      // Combine results and remove duplicates
      const allMemos = [...linkedMemos];
      const existingSlugs = new Set(allMemos.map((memo) => memo.slug));

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

// semanticSearchMemos is imported from semantic-search.ts above
// We don't need to declare it again here

/**
 * Export all memo-related tools
 * Note: semanticSearchMemos is imported from semantic-search.ts
 */
export const memoTools = {
  createMemo,
  createReply,
  editMemo,
  getMemo,
  deleteMemo,
  searchMemos,
  listMemos,
  queryMemos,
  findBacklinks,
  semanticSearchMemos, // This is imported from semantic-search.ts
  initMemosTable,
  initMemosTableWithAgent,
};
