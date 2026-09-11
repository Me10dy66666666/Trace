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

test("gets a code-only Trace Node detail with Git-backed changed-file statistics", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "traceandback-node-detail-"));
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
    await writeFile(join(repositoryPath, "README.md"), "base\nfeature\n", "utf8");
    await writeFile(join(repositoryPath, "new.ts"), "export const value = 1;\n", "utf8");
    const checkpoint = await service.createCheckpoint({
      operationId: "node-detail-checkpoint",
      reason: "capture_detail",
      repositoryId: repository.id
    });
    assert.ok(checkpoint.nodeId);
    assert.ok(checkpoint.commit);

    const detail = await service.getNode({ nodeId: checkpoint.nodeId });
    assert.deepEqual(detail, {
      id: checkpoint.nodeId,
      commit: checkpoint.commit,
      summary: "Checkpoint: capture_detail",
      goal: "Checkpoint: capture_detail",
      decisions: [],
      changedFiles: [
        { path: "README.md", additions: 1, deletions: 0 },
        { path: "new.ts", additions: 1, deletions: 0 }
      ],
      gitParent: null,
      chronologicalParent: null,
      conversationStatus: "unavailable"
    });
  } finally {
    store.close();
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});
