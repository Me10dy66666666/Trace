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

async function git(repositoryPath: string, ...args: string[]): Promise<string> {
  const result = await execFile("git", ["-C", repositoryPath, ...args]);
  return result.stdout;
}

test("fails before checkpointing when a resume target commit is unavailable", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "traceandback-missing-target-"));
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
    store.createNode({
      id: "node_missing_target",
      repositoryId: repository.id,
      commit: "0000000000000000000000000000000000000000",
      nodeType: "commit",
      title: "Missing target",
      gitParentNodeId: null,
      chronologicalParentNodeId: null,
      createdAt: "2026-09-11T00:00:00.000Z"
    });
    await writeFile(join(repositoryPath, "README.md"), "unsaved work\n", "utf8");
    const headBefore = (await git(repositoryPath, "rev-parse", "HEAD")).trim();

    await assert.rejects(
      () => service.resumeFrom({
        checkpointCurrent: true,
        nodeId: "node_missing_target",
        operationId: "missing-target-resume",
        strategy: "worktree"
      }),
      (error: unknown) => error instanceof TraceError && error.code === "VERIFY_FAILED"
    );

    assert.equal((await git(repositoryPath, "rev-parse", "HEAD")).trim(), headBefore);
    assert.equal((await service.getStatus({ repositoryId: repository.id })).dirty, true);
    assert.equal(store.getOperation("missing-target-resume"), null);
  } finally {
    store.close();
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});
