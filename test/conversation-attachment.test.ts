import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

import { TraceService } from "../src/application/trace-service.js";
import { GitCli } from "../src/infrastructure/git-cli.js";
import { RepositoryLockManager } from "../src/infrastructure/repository-lock-manager.js";
import { SqliteTraceStore } from "../src/infrastructure/sqlite-trace-store.js";

const execFile = promisify(execFileCallback);

type PersistedPhase = Readonly<{ operationId: string; state: string }>;

class RecordingTraceStore extends SqliteTraceStore {
  public readonly persistedPhases: PersistedPhase[] = [];

  public override markOperationPrepared(operationId: string): void {
    super.markOperationPrepared(operationId);
    this.record(operationId);
  }

  public override markOperationGitApplied(operationId: string): void {
    super.markOperationGitApplied(operationId);
    this.record(operationId);
  }

  public override markOperationDatabaseApplied(operationId: string): void {
    super.markOperationDatabaseApplied(operationId);
    this.record(operationId);
  }

  public override markOperationVerified(operationId: string): void {
    super.markOperationVerified(operationId);
    this.record(operationId);
  }

  private record(operationId: string): void {
    const operation = this.getOperation(operationId);
    if (operation !== null) {
      this.persistedPhases.push({ operationId, state: operation.state });
    }
  }
}

async function git(repositoryPath: string, ...args: string[]): Promise<void> {
  await execFile("git", ["-C", repositoryPath, ...args]);
}

test("attaches a local conversation reference to a Trace Session idempotently", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "traceandback-conversation-"));
  const repositoryPath = join(fixtureRoot, "repository");
  const store = new RecordingTraceStore(join(fixtureRoot, "trace.db"));

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
    await writeFile(join(repositoryPath, "README.md"), "target\n", "utf8");
    const target = await service.createCheckpoint({
      operationId: "conversation-target",
      reason: "target",
      repositoryId: repository.id
    });
    assert.ok(target.nodeId);

    const resumed = await service.resumeFrom({
      checkpointCurrent: false,
      nodeId: target.nodeId,
      operationId: "conversation-resume",
      strategy: "worktree"
    });
    assert.equal((await service.getNode({ nodeId: target.nodeId })).conversationStatus, "unavailable");

    const attached = await service.attachConversation({
      operationId: "conversation-attach",
      sessionId: resumed.sessionId,
      provider: "workbuddy",
      conversationId: "conv_982"
    });
    assert.deepEqual(attached, { operationId: "conversation-attach", attached: true });
    assert.deepEqual(
      store.persistedPhases.filter((phase) => phase.operationId === "conversation-attach").map((phase) => phase.state),
      ["PREPARED", "DB_APPLIED", "VERIFIED"]
    );

    assert.equal((await service.getNode({ nodeId: target.nodeId })).conversationStatus, "available");

    const retried = await service.attachConversation({
      operationId: "conversation-attach",
      sessionId: resumed.sessionId,
      provider: "workbuddy",
      conversationId: "conv_982"
    });
    assert.deepEqual(retried, attached);
  } finally {
    store.close();
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});
