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

async function git(repositoryPath: string, ...args: string[]): Promise<string> {
  const result = await execFile("git", ["-C", repositoryPath, ...args]);
  return result.stdout;
}

test("records an orphaned Trace Session when a managed worktree survives a restart", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "traceandback-orphaned-worktree-"));
  const repositoryPath = join(fixtureRoot, "repository");
  let firstStoreClosed = false;
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
    await writeFile(join(repositoryPath, "README.md"), "historical target\n", "utf8");
    const target = await firstService.createCheckpoint({
      operationId: "orphaned-target",
      reason: "target",
      repositoryId: repository.id
    });
    if (target.nodeId === null || target.commit === null) {
      throw new Error("The fixture checkpoint must produce a Trace Node and Git commit.");
    }

    const operationId = "interrupted-resume";
    const branchName = `trace/${target.nodeId}-${operationId}`;
    const worktreeName = `node-${target.nodeId}-${operationId}`;
    const environment = await new GitCli().createWorktree({
      repositoryPath,
      targetCommit: target.commit,
      branchName,
      worktreeName
    });
    firstStore.createOperation({
      id: operationId,
      repositoryId: repository.id,
      operationType: "resume",
      intent: {
        kind: "resume",
        sourceNodeId: target.nodeId,
        targetCommit: target.commit,
        branchName,
        worktreeName
      },
      result: null,
      recovery: null,
      state: "GIT_APPLIED",
      createdAt: "2026-09-12T00:00:00.000Z"
    });
    firstStore.close();
    firstStoreClosed = true;

    const restartedStore = new SqliteTraceStore(databasePath);
    try {
      const restartedService = new TraceService({
        git: new GitCli(),
        locks: new RepositoryLockManager(),
        store: restartedStore
      });
      const recovered = await restartedService.recoverUnfinishedOperations();
      assert.equal(recovered.length, 1);
      assert.equal(recovered[0]?.state, "RECOVERY_REQUIRED");
      assert.equal(recovered[0]?.recovery?.kind, "orphaned_worktree");
      assert.equal(recovered[0]?.recovery?.worktreePath, environment.worktreePath);
      assert.equal(recovered[0]?.recovery?.branch, branchName);
      assert.equal(recovered[0]?.recovery?.sourceNodeId, target.nodeId);

      const sessionId = recovered[0]?.recovery?.sessionId;
      assert.ok(sessionId);
      const session = restartedStore.getSession(sessionId);
      assert.equal(session?.repositoryId, repository.id);
      assert.equal(session?.sourceNodeId, target.nodeId);
      assert.equal(session?.branch, branchName);
      assert.equal(session?.worktreePath, environment.worktreePath);
      assert.equal(session?.status, "orphaned");
      assert.equal(await git(environment.worktreePath, "status", "--porcelain"), "");
    } finally {
      restartedStore.close();
    }
  } finally {
    if (!firstStoreClosed) {
      firstStore.close();
    }
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});
