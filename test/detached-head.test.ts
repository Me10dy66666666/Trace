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

test("continues safely from a detached HEAD by creating a named worktree branch", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "traceandback-detached-"));
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
      operationId: "detached-target",
      reason: "target",
      repositoryId: repository.id
    });
    assert.ok(target.nodeId);
    assert.ok(target.commit);

    await git(repositoryPath, "checkout", "--detach", target.commit);
    const detached = await service.getStatus({ repositoryId: repository.id });
    assert.equal(detached.branch, null);
    assert.equal(detached.operationState, "detached");

    const continued = await service.resumeFrom({
      checkpointCurrent: false,
      nodeId: target.nodeId,
      operationId: "detached-resume"
    });
    assert.match(continued.newBranch, /^trace\//);
    assert.equal((await git(continued.worktreePath, "branch", "--show-current")).trim(), continued.newBranch);

    const after = await service.getStatus({ repositoryId: repository.id });
    assert.equal(after.branch, null);
    assert.equal(after.operationState, "detached");
  } finally {
    store.close();
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});
