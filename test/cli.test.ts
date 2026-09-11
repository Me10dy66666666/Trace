import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";

const execFile = promisify(execFileCallback);

test("prints CLI help without starting an MCP transport", async () => {
  const result = await execFile(process.execPath, ["--import", "tsx", "src/cli.ts", "--", "--help"], {
    cwd: process.cwd()
  });

  assert.match(result.stdout, /traceandback serve/);
  assert.equal(result.stderr, "");
});
