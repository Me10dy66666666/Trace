import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { SqliteTraceStore } from "../src/infrastructure/sqlite-trace-store.js";

test("persists the durable operation journal phases in order", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "traceandback-operation-journal-"));
  const store = new SqliteTraceStore(join(fixtureRoot, "trace.db"));

  try {
    store.saveRepository({
      id: "repo_operation_journal",
      repositoryPath: join(fixtureRoot, "repository"),
      commonDirectory: join(fixtureRoot, "repository", ".git"),
      fingerprint: "operation-journal-fixture",
      defaultBranch: "main",
      createdAt: "2026-09-11T00:00:00.000Z"
    });
    store.createOperation({
      id: "op_operation_journal",
      repositoryId: "repo_operation_journal",
      operationType: "checkpoint",
      intent: null,
      result: null,
      state: "PENDING",
      recovery: null,
      createdAt: "2026-09-11T00:00:00.000Z"
    });

    const stateOf = (): string => {
      const operation = store.getOperation("op_operation_journal");
      assert.ok(operation);
      return operation.state;
    };
    const states = [stateOf()];
    store.markOperationPrepared("op_operation_journal");
    states.push(stateOf());
    store.markOperationGitApplied("op_operation_journal");
    states.push(stateOf());
    store.markOperationDatabaseApplied("op_operation_journal");
    states.push(stateOf());
    store.markOperationVerified("op_operation_journal");
    states.push(stateOf());
    store.completeOperation("op_operation_journal", {
      operationId: "op_operation_journal",
      created: false,
      nodeId: null,
      commit: null,
      recoverable: true
    });
    states.push(stateOf());

    assert.deepEqual(states, ["PENDING", "PREPARED", "GIT_APPLIED", "DB_APPLIED", "VERIFIED", "COMPLETED"]);
  } finally {
    store.close();
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});
