import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
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

async function git(repositoryPath: string, ...args: string[]): Promise<string> {
  const result = await execFile("git", ["-C", repositoryPath, ...args]);
  return result.stdout;
}

test("continues from a historical Trace Node in a separate worktree after preserving dirty current work", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "traceandback-resume-"));
  const repositoryPath = join(fixtureRoot, "repository");
  const databasePath = join(fixtureRoot, "trace.db");
  const store = new RecordingTraceStore(databasePath);

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

    await writeFile(join(repositoryPath, "README.md"), "historic target\n", "utf8");
    const targetCheckpoint = await service.createCheckpoint({
      operationId: "target-checkpoint",
      reason: "historic_target",
      repositoryId: repository.id
    });
    assert.ok(targetCheckpoint.nodeId);
    assert.ok(targetCheckpoint.commit);

    await writeFile(join(repositoryPath, "main-only.txt"), "later main history\n", "utf8");
    await git(repositoryPath, "add", "main-only.txt");
    await git(repositoryPath, "commit", "-m", "feat: later main history");
    const mainHeadBeforeResume = (await git(repositoryPath, "rev-parse", "HEAD")).trim();
    await writeFile(join(repositoryPath, "draft.txt"), "current unsaved work\n", "utf8");

    const result = await service.resumeFrom({
      checkpointCurrent: true,
      nodeId: targetCheckpoint.nodeId,
      operationId: "resume-operation"
    });
    assert.deepEqual(
      store.persistedPhases.filter((phase) => phase.operationId === "resume-operation").map((phase) => phase.state),
      ["PREPARED", "GIT_APPLIED", "DB_APPLIED", "VERIFIED"]
    );


    assert.equal(result.sourceNode, targetCheckpoint.nodeId);
    assert.ok(result.checkpointNode);
    assert.match(result.newBranch, /^trace\//);
    assert.ok(result.sessionId);
    await access(result.worktreePath);

    const session = store.getSession(result.sessionId);
    assert.equal(session?.repositoryId, repository.id);
    assert.equal(session?.baseNodeId, targetCheckpoint.nodeId);
    assert.equal(session?.sourceNodeId, targetCheckpoint.nodeId);
    assert.equal(session?.branch, result.newBranch);
    assert.equal(session?.worktreePath, result.worktreePath);
    assert.equal(session?.status, "active");

    const worktreeHead = (await git(result.worktreePath, "rev-parse", "HEAD")).trim();
    const currentHead = (await git(repositoryPath, "rev-parse", "HEAD")).trim();
    assert.equal(worktreeHead, targetCheckpoint.commit);
    assert.notEqual(currentHead, targetCheckpoint.commit);
    assert.notEqual(currentHead, mainHeadBeforeResume);

    const currentStatus = await service.getStatus({ repositoryId: repository.id });
    assert.equal(currentStatus.branch, "main");
    assert.equal(currentStatus.dirty, false);
  } finally {
    store.close();
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});
