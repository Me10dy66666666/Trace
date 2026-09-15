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
import { buildTraceGraph, createTraceMcpServer } from "../src/mcp/create-trace-mcp-server.js";
import { createTraceGraphBrowserServer } from "../src/mcp/trace-graph-browser-server.js";
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

test("exposes the v1 trace.* Tools over MCP stdio", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "traceandback-mcp-"));
  const repositoryPath = join(fixtureRoot, "repository");
  const store = new SqliteTraceStore(join(fixtureRoot, "trace.db"));
  const service = new TraceService({
    git: new GitCli(),
    locks: new RepositoryLockManager(),
    store
  });
  const server = createTraceMcpServer(service, { browserUrl: "http://127.0.0.1:4173/trace-graph-app.html?token=test" });
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
      "trace.resume_from",
      "trace.start",
      "trace_finalize_commit",
      "trace_finalize_session",
      "trace_update_summary"
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

test("trace.start opens the current project graph without arguments", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "traceandback-mcp-start-"));
  const repositoryPath = join(fixtureRoot, "repository");
  const store = new SqliteTraceStore(join(fixtureRoot, "trace.db"));
  const service = new TraceService({
    git: new GitCli(),
    locks: new RepositoryLockManager(),
    store
  });
  let client: Awaited<ReturnType<typeof createClient>> | null = null;

  try {
    await git(fixtureRoot, "init", "--initial-branch=main", "repository");
    await git(repositoryPath, "config", "user.name", "Trace Test");
    await git(repositoryPath, "config", "user.email", "trace@example.test");
    await writeFile(join(repositoryPath, "README.md"), "base\n", "utf8");
    await git(repositoryPath, "add", "README.md");
    await git(repositoryPath, "commit", "-m", "feat: base");

    const server = createTraceMcpServer(service, {
      browserUrl: "http://127.0.0.1:4173/trace-graph-app.html?token=test",
      repository: repositoryPath
    });
    client = await createClient(server);
    const initialized = await client.request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "traceandback-start-test", version: "0.1.0" }
    });
    assert.equal(initialized.error, undefined);
    client.notify("notifications/initialized", {});

    const rendered = await client.request("tools/call", {
      name: "trace.start",
      arguments: {}
    });
    assert.equal(rendered.error, undefined);
    const content = rendered.result?.content as readonly Readonly<{ type: string; text?: string }>[];
    const payload = JSON.parse(content[0]?.text ?? "") as Readonly<{
      repository: Readonly<{ path: string }>;
      graph: Readonly<{ name: string; nodes: readonly Readonly<Record<string, unknown>>[] }>;
      browser: Readonly<{
        action: string;
        target: string;
        url: string;
      }>;
    }>;
    assert.equal(payload.repository.path, repositoryPath);
    assert.equal(payload.graph.name, "repository");
    assert.equal(payload.graph.nodes.length, 1);
    assert.equal("changedFiles" in (payload.graph.nodes[0] ?? {}), false);
    assert.equal(payload.browser.action, "open_in_codex");
    assert.equal(payload.browser.target, "browser");
    const browserUrl = new URL(payload.browser.url);
    assert.equal(browserUrl.pathname, "/trace-graph-app.html");
    assert.equal(browserUrl.searchParams.get("repository"), repositoryPath);
  } finally {
    await client?.close();
    store.close();
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});
test("opens a standalone Trace Graph from the registered repository Git history", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "traceandback-mcp-graph-"));
  const repositoryPath = join(fixtureRoot, "repository");
  const store = new SqliteTraceStore(join(fixtureRoot, "trace.db"));
  const service = new TraceService({
    git: new GitCli(),
    locks: new RepositoryLockManager(),
    store
  });
  const server = createTraceMcpServer(service, { browserUrl: "http://127.0.0.1:4173/trace-graph-app.html?token=test" });
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
      _meta?: Readonly<{
        ui?: Readonly<{ resourceUri?: string }>;
        "openai/outputTemplate"?: string;
      }>;
    }>[];
    const renderTool = tools.find((tool) => tool.name === "trace.render_graph");
    assert.equal(renderTool?._meta?.ui?.resourceUri, "ui://traceandback/trace-graph-v2.html");
    assert.equal(renderTool?._meta?.["openai/outputTemplate"], "ui://traceandback/trace-graph-launcher.html");
    const startTool = tools.find((tool) => tool.name === "trace.start");
    assert.equal(startTool?._meta?.ui?.resourceUri, "ui://traceandback/trace-graph-v2.html");
    assert.equal(startTool?._meta?.["openai/outputTemplate"], "ui://traceandback/trace-graph-launcher.html");

    const resource = await client.request("resources/read", {
      uri: "ui://traceandback/trace-graph-v2.html"
    });
    assert.equal(resource.error, undefined);
    const resources = resource.result?.contents as readonly Readonly<{
      mimeType?: string;
      text?: string;
    }>[];
    assert.equal(resources[0]?.mimeType, "text/html;profile=mcp-app");
    const ui = resources[0]?.text ?? "";
    assert.match(ui, /openExternal/);
    assert.match(ui, /repository/);
    assert.doesNotMatch(ui, /__TRACEANDBACK_BROWSER_URL__/);
    assert.doesNotMatch(ui, /node-card|ui\/notifications\/tool-result|MCP Apps host bridge/);

    const legacyResource = await client.request("resources/read", {
      uri: "ui://traceandback/trace-graph-launcher.html"
    });
    assert.equal(legacyResource.error, undefined);
    const legacyResources = legacyResource.result?.contents as readonly Readonly<{
      mimeType?: string;
      text?: string;
    }>[];
    assert.equal(legacyResources[0]?.mimeType, "text/html+skybridge");
    assert.match(legacyResources[0]?.text ?? "", /openExternal/);
    assert.doesNotMatch(legacyResources[0]?.text ?? "", /__TRACEANDBACK_BROWSER_URL__/);

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
    const firstGraphNode = payload.graph.nodes[0] as Readonly<{ changedFiles?: unknown }>;
    assert.ok(Array.isArray(firstGraphNode.changedFiles));
  } finally {
    await client.close();
    store.close();
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

test("refreshes the top-level Trace Graph through the local browser API", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "traceandback-browser-"));
  const repositoryPath = join(fixtureRoot, "repository");
  const store = new SqliteTraceStore(join(fixtureRoot, "trace.db"));
  const service = new TraceService({
    git: new GitCli(),
    locks: new RepositoryLockManager(),
    store
  });
  const browser = await createTraceGraphBrowserServer(service, { port: 0, token: "test-token" });

  try {
    await git(fixtureRoot, "init", "--initial-branch=main", "repository");
    await git(repositoryPath, "config", "user.name", "Trace Test");
    await git(repositoryPath, "config", "user.email", "trace@example.test");
    await writeFile(join(repositoryPath, "README.md"), "base\n", "utf8");
    await git(repositoryPath, "add", "README.md");
    await git(repositoryPath, "commit", "-m", "feat: base");

    const pageUrl = new URL(browser.url);
    pageUrl.searchParams.set("repository", repositoryPath);
    const page = await fetch(pageUrl);
    assert.equal(page.status, 200);
    assert.doesNotMatch(await page.text(), /window\\.openai|window\\.parent|postMessage/);

    const call = async () => {
      const url = new URL("/api/tool", pageUrl);
      url.searchParams.set("token", "test-token");
      return await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "trace.render_graph",
          arguments: { repository: repositoryPath, limit: 50, cursor: null }
        })
      });
    };

    const firstResponse = await call();
    const firstPayload = await firstResponse.json() as Readonly<{
      structuredContent: Readonly<{ graph: Readonly<{ nodes: readonly unknown[] }> }>;
    }>;
    assert.equal(firstResponse.status, 200);
    assert.equal(firstPayload.structuredContent.graph.nodes.length, 1);

    const statusCall = async () => {
      const url = new URL("/api/tool", pageUrl);
      url.searchParams.set("token", "test-token");
      return await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "trace.get_status",
          arguments: { repository: repositoryPath }
        })
      });
    };
    const firstStatusResponse = await statusCall();
    const firstStatusPayload = await firstStatusResponse.json() as Readonly<{
      structuredContent: Readonly<{ head: string | null; branch: string | null }>;
    }>;
    assert.equal(firstStatusResponse.status, 200);
    assert.equal(firstStatusPayload.structuredContent.head, await git(repositoryPath, "rev-parse", "HEAD"));

    await writeFile(join(repositoryPath, "README.md"), "base\nsecond\n", "utf8");
    await git(repositoryPath, "add", "README.md");
    await git(repositoryPath, "commit", "-m", "feat: second");

    const refreshedResponse = await call();
    const refreshedPayload = await refreshedResponse.json() as Readonly<{
      structuredContent: Readonly<{ graph: Readonly<{ nodes: readonly unknown[] }> }>;
    }>;
    assert.equal(refreshedResponse.status, 200);
    assert.equal(refreshedPayload.structuredContent.graph.nodes.length, 2);

    const secondStatusResponse = await statusCall();
    const secondStatusPayload = await secondStatusResponse.json() as Readonly<{
      structuredContent: Readonly<{ head: string | null; branch: string | null }>;
    }>;
    assert.equal(secondStatusResponse.status, 200);
    assert.notEqual(secondStatusPayload.structuredContent.head, firstStatusPayload.structuredContent.head);
  } finally {
    await browser.close();
    store.close();
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

test("marks the current branch's GitHub HEAD as the published version", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "traceandback-browser-remote-"));
  const repositoryPath = join(fixtureRoot, "repository");
  const remotePath = join(fixtureRoot, "remote.git");
  const store = new SqliteTraceStore(join(fixtureRoot, "trace.db"));
  const service = new TraceService({
    git: new GitCli(),
    locks: new RepositoryLockManager(),
    store
  });
  const browser = await createTraceGraphBrowserServer(service, { port: 0, token: "test-token" });

  try {
    await git(fixtureRoot, "init", "--initial-branch=main", "repository");
    await git(fixtureRoot, "init", "--bare", "remote.git");
    await git(repositoryPath, "config", "user.name", "Trace Test");
    await git(repositoryPath, "config", "user.email", "trace@example.test");
    await git(repositoryPath, "remote", "add", "origin", remotePath);
    await writeFile(join(repositoryPath, "README.md"), "base\n", "utf8");
    await git(repositoryPath, "add", "README.md");
    await git(repositoryPath, "commit", "-m", "feat: base");
    const firstCommit = await git(repositoryPath, "rev-parse", "HEAD");
    await git(repositoryPath, "push", "-u", "origin", "main");
    await git(remotePath, "symbolic-ref", "HEAD", "refs/heads/main");

    const pageUrl = new URL(browser.url);
    pageUrl.searchParams.set("repository", repositoryPath);
    const call = async () => {
      const url = new URL("/api/tool", pageUrl);
      url.searchParams.set("token", "test-token");
      return await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "trace.render_graph",
          arguments: { repository: repositoryPath, limit: 50, cursor: null }
        })
      });
    };
    const firstPayload = await (await call()).json() as Readonly<{
      structuredContent: Readonly<{ graph: Readonly<{ publishedCommit: string | null }> }>;
    }>;
    assert.equal(firstPayload.structuredContent.graph.publishedCommit, firstCommit);

    await writeFile(join(repositoryPath, "README.md"), "base\nlocal\n", "utf8");
    await git(repositoryPath, "add", "README.md");
    await git(repositoryPath, "commit", "-m", "feat: local");
    const localCommit = await git(repositoryPath, "rev-parse", "HEAD");
    const localPayload = await (await call()).json() as Readonly<{
      structuredContent: Readonly<{ graph: Readonly<{ publishedCommit: string | null }> }>;
    }>;
    assert.equal(localPayload.structuredContent.graph.publishedCommit, firstCommit);

    await git(repositoryPath, "push", "origin", "main");
    const publishedPayload = await (await call()).json() as Readonly<{
      structuredContent: Readonly<{ graph: Readonly<{ publishedCommit: string | null }> }>;
    }>;
    assert.equal(publishedPayload.structuredContent.graph.publishedCommit, localCommit);
  } finally {
    await browser.close();
    store.close();
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

test("renders parallel branch nodes in one project Trace Graph", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "traceandback-mcp-branches-"));
  const repositoryPath = join(fixtureRoot, "repository");
  const linkedPath = join(fixtureRoot, "linked-worktree");
  const store = new SqliteTraceStore(join(fixtureRoot, "trace.db"));
  const service = new TraceService({
    git: new GitCli(),
    locks: new RepositoryLockManager(),
    store
  });

  try {
    await git(fixtureRoot, "init", "--initial-branch=main", "repository");
    await git(repositoryPath, "config", "user.name", "Trace Test");
    await git(repositoryPath, "config", "user.email", "trace@example.test");
    await writeFile(join(repositoryPath, "README.md"), "base\n", "utf8");
    await git(repositoryPath, "add", "README.md");
    await git(repositoryPath, "commit", "-m", "feat: base");
    const baseCommit = await git(repositoryPath, "rev-parse", "HEAD");

    const repository = await service.registerRepository({ repositoryPath });
    await writeFile(join(repositoryPath, "README.md"), "base\nmain\n", "utf8");
    await git(repositoryPath, "add", "README.md");
    await git(repositoryPath, "commit", "-m", "feat: main line");
    await service.getGitHistory({ repositoryId: repository.id, limit: 50, repositoryPath });

    await git(repositoryPath, "worktree", "add", "-b", "session-a", linkedPath, baseCommit);
    await writeFile(join(linkedPath, "README.md"), "base\nparallel\n", "utf8");
    await git(linkedPath, "add", "README.md");
    await git(linkedPath, "commit", "-m", "feat: parallel line");

    const linkedRepository = await service.registerRepository({ repositoryPath: linkedPath });
    assert.equal(linkedRepository.id, repository.id);
    await service.getGitHistory({
      repositoryId: linkedRepository.id,
      limit: 50,
      repositoryPath: linkedPath
    });

    const rendered = await buildTraceGraph(service, {
      repository: repositoryPath,
      limit: 50,
      cursor: null
    });
    const graph = rendered.graph as Readonly<{
      nodes: readonly Readonly<{ title: string }>[];
      gitEdges: readonly (readonly [string, string])[];
    }>;
    assert.deepEqual(
      new Set(graph.nodes.map((node) => node.title)),
      new Set(["feat: base", "feat: main line", "feat: parallel line"])
    );
    assert.equal(graph.gitEdges.length, 2);
  } finally {
    await git(repositoryPath, "worktree", "remove", "--force", linkedPath).catch(() => undefined);
    store.close();
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});
