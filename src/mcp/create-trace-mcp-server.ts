import { randomUUID } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { TraceError } from "../domain/errors.js";
import type { TraceService } from "../application/trace-service.js";

type JsonObject = Readonly<Record<string, unknown>>;

function success(value: JsonObject) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value
  };
}

function failure(error: unknown) {
  const value: JsonObject = error instanceof TraceError
    ? {
        code: error.code,
        message: error.message,
        recoverable: error.recoverable,
        details: error.details
      }
    : {
        code: "DATABASE_ERROR",
        message: "TraceAndBack could not complete the requested operation.",
        recoverable: true,
        details: {}
      };
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value
  };
}

async function execute(operation: () => Promise<JsonObject> | JsonObject) {
  try {
    return success(await operation());
  } catch (error) {
    return failure(error);
  }
}

function operationId(value: string | undefined): string {
  return value ?? `op_${randomUUID()}`;
}

export function createTraceMcpServer(trace: TraceService): McpServer {
  const server = new McpServer({ name: "traceandback", version: "0.1.0" });

  server.registerTool(
    "trace.get_status",
    {
      title: "Get TraceAndBack status",
      description: "Inspect a local Git repository and return its registered TraceAndBack identity and safe status.",
      inputSchema: z.object({ repository: z.string().min(1) }),
      annotations: { readOnlyHint: true }
    },
    async ({ repository }) => execute(async () => {
      const registered = await trace.registerRepository({ repositoryPath: repository });
      return await trace.getStatus({ repositoryId: registered.id });
    })
  );

  server.registerTool(
    "trace.get_history",
    {
      title: "Get Trace history",
      description: "Return a repository's Trace timeline in reverse chronological order.",
      inputSchema: z.object({
        repositoryId: z.string().min(1),
        limit: z.number().int().min(1).max(100).default(50),
        cursor: z.string().nullable().default(null)
      }),
      annotations: { readOnlyHint: true }
    },
    async ({ repositoryId, limit, cursor }) => execute(() => trace.getHistory({ repositoryId, limit, cursor }))
  );

  server.registerTool(
    "trace.get_node",
    {
      title: "Get Trace Node",
      description: "Return a Trace Node's code-backed detail, changed files, and parent relations.",
      inputSchema: z.object({ nodeId: z.string().min(1) }),
      annotations: { readOnlyHint: true }
    },
    async ({ nodeId }) => execute(() => trace.getNode({ nodeId }))
  );

  server.registerTool(
    "trace.compare",
    {
      title: "Compare Trace Nodes",
      description: "Compare two Trace Nodes from the same repository through their verified Git commits.",
      inputSchema: z.object({
        fromNode: z.string().min(1),
        toNode: z.string().min(1)
      }),
      annotations: { readOnlyHint: true }
    },
    async ({ fromNode, toNode }) => execute(() => trace.compare({ fromNode, toNode }))
  );

  server.registerTool(
    "trace.create_checkpoint",
    {
      title: "Create checkpoint",
      description: "Safely commit visible working-tree changes as a recoverable local Trace Node.",
      inputSchema: z.object({
        repositoryId: z.string().min(1),
        reason: z.string().trim().min(1).default("automatic checkpoint"),
        includeUntracked: z.literal(true).default(true),
        operationId: z.string().min(1).optional()
      }),
      annotations: { destructiveHint: false }
    },
    async ({ repositoryId, reason, operationId: requestedOperationId }) => execute(() => trace.createCheckpoint({
      operationId: operationId(requestedOperationId),
      reason,
      repositoryId
    }))
  );

  server.registerTool(
    "trace.resume_from",
    {
      title: "Continue from Trace Node",
      description: "Create a separate verified worktree from a historical Trace Node without rewriting the current branch.",
      inputSchema: z.object({
        nodeId: z.string().min(1),
        strategy: z.literal("worktree").default("worktree"),
        checkpointCurrent: z.boolean().default(true),
        operationId: z.string().min(1).optional()
      }),
      annotations: { destructiveHint: false }
    },
    async ({ nodeId, checkpointCurrent, operationId: requestedOperationId }) => execute(() => trace.resumeFrom({
      operationId: operationId(requestedOperationId),
      nodeId,
      checkpointCurrent
    }))
  );

  server.registerTool(
    "trace.attach_conversation",
    {
      title: "Attach conversation",
      description: "Attach a local provider and conversation reference to an active Trace Session.",
      inputSchema: z.object({
        sessionId: z.string().min(1),
        provider: z.string().min(1),
        conversationId: z.string().min(1),
        operationId: z.string().min(1).optional()
      }),
      annotations: { destructiveHint: false }
    },
    async ({ sessionId, provider, conversationId, operationId: requestedOperationId }) => execute(() => trace.attachConversation({
      operationId: operationId(requestedOperationId),
      sessionId,
      provider,
      conversationId
    }))
  );

  return server;
}
