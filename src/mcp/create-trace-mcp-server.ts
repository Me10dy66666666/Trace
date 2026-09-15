import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { TraceError } from "../domain/errors.js";
import type { TraceService } from "../application/trace-service.js";
import type { WorkTraceSummary } from "../domain/work-trace-summary.js";
import { workTraceSummarySchema } from "../domain/work-trace-summary.js";

type JsonObject = Readonly<Record<string, unknown>>;

export const TRACE_GRAPH_UI_URI = "ui://traceandback/trace-graph-v2.html";
const TRACE_GRAPH_OPENAI_UI_URI = "ui://traceandback/trace-graph-launcher.html";
const TRACE_GRAPH_OPENAI_UI_MIME = "text/html+skybridge";
const TRACE_GRAPH_UI_MIME = "text/html;profile=mcp-app";
const TRACE_GRAPH_LAUNCHER_FILE = new URL("./trace-graph-launcher.html", import.meta.url);
const TRACE_GRAPH_BROWSER_URL_PLACEHOLDER = "__TRACEANDBACK_BROWSER_URL__";

export type TraceMcpServerOptions = Readonly<{
  browserUrl: string;
  repository?: string;
}>;

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

function workSummaryText(summary: WorkTraceSummary | undefined): string {
  if (summary === undefined) {
    return "暂无已关联的 AI 对话总结。";
  }
  const parts = [
    summary.title,
    summary.outcomes.length > 0 ? "结果：" + summary.outcomes.join("；") : undefined,
    summary.unresolved.length > 0 ? "未完成：" + summary.unresolved.join("；") : undefined
  ].filter((part): part is string => typeof part === "string" && part.length > 0);
  return parts.join("；") || "已保存结构化协作总结。";
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

export async function buildTraceGraph(
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
  const selectedRepositoryPath = input.repository ?? registered?.repositoryPath;

  const [status, history] = await Promise.all([
    trace.getStatus({
      repositoryId: selectedRepositoryId,
      repositoryPath: selectedRepositoryPath
    }),
    trace.getGitHistory({
      repositoryId: selectedRepositoryId,
      limit: input.limit,
      repositoryPath: selectedRepositoryPath
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
      conversationSummary: workSummaryText(detail.workSummary),
      workSummary: detail.workSummary ?? null,
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

function withBrowserLaunch(value: JsonObject, browserUrl: string): JsonObject {
  const repository = value.repository;
  const repositoryPath = repository !== null && typeof repository === "object" && !Array.isArray(repository)
    ? (repository as JsonObject).path
    : undefined;
  const url = new URL(browserUrl);
  if (typeof repositoryPath === "string" && repositoryPath.length > 0) {
    url.searchParams.set("repository", repositoryPath);
  }
  return {
    ...value,
    browser: {
      action: "open_in_codex",
      target: "browser",
      url: url.href
    }
  };
}

export function createTraceMcpServer(trace: TraceService, options: TraceMcpServerOptions): McpServer {
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
          text: (await readFile(TRACE_GRAPH_LAUNCHER_FILE, "utf8")).replace(
            TRACE_GRAPH_BROWSER_URL_PLACEHOLDER,
            options.browserUrl
          ),
          _meta: { ui: { prefersBorder: true }, "openai/widgetPrefersBorder": true }
        }
      ]
    })
  );

  server.registerResource(
    "trace-graph-openai",
    TRACE_GRAPH_OPENAI_UI_URI,
    {
      title: "TraceAndBack project Trace Graph launcher",
      description: "Compatibility launcher that opens the full Trace Graph in the host browser.",
      mimeType: TRACE_GRAPH_OPENAI_UI_MIME
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: TRACE_GRAPH_OPENAI_UI_MIME,
          text: (await readFile(TRACE_GRAPH_LAUNCHER_FILE, "utf8")).replace(
            TRACE_GRAPH_BROWSER_URL_PLACEHOLDER,
            options.browserUrl
          ),
          _meta: { "openai/widgetPrefersBorder": true }
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
      return await trace.getStatus({
        repositoryId: registered.id,
        repositoryPath: repository
      });
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
    "trace.start",
    {
      title: "Start Trace Graph",
      description: "Direct command: render the current project's Trace Graph and return browser.url. The host browser adapter must immediately open that URL with open_in_codex; call without follow-up questions.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
      _meta: {
        ui: { resourceUri: TRACE_GRAPH_UI_URI },
        "openai/outputTemplate": TRACE_GRAPH_OPENAI_UI_URI,
        "openai/toolInvocation/invoking": "Starting Trace Graph…",
        "openai/toolInvocation/invoked": "Trace Graph ready"
      }
    },
    async () => execute(async () => withBrowserLaunch(
      await buildTraceGraph(trace, {
        repository: options.repository ?? process.cwd(),
        limit: 50,
        cursor: null
      }),
      options.browserUrl
    ))
  );

  server.registerTool(
    "trace.render_graph",
    {
      title: "Open Trace Graph",
      description: "Render the current repository's project-scoped Trace Graph. Use trace.start for the direct no-argument startup command.",
      inputSchema: z.object({
        repositoryId: z.string().min(1).optional(),
        repository: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(100).default(50),
        cursor: z.string().nullable().default(null)
      }),
      annotations: { readOnlyHint: true },
      _meta: {
        ui: { resourceUri: TRACE_GRAPH_UI_URI },
        "openai/outputTemplate": TRACE_GRAPH_OPENAI_UI_URI,
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
      repositoryId,
      repositoryPath: options.repository
    }))
  );

  server.registerTool(
    "trace.resume_from",
    {
      title: "Continue from Trace Node",
      description: "Create a new trace branch and check the historical Trace Node out in the current project worktree. The current worktree must be clean; the existing branch is preserved. Use strategy=worktree explicitly when a separate verified worktree is required.",
      inputSchema: z.object({
        nodeId: z.string().min(1),
        strategy: z.enum(["branch", "worktree"]).default("branch"),
        checkpointCurrent: z.boolean().default(true),
        operationId: z.string().min(1).optional()
      }),
      annotations: { destructiveHint: false }
    },
    async ({ nodeId, strategy, checkpointCurrent, operationId: requestedOperationId }) => execute(() => trace.resumeFrom({
      operationId: operationId(requestedOperationId),
      nodeId,
      checkpointCurrent,
      strategy,
      repositoryPath: options.repository
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

  server.registerTool(
    "trace_finalize_session",
    {
      title: "Finalize Trace Session",
      description: "Persist a host-generated WorkTraceSummary for a Trace Session without exporting the raw conversation.",
      inputSchema: z.object({
        project_id: z.string().min(1),
        session_id: z.string().min(1),
        commit_oid: z.string().min(4).optional(),
        node_id: z.string().min(1).optional(),
        work_summary: workTraceSummarySchema,
        conversation_mode: z.enum(["summary-only", "summary+refs", "full"]).default("summary-only"),
        operation_id: z.string().min(1).optional()
      }),
      annotations: { destructiveHint: false }
    },
    async ({ project_id, session_id, commit_oid, node_id, work_summary, conversation_mode, operation_id }) => execute(() => trace.finalizeSession({
      projectId: project_id,
      sessionId: session_id,
      commitOid: commit_oid,
      nodeId: node_id,
      workSummary: work_summary,
      conversationMode: conversation_mode,
      operationId: operation_id
    }))
  );

  server.registerTool(
    "trace_finalize_commit",
    {
      title: "Finalize Trace Commit",
      description: "Persist a host-generated WorkTraceSummary for a verified commit, creating its Trace Node when needed.",
      inputSchema: z.object({
        project_id: z.string().min(1),
        commit_oid: z.string().min(4),
        node_id: z.string().min(1).optional(),
        session_id: z.string().min(1).optional(),
        work_summary: workTraceSummarySchema,
        conversation_mode: z.enum(["summary-only", "summary+refs", "full"]).default("summary-only"),
        operation_id: z.string().min(1).optional()
      }),
      annotations: { destructiveHint: false }
    },
    async ({ project_id, commit_oid, node_id, session_id, work_summary, conversation_mode, operation_id }) => execute(() => trace.finalizeCommit({
      projectId: project_id,
      commitOid: commit_oid,
      nodeId: node_id,
      sessionId: session_id,
      workSummary: work_summary,
      conversationMode: conversation_mode,
      operationId: operation_id
    }))
  );

  server.registerTool(
    "trace_update_summary",
    {
      title: "Update Trace Summary",
      description: "Replace the structured WorkTraceSummary for an existing Trace Node.",
      inputSchema: z.object({
        project_id: z.string().min(1),
        node_id: z.string().min(1),
        session_id: z.string().min(1).optional(),
        commit_oid: z.string().min(4).optional(),
        work_summary: workTraceSummarySchema,
        conversation_mode: z.enum(["summary-only", "summary+refs", "full"]).default("summary-only"),
        operation_id: z.string().min(1).optional()
      }),
      annotations: { destructiveHint: false }
    },
    async ({ project_id, node_id, session_id, commit_oid, work_summary, conversation_mode, operation_id }) => execute(() => trace.updateSummary({
      projectId: project_id,
      nodeId: node_id,
      sessionId: session_id,
      commitOid: commit_oid,
      workSummary: work_summary,
      conversationMode: conversation_mode,
      operationId: operation_id
    }))
  );

  return server;
}
