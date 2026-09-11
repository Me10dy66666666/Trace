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

test("lists Trace Nodes in chronological order with independently persisted Git and chronology parents", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "traceandback-history-"));
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

    await writeFile(join(repositoryPath, "first.txt"), "first\n", "utf8");
    const first = await service.createCheckpoint({
      operationId: "history-first",
      reason: "first",
      repositoryId: repository.id
    });
    assert.ok(first.nodeId);
    assert.ok(first.commit);

    await writeFile(join(repositoryPath, "second.txt"), "second\n", "utf8");
    const second = await service.createCheckpoint({
      operationId: "history-second",
      reason: "second",
      repositoryId: repository.id
    });
    assert.ok(second.nodeId);
    assert.ok(second.commit);

    const latest = await service.getHistory({ cursor: null, limit: 1, repositoryId: repository.id });
    assert.equal(latest.nodes.length, 1);
    const latestNode = latest.nodes[0];
    assert.ok(latestNode);
    assert.equal(latestNode.id, second.nodeId);
    assert.equal(latestNode.commit, second.commit);
    assert.equal(latestNode.title, "Checkpoint: second");
    assert.match(latestNode.createdAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(latestNode.gitParent, first.nodeId);
    assert.equal(latestNode.chronologicalParent, first.nodeId);
    assert.ok(latest.nextCursor);

    const previous = await service.getHistory({
      cursor: latest.nextCursor,
      limit: 1,
      repositoryId: repository.id
    });
    assert.equal(previous.nodes.length, 1);
    const previousNode = previous.nodes[0];
    assert.ok(previousNode);
    assert.equal(previousNode.id, first.nodeId);
    assert.equal(previousNode.commit, first.commit);
    assert.equal(previousNode.title, "Checkpoint: first");
    assert.match(previousNode.createdAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(previousNode.gitParent, null);
    assert.equal(previousNode.chronologicalParent, null);
    assert.equal(previous.nextCursor, null);
  } finally {
    store.close();
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});
