import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

const execFile = promisify(execFileCallback);

test("prints CLI help without starting an MCP transport", async () => {
  const result = await execFile(process.execPath, ["--import", "tsx", "src/cli.ts", "--", "--help"], {
    cwd: process.cwd()
  });

  assert.match(result.stdout, /traceandback start \| serve/);
  assert.equal(result.stderr, "");
});
test("creates a checkpoint for an existing host through the real stdio CLI", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "traceandback-cli-mcp-"));
  const repositoryPath = join(fixtureRoot, "repository");
  await execFile("git", ["init", "--initial-branch=main", repositoryPath]);
  await execFile("git", ["-C", repositoryPath, "config", "user.name", "Trace Test"]);
  await execFile("git", ["-C", repositoryPath, "config", "user.email", "trace@example.test"]);
  await writeFile(join(repositoryPath, "HelloWorld.java"), [
    "public class HelloWorld {",
    "  public static void main(String[] args) {",
    "    System.out.println(\"Hello, world!\");",
    "  }",
    "}",
    ""
  ].join("\n"), "utf8");
  const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, TRACEANDBACK_DATABASE_PATH: join(fixtureRoot, "trace.sqlite") },
    stdio: ["pipe", "pipe", "pipe"]
  });
  let buffer = "";
  let nextId = 1;
  const pending = new Map<number, (response: Readonly<Record<string, unknown>>) => void>();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) {
        return;
      }
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line === "") {
        continue;
      }
      const response = JSON.parse(line) as Readonly<{ id?: number } & Record<string, unknown>>;
      if (response.id !== undefined) {
        pending.get(response.id)?.(response);
        pending.delete(response.id);
      }
    }
  });
  const request = (method: string, params: Readonly<Record<string, unknown>>) => {
    const id = nextId;
    nextId += 1;
    const response = new Promise<Readonly<Record<string, unknown>>>((resolve) => {
      pending.set(id, resolve);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return response;
  };
  try {
    const initialized = await request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "traceandback-cli-test", version: "0.1.0" }
    });
    assert.equal(initialized.error, undefined);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
    const statusResponse = await request("tools/call", {
      name: "trace.get_status",
      arguments: { repository: repositoryPath }
    });
    assert.equal(statusResponse.error, undefined);
    const status = JSON.parse(
      (statusResponse.result as Readonly<{ content: readonly Readonly<{ text?: string }>[] }>).content[0]?.text ?? ""
    ) as Readonly<{ repositoryId: string }>;
    const checkpointResponse = await request("tools/call", {
      name: "trace.create_checkpoint",
      arguments: {
        repositoryId: status.repositoryId,
        operationId: "cli-mcp-checkpoint"
      }
    });
    assert.equal(checkpointResponse.error, undefined);
    const checkpoint = JSON.parse(
      (checkpointResponse.result as Readonly<{ content: readonly Readonly<{ text?: string }>[] }>).content[0]?.text ?? ""
    ) as Readonly<{ created: boolean; commit: string | null }>;
    assert.equal(checkpoint.created, true);
    assert.match(checkpoint.commit ?? "", /^[0-9a-f]{40}$/);
    const commitMessage = await execFile("git", ["-C", repositoryPath, "show", "-s", "--format=%s", checkpoint.commit ?? ""]);
    assert.equal(commitMessage.stdout.trim(), "trace: checkpoint automatic checkpoint");
  } finally {
    child.stdin.end();
    await new Promise<void>((resolve) => child.once("close", () => resolve()));
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});
