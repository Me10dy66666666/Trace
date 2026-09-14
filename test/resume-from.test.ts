import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
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
      operationId: "resume-operation",
      strategy: "worktree"
    });
    assert.deepEqual(
      store.persistedPhases.filter((phase) => phase.operationId === "resume-operation").map((phase) => phase.state),
      ["PREPARED", "GIT_APPLIED", "DB_APPLIED", "VERIFIED"]
    );


    assert.equal(result.sourceNode, targetCheckpoint.nodeId);
    assert.ok(result.checkpointNode);
    assert.match(result.newBranch, /^trace\//);
    assert.ok(result.sessionId);
    assert.equal(result.hostHandoff.status, "host_action_required");
    assert.equal(result.hostHandoff.branchCheckout, "exclusive_worktree");
    assert.equal(result.hostHandoff.requiresHostAction, true);
    assert.equal(result.strategy, "worktree");
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

test("continues from a historical Trace Node by checking out a new branch in the current worktree", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "traceandback-branch-resume-"));
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

    await writeFile(join(repositoryPath, "README.md"), "historic target\n", "utf8");
    const targetCheckpoint = await service.createCheckpoint({
      operationId: "branch-target",
      reason: "historic_target",
      repositoryId: repository.id
    });
    assert.ok(targetCheckpoint.nodeId);
    assert.ok(targetCheckpoint.commit);

    await writeFile(join(repositoryPath, "main-only.txt"), "later main history\n", "utf8");
    await git(repositoryPath, "add", "main-only.txt");
    await git(repositoryPath, "commit", "-m", "feat: later main history");
    const mainHeadBeforeResume = (await git(repositoryPath, "rev-parse", "HEAD")).trim();

    const result = await service.resumeFrom({
      checkpointCurrent: false,
      nodeId: targetCheckpoint.nodeId,
      operationId: "branch-resume"
    });

    assert.equal(result.strategy, "branch");
    assert.equal(result.worktreePath, repositoryPath);
    assert.equal(result.checkpointNode, null);
    assert.equal(result.hostHandoff.status, "user_action_required");
    assert.equal(result.hostHandoff.branchCheckout, "current_worktree");
    assert.equal(result.hostHandoff.requiresHostAction, false);
    assert.equal((await git(repositoryPath, "branch", "--show-current")).trim(), result.newBranch);
    assert.equal((await git(repositoryPath, "rev-parse", "HEAD")).trim(), targetCheckpoint.commit);
    assert.equal((await git(repositoryPath, "rev-parse", "main")).trim(), mainHeadBeforeResume);
    assert.doesNotMatch(await git(repositoryPath, "worktree", "list", "--porcelain"), /\.traceandback-worktrees/);

    const status = await service.getStatus({ repositoryId: repository.id });
    assert.equal(status.branch, result.newBranch);
    assert.equal(status.dirty, false);
  } finally {
    store.close();
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

test("refuses current-worktree resume until the user saves dirty work", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "traceandback-dirty-branch-resume-"));
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

    await writeFile(join(repositoryPath, "README.md"), "historic target\n", "utf8");
    const targetCheckpoint = await service.createCheckpoint({
      operationId: "dirty-branch-target",
      reason: "historic_target",
      repositoryId: repository.id
    });
    assert.ok(targetCheckpoint.nodeId);
    const targetNodeId = targetCheckpoint.nodeId;

    await writeFile(join(repositoryPath, "main-only.txt"), "later main history\n", "utf8");
    await git(repositoryPath, "add", "main-only.txt");
    await git(repositoryPath, "commit", "-m", "feat: later main history");
    const branchBefore = (await git(repositoryPath, "branch", "--show-current")).trim();
    const headBefore = (await git(repositoryPath, "rev-parse", "HEAD")).trim();
    await writeFile(join(repositoryPath, "draft.txt"), "current unsaved work\n", "utf8");

    await assert.rejects(
      () => service.resumeFrom({
        checkpointCurrent: true,
        nodeId: targetNodeId,
        operationId: "dirty-branch-resume",
        strategy: "branch"
      }),
      (error: unknown) =>
        error instanceof TraceError &&
        error.code === "DIRTY_WORKTREE" &&
        error.message.includes("先提交或保存")
    );

    assert.equal((await git(repositoryPath, "branch", "--show-current")).trim(), branchBefore);
    assert.equal((await git(repositoryPath, "rev-parse", "HEAD")).trim(), headBefore);
    assert.equal((await service.getStatus({ repositoryId: repository.id })).dirty, true);
    assert.equal(store.getOperation("dirty-branch-resume"), null);
  } finally {
    store.close();
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});
