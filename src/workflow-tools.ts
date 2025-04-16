/**
 * Workflow management tools for the AI chat agent
 * Implements functionality for creating, executing, and listing workflow memos
 */
import { tool } from "ai";
import { z } from "zod";
import { agentContext } from "./server";

// Workflow-specific constants
export const WORKFLOW_TYPE = "workflow";

/**
 * Lists all available workflows
 * Workflows are memos with a workflow type in their headers
 */
const listWorkflows = tool({
  description: "Lists all available workflows",
  parameters: z.object({
    limit: z.number().optional().describe("Maximum number of workflows to return (default: 20)"),
    offset: z.number().optional().describe("Number of workflows to skip (default: 0)"),
  }),
  execute: async ({ limit = 20, offset = 0 }) => {
    const agent = agentContext.getStore();
    if (!agent) {
      throw new Error("No agent found");
    }

    try {
      // Get all memos and filter them in JavaScript instead of SQL
      const allMemos = await agent.sql<{
        id: string;
        slug: string;
        content: string;
        headers: string;
        created: string;
        modified: string;
      }>`
        SELECT id, slug, content, headers, created, modified 
        FROM memos
        ORDER BY modified DESC
      `;
      
      // Filter workflows in JavaScript
      const workflows = allMemos.filter(memo => {
        try {
          const headers = JSON.parse(memo.headers);
          return headers.type === WORKFLOW_TYPE;
        } catch {
          return false;
        }
      }).slice(offset, offset + limit);

      if (workflows.length === 0) {
        return "No workflows found.";
      }

      // Format the results
      return workflows.map(workflow => {
        let headers = {};
        try {
          headers = JSON.parse(workflow.headers);
        } catch (e) {
          console.error("Error parsing workflow headers:", e);
        }

        return {
          slug: workflow.slug,
          title: headers.title || workflow.slug,
          description: headers.description || "",
          created: workflow.created,
          modified: workflow.modified,
        };
      });
    } catch (error) {
      console.error("Error listing workflows:", error);
      return `Error listing workflows: ${error}`;
    }
  },
});

/**
 * Executes a workflow by its slug
 * This loads the workflow content and provides it to the AI agent for execution
 */
const executeWorkflow = tool({
  description: "Execute a workflow by its slug",
  parameters: z.object({
    slug: z.string().describe("The slug of the workflow to execute"),
    parameters: z.string().optional().describe("Optional JSON string of parameters to pass to the workflow"),
  }),
  execute: async ({ slug, parameters = "{}" }) => {
    const agent = agentContext.getStore();
    if (!agent) {
      throw new Error("No agent found");
    }

    try {
      // Retrieve all memos and find the matching workflow
      const allMemos = await agent.sql<{
        slug: string;
        content: string;
        headers: string;
      }>`
        SELECT slug, content, headers FROM memos
      `;
      
      // Find the specific workflow
      const workflows = allMemos.filter(memo => {
        try {
          const headers = JSON.parse(memo.headers);
          return memo.slug === slug;
        } catch {
          return false;
        }
      });

      if (workflows.length === 0) {
        return `Error: Workflow '${slug}' not found.`;
      }

      const workflow = workflows[0];
      let headers = {};
      try {
        headers = JSON.parse(workflow.headers);
      } catch (e) {
        console.error("Error parsing workflow headers:", e);
      }

      // Verify this is actually a workflow
      if (headers.type !== WORKFLOW_TYPE) {
        return `Error: '${slug}' is not a workflow.`;
      }

      // Parse parameters
      let workflowParams = {};
      try {
        workflowParams = JSON.parse(parameters);
      } catch (e) {
        console.error("Error parsing workflow parameters:", e);
        return `Error: Invalid parameters JSON format.`;
      }

      // Return detailed instructions for the LLM with the workflow content
      return `# Executing Workflow: ${headers.title || slug}

${headers.description ? `**Description**: ${headers.description}\n\n` : ''}

## Workflow Instructions

${workflow.content}

## How to Execute This Workflow

1. Read through the entire workflow to understand the process
2. Execute each step in order, using appropriate tools when needed
3. For each step, clearly indicate what you're doing and the result
4. Use any parameters provided: ${parameters !== '{}' ? parameters : 'No parameters provided'}
5. If a step requires user input, clearly ask for it
6. At the end, provide a summary of what was accomplished

I'll now begin executing this workflow step by step.`;
    } catch (error) {
      console.error("Error executing workflow:", error);
      return `Error executing workflow: ${error}`;
    }
  },
});

/**
 * Creates a workflow from the current conversation
 */
const saveWorkflow = tool({
  description: "Save the current conversation as a reusable workflow",
  parameters: z.object({
    slug: z.string().describe("A unique identifier for the workflow (URL-friendly)"),
    title: z.string().describe("A title for the workflow"),
    description: z.string().optional().describe("A description of what the workflow does"),
    start_message_id: z.string().optional().describe("Optional ID of the first message to include"),
    end_message_id: z.string().optional().describe("Optional ID of the last message to include"),
  }),
  execute: async ({ slug, title, description = "", start_message_id, end_message_id }) => {
    const agent = agentContext.getStore();
    if (!agent) {
      throw new Error("No agent found");
    }

    try {
      // Filter messages if start/end IDs are provided
      let messagesToInclude = agent.messages;
      if (start_message_id) {
        const startIndex = messagesToInclude.findIndex(m => m.id === start_message_id);
        if (startIndex !== -1) {
          messagesToInclude = messagesToInclude.slice(startIndex);
        }
      }
      if (end_message_id) {
        const endIndex = messagesToInclude.findIndex(m => m.id === end_message_id);
        if (endIndex !== -1) {
          messagesToInclude = messagesToInclude.slice(0, endIndex + 1);
        }
      }

      // Format messages into a workflow structure
      const workflowSteps = messagesToInclude
        .filter(m => m.role === "user" || m.role === "assistant")
        .map((m, index) => {
          const rolePrefix = m.role === "user" ? "Input" : "AI Action";
          return `## Step ${index + 1}: ${rolePrefix}\n\n${m.content}\n`;
        })
        .join("\n");

      // Create workflow content
      const workflowContent = `# ${title}\n\n${description ? description + '\n\n' : ''}${workflowSteps}`;

      // Create headers with workflow type
      const headers = JSON.stringify({
        type: WORKFLOW_TYPE,
        title,
        description
      });

      // Instead of trying to import the memo tool, we'll directly use SQL to save the memo
      // This avoids circular dependency issues
      const now = new Date().toISOString();
      const id = Math.random().toString(36).substring(2, 15); // Simple ID generation
      
      // Initialize with empty links - backlinks will be processed separately
      const initialLinks = JSON.stringify({ incoming: [], outgoing: [] });
      
      // Insert the workflow memo directly
      await agent.sql`
        INSERT INTO memos (id, slug, content, headers, links, created, modified)
        VALUES (${id}, ${slug}, ${workflowContent}, ${headers}, ${initialLinks}, ${now}, ${now})
      `;

      return `Workflow saved successfully: ${slug}`;
    } catch (error) {
      console.error("Error saving workflow:", error);
      return `Error saving workflow: ${error}`;
    }
  },
});

/**
 * Export all workflow-related tools
 */
export const workflowTools = {
  listWorkflows,
  executeWorkflow,
  saveWorkflow,
};