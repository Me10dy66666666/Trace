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

test("refuses a checkpoint while Git is paused in a rebase", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "traceandback-rebase-"));
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

    await git(repositoryPath, "checkout", "-b", "feature");
    await writeFile(join(repositoryPath, "README.md"), "feature\n", "utf8");
    await git(repositoryPath, "add", "README.md");
    await git(repositoryPath, "commit", "-m", "feat: feature change");
    await git(repositoryPath, "checkout", "main");
    await writeFile(join(repositoryPath, "README.md"), "main\n", "utf8");
    await git(repositoryPath, "add", "README.md");
    await git(repositoryPath, "commit", "-m", "feat: main change");
    await git(repositoryPath, "checkout", "feature");
    await assert.rejects(() => git(repositoryPath, "rebase", "main"));

    const beforeHead = (await git(repositoryPath, "rev-parse", "HEAD")).trim();
    const status = await service.getStatus({ repositoryId: repository.id });
    assert.equal(status.operationState, "rebase");
    await assert.rejects(
      () => service.createCheckpoint({
        operationId: "rebase-checkpoint",
        reason: "must_not_mutate",
        repositoryId: repository.id
      }),
      (error: unknown) => error instanceof TraceError && error.code === "UNSAFE_GIT_STATE"
    );
    assert.equal((await git(repositoryPath, "rev-parse", "HEAD")).trim(), beforeHead);
    assert.equal(store.getOperation("rebase-checkpoint"), null);
  } finally {
    await git(repositoryPath, "rebase", "--abort").catch(() => undefined);
    store.close();
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});
