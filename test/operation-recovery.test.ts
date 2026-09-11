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

async function git(repositoryPath: string, ...args: string[]): Promise<void> {
  await execFile("git", ["-C", repositoryPath, ...args]);
}

test("marks unfinished journal operations for recovery when the server restarts", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "traceandback-recovery-"));
  const repositoryPath = join(fixtureRoot, "repository");
  const databasePath = join(fixtureRoot, "trace.db");
  const firstStore = new SqliteTraceStore(databasePath);

  try {
    await git(fixtureRoot, "init", "--initial-branch=main", "repository");
    await git(repositoryPath, "config", "user.name", "Trace Test");
    await git(repositoryPath, "config", "user.email", "trace@example.test");
    await writeFile(join(repositoryPath, "README.md"), "base\n", "utf8");
    await git(repositoryPath, "add", "README.md");
    await git(repositoryPath, "commit", "-m", "feat: base");

    const firstService = new TraceService({
      git: new GitCli(),
      locks: new RepositoryLockManager(),
      store: firstStore
    });
    const repository = await firstService.registerRepository({ repositoryPath });
    await writeFile(join(repositoryPath, "README.md"), "recovered\n", "utf8");
    const interruptedCommit = await new GitCli().createCheckpoint({
      operationId: "interrupted-checkpoint",
      reason: "interrupted",
      repositoryPath
    });

    firstStore.createOperation({
      id: "interrupted-checkpoint",
      repositoryId: repository.id,
      operationType: "checkpoint",
      intent: null,
      result: null,
      state: "GIT_APPLIED",
      recovery: null,
      createdAt: "2026-09-11T00:00:00.000Z"
    });
    firstStore.createOperation({
      id: "prepared-resume",
      repositoryId: repository.id,
      operationType: "resume",
      intent: null,
      result: null,
      state: "PREPARED",
      recovery: null,
      createdAt: "2026-09-11T00:01:00.000Z"
    });
    firstStore.close();

    const restartedStore = new SqliteTraceStore(databasePath);
    try {
      const restartedService = new TraceService({
        git: new GitCli(),
        locks: new RepositoryLockManager(),
        store: restartedStore
      });
      const marked = await restartedService.recoverUnfinishedOperations();
      assert.deepEqual(marked.map((operation) => ({ id: operation.id, state: operation.state })), [
        { id: "interrupted-checkpoint", state: "COMPLETED" },
        { id: "prepared-resume", state: "RECOVERY_REQUIRED" }
      ]);
      const recoveredCheckpoint = marked.find((operation) => operation.id === "interrupted-checkpoint");
      if (
        recoveredCheckpoint === undefined ||
        recoveredCheckpoint.result === null ||
        !("commit" in recoveredCheckpoint.result)
      ) {
        throw new Error("Checkpoint recovery did not return its original result.");
      }
      assert.equal(recoveredCheckpoint.result.commit, interruptedCommit);
      const history = restartedService.getHistory({
        repositoryId: repository.id,
        limit: 10,
        cursor: null
      });
      assert.equal(history.nodes.length, 1);
      assert.equal(history.nodes[0]?.commit, interruptedCommit);


      const retried = await restartedService.createCheckpoint({
        operationId: "interrupted-checkpoint",
        reason: "retry",
        repositoryId: repository.id
      });
      assert.deepEqual(retried, recoveredCheckpoint.result);
    } finally {
      restartedStore.close();
    }
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});
