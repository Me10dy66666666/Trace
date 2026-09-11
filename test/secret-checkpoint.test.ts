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

test("blocks a checkpoint containing a high-risk secret file before staging or committing it", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "traceandback-secret-"));
  const repositoryPath = join(fixtureRoot, "repository");
  const databasePath = join(fixtureRoot, "trace.db");
  const store = new SqliteTraceStore(databasePath);

  try {
    await git(fixtureRoot, "init", "--initial-branch=main", "repository");
    await git(repositoryPath, "config", "user.name", "Trace Test");
    await git(repositoryPath, "config", "user.email", "trace@example.test");
    await writeFile(join(repositoryPath, "README.md"), "base\n", "utf8");
    await git(repositoryPath, "add", "README.md");
    await git(repositoryPath, "commit", "-m", "feat: initial fixture");

    const service = new TraceService({
      git: new GitCli(),
      locks: new RepositoryLockManager(),
      store
    });
    const repository = await service.registerRepository({ repositoryPath });
    const beforeHead = (await git(repositoryPath, "rev-parse", "HEAD")).trim();
    await writeFile(join(repositoryPath, ".env"), "API_KEY=sk-test-secret\n", "utf8");

    await assert.rejects(
      service.createCheckpoint({
        operationId: "secret-checkpoint",
        reason: "before_resume",
        repositoryId: repository.id
      }),
      (error: unknown) => {
        assert.ok(error instanceof TraceError);
        assert.equal(error.code, "SECRET_DETECTED");
        return true;
      }
    );

    const afterHead = (await git(repositoryPath, "rev-parse", "HEAD")).trim();
    const status = await service.getStatus({ repositoryId: repository.id });
    assert.equal(afterHead, beforeHead);
    assert.equal(status.dirty, true);
  } finally {
    store.close();
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});
