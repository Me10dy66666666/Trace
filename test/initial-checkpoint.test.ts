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

async function git(repositoryPath: string, ...args: string[]): Promise<string> {
  const result = await execFile("git", ["-C", repositoryPath, ...args]);
  return result.stdout;
}

let fixtureRoot: string;
let repositoryPath: string;
let databasePath: string;

before(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "traceandback-initial-checkpoint-"));
  repositoryPath = join(fixtureRoot, "repository");
  databasePath = join(fixtureRoot, "trace.db");

  await git(fixtureRoot, "init", "--initial-branch=main", "repository");
  await git(repositoryPath, "config", "user.name", "Trace Test");
  await git(repositoryPath, "config", "user.email", "trace@example.test");
  await writeFile(join(repositoryPath, "README.md"), "initial content\n", "utf8");
});

after(async () => {
  await rm(fixtureRoot, { force: true, recursive: true });
});

test("creates the first checkpoint in a repository without an existing HEAD", async () => {
  const store = new SqliteTraceStore(databasePath);
  const service = new TraceService({
    git: new GitCli(),
    locks: new RepositoryLockManager(),
    store
  });

  try {
    const repository = await service.registerRepository({ repositoryPath });
    const result = await service.createCheckpoint({
      operationId: "initial-checkpoint",
      reason: "preserve_initial_workspace",
      repositoryId: repository.id
    });

    assert.equal(result.created, true);
    assert.match(result.commit ?? "", /^[0-9a-f]{40}$/);
    assert.ok(result.nodeId);
    assert.equal((await service.getStatus({ repositoryId: repository.id })).dirty, false);
    assert.match(
      await git(repositoryPath, "show", "-s", "--format=%B", result.commit ?? ""),
      /TraceAndBack-Operation: initial-checkpoint/
    );
  } finally {
    store.close();
  }
});
