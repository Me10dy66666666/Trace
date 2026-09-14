import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

async function git(repositoryPath: string, ...args: string[]): Promise<string> {
  const result = await execFile("git", ["-C", repositoryPath, ...args]);
  return result.stdout;
}

test("preserves the current workspace when worktree creation fails", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "traceandback-worktree-failure-"));
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
    const target = await service.createCheckpoint({
      operationId: "failure-target",
      reason: "target",
      repositoryId: repository.id
    });
    assert.ok(target.nodeId);
    assert.ok(target.commit);
    const targetNodeId = target.nodeId;
    const targetCommit = target.commit;

    await writeFile(join(repositoryPath, "main-only.txt"), "later history\n", "utf8");
    await git(repositoryPath, "add", "main-only.txt");
    await git(repositoryPath, "commit", "-m", "feat: later history");
    const headBefore = (await git(repositoryPath, "rev-parse", "HEAD")).trim();
    await writeFile(join(repositoryPath, "draft.txt"), "current unsaved work\n", "utf8");

    const operationId = "worktree-failure";
    const conflictingBranch = `trace/${targetNodeId}-${operationId}`;
    await git(repositoryPath, "branch", conflictingBranch, targetCommit);
    await assert.rejects(
      () => service.resumeFrom({ checkpointCurrent: true, nodeId: targetNodeId, operationId, strategy: "worktree" }),
      (error: unknown) => error instanceof TraceError && error.code === "WORKTREE_CREATE_FAILED"
    );

    const headAfter = (await git(repositoryPath, "rev-parse", "HEAD")).trim();
    assert.notEqual(headAfter, headBefore);
    assert.equal(await readFile(join(repositoryPath, "draft.txt"), "utf8"), "current unsaved work\n");
    assert.equal((await git(repositoryPath, "show", `${headAfter}:draft.txt`)), "current unsaved work\n");
    const status = await service.getStatus({ repositoryId: repository.id });
    assert.equal(status.branch, "main");
    assert.equal(status.dirty, false);
    assert.equal(store.getOperation(operationId)?.state, "FAILED");
  } finally {
    store.close();
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});
