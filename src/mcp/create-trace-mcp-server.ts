import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { TraceError } from "../domain/errors.js";
import type { TraceService } from "../application/trace-service.js";

type JsonObject = Readonly<Record<string, unknown>>;

export const TRACE_GRAPH_UI_URI = "ui://traceandback/trace-graph-v2.html";
const TRACE_GRAPH_UI_MIME = "text/html;profile=mcp-app";
const TRACE_GRAPH_UI_FILE = new URL("./trace-graph-app.html", import.meta.url);

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
function diffStats(changedFiles: readonly Readonly<{ additions: number; deletions: number }>[]) {
  return changedFiles.reduce(
    (totals, file) => ({
      additions: totals.additions + file.additions,
      deletions: totals.deletions + file.deletions
    }),
    { additions: 0, deletions: 0 }
  );
}

function buildChangeSummary(
  detail: Readonly<{
    summary: string;
    changedFiles: readonly Readonly<{ path: string; additions: number; deletions: number }>[];
  }>
): string {
  if (detail.changedFiles.length === 0) {
    return `${detail.summary}；此版本没有检测到文件差异。`;
  }
  const paths = detail.changedFiles.slice(0, 4).map((file) => file.path).join("、");
  const suffix = detail.changedFiles.length > 4 ? " 等" : "";
  const stats = diffStats(detail.changedFiles);
  return `${detail.summary}；涉及 ${detail.changedFiles.length} 个文件（+${stats.additions}/-${stats.deletions} 行）：${paths}${suffix}。`;
}

async function buildTraceGraph(
  trace: TraceService,
  input: Readonly<{
    repositoryId?: string;
    repository?: string;
    limit: number;
    cursor: string | null;
  }>
): Promise<JsonObject> {
  const registered = input.repositoryId === undefined
    ? await trace.registerRepository({ repositoryPath: input.repository ?? process.cwd() })
    : null;
  const selectedRepositoryId = input.repositoryId ?? registered?.id;
  if (selectedRepositoryId === undefined) {
    throw new TraceError(
      "REPO_NOT_REGISTERED",
      "Trace Graph needs a registered repository.",
      true
    );
  }

  const [status, history] = await Promise.all([
    trace.getStatus({ repositoryId: selectedRepositoryId }),
    trace.getGitHistory({
      repositoryId: selectedRepositoryId,
      limit: input.limit
    })
  ]);
  const historyById = new Map(history.nodes.map((node) => [node.id, node]));
  const nodes = await Promise.all(history.nodes.map(async (historyNode, index) => {
    const detail = await trace.getNode({ nodeId: historyNode.id });
    const parentNode = historyNode.gitParent === null
      ? null
      : historyById.get(historyNode.gitParent) ?? null;
    const stats = diffStats(detail.changedFiles);
    const decisions = detail.decisions
      .map((decision) => `${decision.title}: ${decision.reason}`)
      .join("；");
    return {
      id: historyNode.id,
      type: "version",
      title: historyNode.title,
      meta: historyNode.createdAt,
      createdAt: historyNode.createdAt,
      commit: historyNode.commit,
      parent: parentNode?.commit ?? "—",
      parentNodeId: historyNode.gitParent,
      gitParent: historyNode.gitParent,
      chronologicalParent: historyNode.chronologicalParent,
      goal: detail.goal,
      changes: buildChangeSummary(detail),
      summary: detail.summary,
      conversationSummary: detail.conversationStatus === "available"
        ? detail.summary
        : "暂无已关联的 AI 对话总结。",
      decisions: decisions || "未记录关键决策。",
      changedFiles: detail.changedFiles,
      files: `${detail.changedFiles.length} changed files`,
      diffStats: `+${stats.additions} / -${stats.deletions} lines`,
      warnings: detail.conversationStatus === "available"
        ? "无"
        : "暂无已关联 AI 对话总结",
      conversationStatus: detail.conversationStatus,
      round: `Version ${String(history.nodes.length - index).padStart(2, "0")}`
    };
  }));

  const gitEdges = history.nodes.flatMap((node) => (
    node.gitParent !== null && historyById.has(node.gitParent)
      ? [[node.gitParent, node.id]]
      : []
  ));
  const chronologyEdges = history.nodes.flatMap((node) => (
    node.chronologicalParent !== null && historyById.has(node.chronologicalParent)
      ? [[node.chronologicalParent, node.id]]
      : []
  ));
  const repositoryPath = registered?.repositoryPath ?? input.repository ?? null;
  const name = repositoryPath === null ? selectedRepositoryId : basename(repositoryPath);

  return {
    repository: {
      id: selectedRepositoryId,
      path: repositoryPath
    },
    status,
    graph: {
      name,
      branch: status.branch ?? "detached HEAD",
      status: status.dirty ? "working tree dirty" : "working tree clean",
      nodes,
      gitEdges,
      chronologyEdges,
      nextCursor: history.nextCursor
    }
  };
}

export function createTraceMcpServer(trace: TraceService): McpServer {
  const server = new McpServer({ name: "traceandback", version: "0.1.0" });

  server.registerResource(
    "trace-graph",
    TRACE_GRAPH_UI_URI,
    {
      title: "TraceAndBack project Trace Graph",
      description: "Interactive, project-scoped version graph for inspecting and safely resuming Git history.",
      mimeType: TRACE_GRAPH_UI_MIME
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: TRACE_GRAPH_UI_MIME,
          text: await readFile(TRACE_GRAPH_UI_FILE, "utf8"),
          _meta: { ui: { prefersBorder: true } }
        }
      ]
    })
  );

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
    "trace.render_graph",
    {
      title: "Open Trace Graph",
      description: "Render the current repository's project-scoped Trace Graph. Use this after fetching or when the user asks to open Trace.",
      inputSchema: z.object({
        repositoryId: z.string().min(1).optional(),
        repository: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(100).default(50),
        cursor: z.string().nullable().default(null)
      }),
      annotations: { readOnlyHint: true },
      _meta: {
        ui: { resourceUri: TRACE_GRAPH_UI_URI },
        "openai/toolInvocation/invoking": "Opening Trace Graph…",
        "openai/toolInvocation/invoked": "Trace Graph ready"
      }
    },
    async ({ repositoryId, repository, limit, cursor }) => execute(() => buildTraceGraph(trace, {
      repositoryId,
      repository,
      limit,
      cursor
    }))
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
