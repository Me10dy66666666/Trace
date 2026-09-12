import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";
import { test } from "node:test";

import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

import { TraceService } from "../src/application/trace-service.js";
import { createTraceMcpServer } from "../src/mcp/create-trace-mcp-server.js";
import { GitCli } from "../src/infrastructure/git-cli.js";
import { RepositoryLockManager } from "../src/infrastructure/repository-lock-manager.js";
import { SqliteTraceStore } from "../src/infrastructure/sqlite-trace-store.js";

const execFile = promisify(execFileCallback);

type JsonRpcResponse = Readonly<{
  id?: number;
  result?: Record<string, unknown>;
  error?: Readonly<{ code: number; message: string }>;
}>;

async function git(repositoryPath: string, ...args: string[]): Promise<string> {
  const result = await execFile("git", ["-C", repositoryPath, ...args]);
  return result.stdout.trim();
}

async function createClient(server: ReturnType<typeof createTraceMcpServer>): Promise<Readonly<{
  request(method: string, params: Record<string, unknown>): Promise<JsonRpcResponse>;
  notify(method: string, params: Record<string, unknown>): void;
  close(): Promise<void>;
}>> {
  const input = new PassThrough();
  const output = new PassThrough();
  const pending = new Map<number, Readonly<{
    resolve(response: JsonRpcResponse): void;
    reject(error: Error): void;
    timeout: NodeJS.Timeout;
  }>>();
  let buffer = "";
  let nextId = 1;

  output.setEncoding("utf8");
  output.on("data", (chunk: string) => {
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
      const response = JSON.parse(line) as JsonRpcResponse;
      if (typeof response.id !== "number") {
        continue;
      }
      const request = pending.get(response.id);
      if (request === undefined) {
        continue;
      }
      pending.delete(response.id);
      clearTimeout(request.timeout);
      request.resolve(response);
    }
  });

  await server.connect(new StdioServerTransport(input, output));
  return {
    request: async (method, params) => {
      const id = nextId;
      nextId += 1;
      return await new Promise<JsonRpcResponse>((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Timed out waiting for MCP response to ${method}.`));
        }, 2_000);
        pending.set(id, { resolve, reject, timeout });
        input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    },
    notify: (method, params) => {
      input.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    },
    close: async () => {
      for (const request of pending.values()) {
        clearTimeout(request.timeout);
        request.reject(new Error("MCP test client closed."));
      }
      pending.clear();
      input.end();
      await server.close();
    }
  };
}

test("exposes the eight v1 trace.* Tools over MCP stdio", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "traceandback-mcp-"));
  const repositoryPath = join(fixtureRoot, "repository");
  const store = new SqliteTraceStore(join(fixtureRoot, "trace.db"));
  const service = new TraceService({
    git: new GitCli(),
    locks: new RepositoryLockManager(),
    store
  });
  const server = createTraceMcpServer(service);
  const client = await createClient(server);

  try {
    await git(fixtureRoot, "init", "--initial-branch=main", "repository");
    await git(repositoryPath, "config", "user.name", "Trace Test");
    await git(repositoryPath, "config", "user.email", "trace@example.test");
    await writeFile(join(repositoryPath, "README.md"), "base\n", "utf8");
    await git(repositoryPath, "add", "README.md");
    await git(repositoryPath, "commit", "-m", "feat: base");

    const initialized = await client.request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "traceandback-test", version: "0.1.0" }
    });
    assert.equal(initialized.error, undefined);
    client.notify("notifications/initialized", {});

    const listed = await client.request("tools/list", {});
    assert.equal(listed.error, undefined);
    const tools = listed.result?.tools as readonly Readonly<{ name: string }>[];
    assert.deepEqual(tools.map((tool) => tool.name).sort(), [
      "trace.attach_conversation",
      "trace.compare",
      "trace.create_checkpoint",
      "trace.get_history",
      "trace.get_node",
      "trace.get_status",
      "trace.render_graph",
      "trace.resume_from"
    ]);

    const statusResponse = await client.request("tools/call", {
      name: "trace.get_status",
      arguments: { repository: repositoryPath }
    });
    assert.equal(statusResponse.error, undefined);
    const content = statusResponse.result?.content as readonly Readonly<{ type: string; text?: string }>[];
    const status = JSON.parse(content[0]?.text ?? "") as Readonly<{ repositoryId: string; branch: string | null; dirty: boolean }>;
    assert.match(status.repositoryId, /^repo_/);
    assert.equal(status.branch, "main");
    assert.equal(status.dirty, false);
  } finally {
    await client.close();
    store.close();
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

test("renders embedded Trace cards from the registered repository Git history", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "traceandback-mcp-graph-"));
  const repositoryPath = join(fixtureRoot, "repository");
  const store = new SqliteTraceStore(join(fixtureRoot, "trace.db"));
  const service = new TraceService({
    git: new GitCli(),
    locks: new RepositoryLockManager(),
    store
  });
  const server = createTraceMcpServer(service);
  const client = await createClient(server);

  try {
    await git(fixtureRoot, "init", "--initial-branch=main", "repository");
    await git(repositoryPath, "config", "user.name", "Trace Test");
    await git(repositoryPath, "config", "user.email", "trace@example.test");
    await writeFile(join(repositoryPath, "README.md"), "base\n", "utf8");
    await git(repositoryPath, "add", "README.md");
    await git(repositoryPath, "commit", "-m", "feat: base");
    await writeFile(join(repositoryPath, "README.md"), "base\nsecond\n", "utf8");
    await git(repositoryPath, "add", "README.md");
    await git(repositoryPath, "commit", "-m", "feat: second");
    const expectedCommits = (await git(repositoryPath, "log", "--format=%H")).split("\n");

    const initialized = await client.request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "traceandback-test", version: "0.1.0" }
    });
    assert.equal(initialized.error, undefined);
    client.notify("notifications/initialized", {});

    const listed = await client.request("tools/list", {});
    const tools = listed.result?.tools as readonly Readonly<{
      name: string;
      _meta?: Readonly<{ ui?: Readonly<{ resourceUri?: string }> }>;
    }>[];
    const renderTool = tools.find((tool) => tool.name === "trace.render_graph");
    assert.equal(renderTool?._meta?.ui?.resourceUri, "ui://traceandback/trace-graph-v2.html");

    const resource = await client.request("resources/read", {
      uri: "ui://traceandback/trace-graph-v2.html"
    });
    assert.equal(resource.error, undefined);
    const resources = resource.result?.contents as readonly Readonly<{
      mimeType?: string;
      text?: string;
    }>[];
    assert.equal(resources[0]?.mimeType, "text/html;profile=mcp-app");
    assert.match(resources[0]?.text ?? "", /ui\/notifications\/tool-result/);

    const rendered = await client.request("tools/call", {
      name: "trace.render_graph",
      arguments: { repository: repositoryPath }
    });
    assert.equal(rendered.error, undefined);
    const content = rendered.result?.content as readonly Readonly<{ type: string; text?: string }>[];
    const payload = JSON.parse(content[0]?.text ?? "") as Readonly<{
      graph: Readonly<{ nodes: readonly Readonly<{ commit: string; title: string }>[] }>;
    }>;
    assert.deepEqual(payload.graph.nodes.map((node) => node.commit), expectedCommits);
    assert.deepEqual(payload.graph.nodes.map((node) => node.title), ["feat: second", "feat: base"]);
  } finally {
    await client.close();
    store.close();
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});
