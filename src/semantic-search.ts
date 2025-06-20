/**
 * Helper functions for semantic search of memos
 */
import { tool } from "ai";
import { z } from "zod";
import { agentContext } from "./server";
import type { Chat } from "./server";

/**
 * Memo interface used in semantic search
 */
export interface Memo {
  id: string;
  slug: string;
  content: string;
  headers: string;
  links: string;
  created: string;
  modified: string;
  vector_id?: string;
  [key: string]: any; // Allow for additional properties from database results
}

/**
 * Tool to search for semantically similar memos using vector embeddings
 * This executes automatically without requiring human confirmation
 */
export const semanticSearchMemos = tool({
  description:
    "Find memos that are semantically similar to the provided query using vector embeddings",
  parameters: z.object({
    query: z
      .string()
      .describe("The text to find semantically similar memos for"),
    limit: z
      .number()
      .optional()
      .describe("Maximum number of results to return (default: 5)"),
    includeExactMatches: z
      .boolean()
      .optional()
      .describe(
        "Whether to include exact text matches in results (default: true)"
      ),
  }),
  execute: async ({ query, limit = 5, includeExactMatches = true }) => {
    const agent = agentContext.getStore() as Chat | null;
    if (!agent) {
      throw new Error("No agent found");
    }

    try {
      console.log(`Semantic search for: "${query}" with limit: ${limit}`);
      const results: Memo[] = [];

      // If includeExactMatches is true, check for exact matches first
      if (includeExactMatches) {
        try {
          // Split the query into words and search for each word separately
          // with a LIMIT on each subquery to avoid pattern complexity
          const words = query.split(/\s+/).filter((w) => w.length > 2); // Filter out short words

          if (words.length > 0) {
            // Take just the first few significant words to simplify the query
            const significantWords = words.slice(0, 3);
            let exactMatches: Memo[] = [];

            for (const word of significantWords) {
              // Escape special characters for SQL LIKE
              const safeWord = word.replace(/[%_'\"]/g, (char) => `\\${char}`);

              try {
                // @ts-ignore - SQL template type issues
                const wordMatches = (await agent.sql`
                  SELECT * FROM memos 
                  WHERE content LIKE ${`%${safeWord}%`}
                  LIMIT ${Math.ceil(limit / significantWords.length)}
                `) as any as Memo[];

                if (wordMatches && wordMatches.length > 0) {
                  // Add unique results
                  for (const match of wordMatches) {
                    if (!exactMatches.some((m) => m.id === match.id)) {
                      exactMatches.push(match);
                    }
                  }
                }
              } catch (wordError) {
                console.error(
                  `Error in word match search for '${word}':`,
                  wordError
                );
                // Continue with other words
              }

              // If we have enough results, break early
              if (exactMatches.length >= limit) {
                break;
              }
            }

            if (exactMatches.length > 0) {
              console.log(`Found ${exactMatches.length} exact text matches`);
              results.push(...exactMatches.slice(0, limit));
            }
          }
        } catch (error) {
          console.error("Error in exact match search:", error);
          // Continue to vector search even if exact match fails
        }
      }

      // Try vector search
      try {
        // Generate embeddings for the query
        // Add error handling for authentication issues
        try {
          const embeddings = await agent.createEmbeddings(query);

          // Search for semantically similar vectors
          const vectorResults = await agent.searchSimilarVectors(
            embeddings,
            limit
          );

          if (vectorResults?.matches?.length > 0) {
            console.log(`Found ${vectorResults.matches.length} vector matches`);

            // Process vector results by fetching the actual memos
            const validMemoIds: string[] = [];
            for (const match of vectorResults.matches) {
              if (
                match?.metadata?.memo_id &&
                typeof match.metadata.memo_id === "string"
              ) {
                validMemoIds.push(match.metadata.memo_id);
              }
            }

            if (validMemoIds.length > 0) {
              // Fetch each memo individually to avoid SQL IN issues
              for (const memoId of validMemoIds) {
                try {
                  // @ts-ignore - SQL template type issues
                  const memoResult = (await agent.sql`
                    SELECT * FROM memos WHERE id = ${memoId}
                  `) as any as Memo[];

                  if (memoResult && memoResult.length > 0) {
                    // Check if we already have this memo from exact match search
                    if (!results.some((m) => m.id === memoId)) {
                      results.push(memoResult[0]);
                    }
                  }
                } catch (err) {
                  console.error(`Error fetching memo ${memoId}:`, err);
                }
              }
            }
          }
        } catch (embeddingError) {
          console.error("Error creating embeddings:", embeddingError);
          // Log more detailed information about the authentication error
          if (
            embeddingError instanceof Error &&
            embeddingError.message.includes("Authentication")
          ) {
            console.error(
              "Authentication error detected - please check your Cloudflare credentials"
            );
          }
        }
      } catch (error) {
        console.error("Error in vector search:", error);
        // Continue to fallback search if vector search fails
      }

      // If we found results, return them
      if (results.length > 0) {
        return results.slice(0, limit);
      }

      // Fallback: Basic keyword search if no results were found
      try {
        // Use a simpler approach for the fallback search to avoid complex patterns
        // Take only the first 2-3 words to reduce complexity
        const searchWords = query
          .split(/\s+/)
          .filter((w) => w.length > 2)
          .slice(0, 2);

        if (searchWords.length > 0) {
          let keywordResults: Memo[] = [];

          for (const word of searchWords) {
            // Escape special characters for SQL LIKE
            const safeWord = word.replace(/[%_'\"]/g, (char) => `\\${char}`);

            try {
              // @ts-ignore - SQL template type issues
              const wordResults = (await agent.sql`
                SELECT * FROM memos 
                WHERE content LIKE ${`%${safeWord}%`}
                OR slug LIKE ${`%${safeWord}%`}
                LIMIT ${Math.ceil(limit / searchWords.length)}
              `) as any as Memo[];

              if (wordResults && wordResults.length > 0) {
                // Add unique results
                for (const match of wordResults) {
                  if (!keywordResults.some((m) => m.id === match.id)) {
                    keywordResults.push(match);
                  }
                }
              }
            } catch (wordError) {
              console.error(
                `Error in fallback word search for '${word}':`,
                wordError
              );
              // Continue with other words
            }

            // If we have enough results, break early
            if (keywordResults.length >= limit) {
              break;
            }
          }

          if (keywordResults.length > 0) {
            console.log(
              `Found ${keywordResults.length} keyword matches as fallback`
            );
            return keywordResults.slice(0, limit);
          }
        }
      } catch (error) {
        console.error("Error in fallback keyword search:", error);
      }

      return `No memos found matching "${query}". Try a different search term or create a new memo with this information.`;
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      console.error("Error in semantic search:", errorMessage);
      return `Error searching for semantically similar memos: ${errorMessage}`;
    }
  },
});
