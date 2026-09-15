import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

import { TraceService } from "../src/application/trace-service.js";
import { TraceError } from "../src/domain/errors.js";
import { GitCli } from "../src/infrastructure/git-cli.js";
import { RepositoryLockManager } from "../src/infrastructure/repository-lock-manager.js";
import { SqliteTraceStore } from "../src/infrastructure/sqlite-trace-store.js";

const execFile = promisify(execFileCallback);

type WorkTraceSummaryInput = Readonly<Record<string, unknown>>;

function summary(overrides: WorkTraceSummaryInput = {}): WorkTraceSummaryInput {
  return {
    schema_version: "0.1",
    summary_mode: "conversation-first",
    title: "完成当前开发会话总结",
    user_requests: [
      {
        request: "完善 AI 总结功能",
        constraints: ["只使用宿主可见对话", "不保存原始对话"]
      }
    ],
    ai_actions: [
      {
        action: "实现结构化总结持久化",
        result: "接入 Trace Node"
      }
    ],
    decisions: [
      {
        statement: "由宿主生成总结，TraceAndBack 只负责持久化",
        made_by: "joint",
        status: "accepted"
      }
    ],
    direction_changes: [],
    outcomes: ["总结可以关联到 Trace Node"],
    unresolved: [],
    tests: [],
    affected_areas: ["conversation summary"],
    verification_notes: [],
    confidence: 0.95,
    ...overrides
  };
}

async function git(repositoryPath: string, ...args: string[]): Promise<string> {
  const result = await execFile("git", ["-C", repositoryPath, ...args]);
  return result.stdout.trim();
}

test("finalizes a host-generated session summary with redaction and idempotency", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "traceandback-summary-"));
  const repositoryPath = join(fixtureRoot, "repository");
  const store = new SqliteTraceStore(join(fixtureRoot, "trace.db"));

  try {
    await git(fixtureRoot, "init", "--initial-branch=main", "repository");
    await git(repositoryPath, "config", "user.name", "Trace Test");
    await git(repositoryPath, "config", "user.email", "trace@example.test");
    await writeFile(join(repositoryPath, "README.md"), "base\n", "utf8");
    await git(repositoryPath, "add", "README.md");
    await git(repositoryPath, "commit", "-m", "feat: base");

    const service = new TraceService({
      git: new GitCli(),
      locks: new RepositoryLockManager(),
      store
    });
    const repository = await service.registerRepository({ repositoryPath });
    await writeFile(join(repositoryPath, "README.md"), "base\nsummary\n", "utf8");
    const checkpoint = await service.createCheckpoint({
      operationId: "summary-checkpoint",
      reason: "capture_summary",
      repositoryId: repository.id
    });
    assert.ok(checkpoint.nodeId);
    assert.ok(checkpoint.commit);

    const resumed = await service.resumeFrom({
      checkpointCurrent: false,
      nodeId: checkpoint.nodeId,
      operationId: "summary-resume",
      strategy: "worktree"
    });
    const result = await service.finalizeSession({
      projectId: repository.id,
      sessionId: resumed.sessionId,
      commitOid: checkpoint.commit,
      workSummary: summary({
        verification_notes: ["authorization: Bearer secret-value", "token=secret-value"]
      }),
      conversationMode: "summary-only",
      operationId: "summary-finalize"
    });

    assert.deepEqual(result, {
      node_id: checkpoint.nodeId,
      session_id: resumed.sessionId,
      generation_status: "completed",
      stored: true
    });

    const detail = await service.getNode({ nodeId: checkpoint.nodeId });
    assert.equal(detail.conversationStatus, "available");
    assert.equal(detail.workSummary?.summary_mode, "conversation-first");
    assert.deepEqual(detail.workSummary?.verification_notes, [
      "[REDACTED]",
      "[REDACTED]"
    ]);

    const retried = await service.finalizeSession({
      projectId: repository.id,
      sessionId: resumed.sessionId,
      commitOid: checkpoint.commit,
      workSummary: summary({ title: "不同的重试内容" }),
      conversationMode: "summary-only",
      operationId: "summary-finalize"
    });
    assert.deepEqual(retried, result);
    assert.equal((await service.getNode({ nodeId: checkpoint.nodeId })).workSummary?.title, "完成当前开发会话总结");
  } finally {
    store.close();
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

test("finalizes a verified commit and creates its Trace Node when needed", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "traceandback-commit-summary-"));
  const repositoryPath = join(fixtureRoot, "repository");
  const store = new SqliteTraceStore(join(fixtureRoot, "trace.db"));

  try {
    await git(fixtureRoot, "init", "--initial-branch=main", "repository");
    await git(repositoryPath, "config", "user.name", "Trace Test");
    await git(repositoryPath, "config", "user.email", "trace@example.test");
    await writeFile(join(repositoryPath, "README.md"), "base\n", "utf8");
    await git(repositoryPath, "add", "README.md");
    await git(repositoryPath, "commit", "-m", "feat: base");
    const commit = await git(repositoryPath, "rev-parse", "HEAD");

    const service = new TraceService({
      git: new GitCli(),
      locks: new RepositoryLockManager(),
      store
    });
    const repository = await service.registerRepository({ repositoryPath });
    const result = await service.finalizeCommit({
      projectId: repository.id,
      commitOid: commit,
      workSummary: summary({ summary_mode: "code-only" }),
      operationId: "commit-summary"
    });

    assert.equal(result.session_id, null);
    assert.equal(result.generation_status, "completed");
    assert.equal(result.stored, true);
    const history = await service.getGitHistory({ repositoryId: repository.id, limit: 10 });
    const node = history.nodes.find((candidate) => candidate.commit === commit);
    assert.ok(node);
    assert.equal((await service.getNode({ nodeId: node.id })).workSummary?.summary_mode, "code-only");
  } finally {
    store.close();
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

test("rejects malformed WorkTraceSummary input before persistence", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "traceandback-invalid-summary-"));
  const repositoryPath = join(fixtureRoot, "repository");
  const store = new SqliteTraceStore(join(fixtureRoot, "trace.db"));

  try {
    await git(fixtureRoot, "init", "--initial-branch=main", "repository");
    await git(repositoryPath, "config", "user.name", "Trace Test");
    await git(repositoryPath, "config", "user.email", "trace@example.test");
    await writeFile(join(repositoryPath, "README.md"), "base\n", "utf8");
    await git(repositoryPath, "add", "README.md");
    await git(repositoryPath, "commit", "-m", "feat: base");
    const commit = await git(repositoryPath, "rev-parse", "HEAD");

    const service = new TraceService({
      git: new GitCli(),
      locks: new RepositoryLockManager(),
      store
    });
    const repository = await service.registerRepository({ repositoryPath });

    await assert.rejects(
      service.finalizeCommit({
        projectId: repository.id,
        commitOid: commit,
        workSummary: {},
        operationId: "invalid-summary"
      }),
      (error: unknown) => error instanceof TraceError && error.code === "INVALID_WORK_SUMMARY"
    );
  } finally {
    store.close();
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});