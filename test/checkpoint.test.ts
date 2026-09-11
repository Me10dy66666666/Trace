import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, before, test } from "node:test";

import { TraceService } from "../src/application/trace-service.js";
import { GitCli } from "../src/infrastructure/git-cli.js";
import { RepositoryLockManager } from "../src/infrastructure/repository-lock-manager.js";
import { SqliteTraceStore } from "../src/infrastructure/sqlite-trace-store.js";

const execFile = promisify(execFileCallback);

class RecordingTraceStore extends SqliteTraceStore {
  public readonly persistedPhases: string[] = [];

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
      this.persistedPhases.push(operation.state);
    }
  }
}

async function git(repositoryPath: string, ...args: string[]): Promise<string> {
  const result = await execFile("git", ["-C", repositoryPath, ...args]);
  return result.stdout;
}

let fixtureRoot: string;
let repositoryPath: string;
let databasePath: string;

before(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "traceandback-checkpoint-"));
  repositoryPath = join(fixtureRoot, "repository");
  databasePath = join(fixtureRoot, "trace.db");

  await git(fixtureRoot, "init", "--initial-branch=main", "repository");
  await git(repositoryPath, "config", "user.name", "Trace Test");
  await git(repositoryPath, "config", "user.email", "trace@example.test");
  await writeFile(join(repositoryPath, "README.md"), "base\n", "utf8");
  await git(repositoryPath, "add", "README.md");
  await git(repositoryPath, "commit", "-m", "feat: initial fixture");
});

after(async () => {
  await rm(fixtureRoot, { force: true, recursive: true });
});

test("checkpoints all visible working-tree changes and returns the original result for a retried operation", async () => {
  const store = new RecordingTraceStore(databasePath);
  const service = new TraceService({
    git: new GitCli(),
    locks: new RepositoryLockManager(),
    store
  });

  try {
    const repository = await service.registerRepository({ repositoryPath });
    await writeFile(join(repositoryPath, "README.md"), "staged change\n", "utf8");
    await git(repositoryPath, "add", "README.md");
    await writeFile(join(repositoryPath, "README.md"), "unstaged follow-up\n", "utf8");
    await writeFile(join(repositoryPath, "draft.txt"), "untracked change\n", "utf8");

    const first = await service.createCheckpoint({
      operationId: "checkpoint-retry-key",
      reason: "before_resume",
      repositoryId: repository.id
    });
    const second = await service.createCheckpoint({
      operationId: "checkpoint-retry-key",
      reason: "before_resume",
      repositoryId: repository.id
    });

    assert.equal(first.created, true);
    assert.deepEqual(store.persistedPhases, ["PREPARED", "GIT_APPLIED", "DB_APPLIED", "VERIFIED"]);
    assert.equal(first.recoverable, true);
    assert.ok(first.commit);
    assert.ok(first.nodeId);
    assert.equal(second.commit, first.commit);
    assert.equal(second.nodeId, first.nodeId);
    assert.match(first.commit, /^[0-9a-f]{40}$/);

    const changedFiles = await git(repositoryPath, "show", "--format=", "--name-only", first.commit);
    assert.match(changedFiles, /README\.md/);
    assert.match(changedFiles, /draft\.txt/);

    const checkpointMessage = await git(repositoryPath, "show", "-s", "--format=%B", first.commit);
    assert.match(checkpointMessage, /TraceAndBack-Operation: checkpoint-retry-key/);

    const status = await service.getStatus({ repositoryId: repository.id });
    assert.equal(status.dirty, false);
  } finally {
    store.close();
  }
});
