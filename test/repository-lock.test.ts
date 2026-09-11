import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

import { TraceError } from "../src/domain/errors.js";
import { RepositoryLockManager } from "../src/infrastructure/repository-lock-manager.js";

const execFile = promisify(execFileCallback);

async function git(repositoryPath: string, ...args: string[]): Promise<string> {
  const result = await execFile("git", ["-C", repositoryPath, ...args]);
  return result.stdout.trim();
}

test("prevents independent manager instances from mutating the same repository concurrently", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "traceandback-lock-"));
  const repositoryPath = join(fixtureRoot, "repository");

  try {
    await git(fixtureRoot, "init", "repository");
    const commonDirectory = resolve(repositoryPath, await git(repositoryPath, "rev-parse", "--git-common-dir"));
    const target = { id: "repo_lock_test", commonDirectory };
    const firstManager = new RepositoryLockManager();
    const secondManager = new RepositoryLockManager();

    const firstLock = await firstManager.acquire(target);
    await assert.rejects(
      () => secondManager.acquire(target),
      (error: unknown) => error instanceof TraceError && error.code === "REPO_LOCKED"
    );

    await firstLock.release();
    const secondLock = await secondManager.acquire(target);
    await secondLock.release();
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});
