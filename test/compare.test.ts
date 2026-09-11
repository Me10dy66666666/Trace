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

test("compares two Trace Nodes through their verified Git commits", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "traceandback-compare-"));
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

    await writeFile(join(repositoryPath, "README.md"), "first\n", "utf8");
    const from = await service.createCheckpoint({
      operationId: "compare-from",
      reason: "first",
      repositoryId: repository.id
    });
    assert.ok(from.nodeId);
    assert.ok(from.commit);

    await writeFile(join(repositoryPath, "README.md"), "second\n", "utf8");
    await writeFile(join(repositoryPath, "new.ts"), "export const value = 1;\n", "utf8");
    const to = await service.createCheckpoint({
      operationId: "compare-to",
      reason: "second",
      repositoryId: repository.id
    });
    assert.ok(to.nodeId);
    assert.ok(to.commit);

    const comparison = await service.compare({ fromNode: from.nodeId, toNode: to.nodeId });
    assert.deepEqual(comparison, {
      filesChanged: 2,
      additions: 2,
      deletions: 1,
      summary: "2 files changed, 2 additions, 1 deletion",
      files: [
        { path: "README.md", additions: 1, deletions: 1 },
        { path: "new.ts", additions: 1, deletions: 0 }
      ]
    });
  } finally {
    store.close();
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});
