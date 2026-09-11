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

async function git(repositoryPath: string, ...args: string[]): Promise<void> {
  await execFile("git", ["-C", repositoryPath, ...args]);
}

let fixtureRoot: string;
let repositoryPath: string;
let databasePath: string;

before(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "traceandback-status-"));
  repositoryPath = join(fixtureRoot, "repository");
  databasePath = join(fixtureRoot, "trace.db");

  await git(fixtureRoot, "init", "--initial-branch=main", "repository");
  await git(repositoryPath, "config", "user.name", "Trace Test");
  await git(repositoryPath, "config", "user.email", "trace@example.test");
  await writeFile(join(repositoryPath, "README.md"), "# fixture\n", "utf8");
  await git(repositoryPath, "add", "README.md");
  await git(repositoryPath, "commit", "-m", "feat: initial fixture");
});

after(async () => {
  await rm(fixtureRoot, { force: true, recursive: true });
});

test("registers a repository and reports clean then dirty workspace state", async () => {
  const store = new SqliteTraceStore(databasePath);
  const service = new TraceService({
    git: new GitCli(),
    locks: new RepositoryLockManager(),
    store
  });

  try {
  const repository = await service.registerRepository({ repositoryPath });
  const cleanStatus = await service.getStatus({ repositoryId: repository.id });

  assert.equal(cleanStatus.branch, "main");
  assert.equal(cleanStatus.dirty, false);
  assert.equal(cleanStatus.operationState, "normal");
  assert.equal(cleanStatus.untrackedCount, 0);

  await writeFile(join(repositoryPath, "draft.txt"), "uncommitted work\n", "utf8");
  const dirtyStatus = await service.getStatus({ repositoryId: repository.id });

  assert.equal(dirtyStatus.dirty, true);
  assert.equal(dirtyStatus.untrackedCount, 1);
  assert.equal(dirtyStatus.operationState, "normal");
  } finally {
    store.close();
  }
});
