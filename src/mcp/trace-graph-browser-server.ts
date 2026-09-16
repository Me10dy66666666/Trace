import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { URL } from "node:url";

import type { TraceService } from "../application/trace-service.js";
import { TraceError } from "../domain/errors.js";
import { buildTraceGraph } from "./create-trace-mcp-server.js";

type JsonObject = Readonly<Record<string, unknown>>;
type BrowserArguments = Readonly<Record<string, unknown>>;

const TRACE_GRAPH_UI_FILE = new URL("./trace-graph-app.html", import.meta.url);
const MAX_BODY_BYTES = 1024 * 1024;

export type TraceGraphBrowserServerOptions = Readonly<{
  port: number;
  token: string;
}>;

export type TraceGraphBrowserServer = Readonly<{
  url: string;
  close: () => Promise<void>;
}>;

function success(value: JsonObject) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value
  };
}

function failure(error: unknown) {
  const value: JsonObject = error instanceof TraceError
    ? {
        code: error.code,
        message: error.message,
        recoverable: error.recoverable,
        details: error.details
      }
    : {
        code: "BROWSER_API_ERROR",
        message: error instanceof Error ? error.message : "TraceAndBack browser request failed.",
        recoverable: true,
        details: {}
      };
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value
  };
}

function requiredString(args: BrowserArguments, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("Missing browser API argument: " + name);
  }
  return value;
}

function optionalString(args: BrowserArguments, name: string): string | undefined {
  const value = args[name];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function limit(args: BrowserArguments): number {
  const value = args.limit;
  if (value === undefined) return 50;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error("Browser API limit must be an integer.");
  }
  return Math.min(Math.max(value, 1), 100);
}

function cursor(args: BrowserArguments): string | null {
  return typeof args.cursor === "string" ? args.cursor : null;
}

async function callBrowserTool(
  trace: TraceService,
  name: string,
  args: BrowserArguments
): Promise<JsonObject> {
  switch (name) {
    case "trace.render_graph": {
      const repository = optionalString(args, "repository");
      if (repository === undefined) throw new Error("Browser API requires repository.");
      return await buildTraceGraph(trace, {
        repository,
        limit: limit(args),
        cursor: cursor(args),
        detailLevel: "summary"
      });
    }
    case "trace.get_status": {
      const repository = optionalString(args, "repository");
      if (repository === undefined) throw new Error("Browser API requires repository.");
      const registered = await trace.registerRepository({ repositoryPath: repository });
      const statusPromise = trace.getStatus({
        repositoryId: registered.id,
        repositoryPath: registered.repositoryPath
      });
      if (args.includePublishedCommit === false) {
        return await statusPromise;
      }
      const [status, publishedCommit] = await Promise.all([
        statusPromise,
        trace.getPublishedCommit({
          repositoryId: registered.id,
          repositoryPath: registered.repositoryPath
        })
      ]);
      return { ...status, publishedCommit };
    }
    case "trace.get_node":
      return await trace.getNode({ nodeId: requiredString(args, "nodeId") });
    case "trace.compare":
      return await trace.compare({
        fromNode: requiredString(args, "fromNode"),
        toNode: requiredString(args, "toNode")
      });
    case "trace.resume_from":
      return await trace.resumeFrom({
        operationId: optionalString(args, "operationId") ?? ("browser_" + randomUUID()),
        nodeId: requiredString(args, "nodeId"),
        checkpointCurrent: args.checkpointCurrent === true,
        strategy: "branch",
        repositoryPath: optionalString(args, "repository")
      });
    default:
      throw new Error("Browser API operation is not available: " + name);
  }
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff"
  });
  response.end(JSON.stringify(value));
}

async function readJson(request: IncomingMessage): Promise<BrowserArguments> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > MAX_BODY_BYTES) throw new Error("Browser API request is too large.");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Browser API request must be a JSON object.");
  }
  return value as BrowserArguments;
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  trace: TraceService,
  token: string,
  loadUi: () => Promise<string>
): Promise<void> {
  const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
  if (requestUrl.searchParams.get("token") !== token) {
    writeJson(response, 401, { error: "Unauthorized browser API request." });
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/trace-graph-app.html") {
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": "text/html; charset=utf-8",
      "x-content-type-options": "nosniff"
    });
    response.end(await loadUi());
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/tool") {
    try {
      const input = await readJson(request);
      const name = requiredString(input, "name");
      const argsValue = input.arguments;
      const args = argsValue && typeof argsValue === "object" && !Array.isArray(argsValue)
        ? argsValue as BrowserArguments
        : {};
      writeJson(response, 200, success(await callBrowserTool(trace, name, args)));
    } catch (error) {
      writeJson(response, 200, failure(error));
    }
    return;
  }

  writeJson(response, 404, { error: "Browser endpoint not found." });
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      const address = server.address() as AddressInfo;
      resolve(address.port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

export async function createTraceGraphBrowserServer(
  trace: TraceService,
  options: TraceGraphBrowserServerOptions
): Promise<TraceGraphBrowserServer> {
  let uiPromise: Promise<string> | undefined;
  const loadUi = (): Promise<string> => {
    uiPromise ??= readFile(TRACE_GRAPH_UI_FILE, "utf8");
    return uiPromise;
  };
  const server = createServer((request, response) => {
    void handleRequest(request, response, trace, options.token, loadUi).catch((error: unknown) => {
      if (!response.headersSent) writeJson(response, 500, failure(error));
      else response.destroy();
    });
  });
  const port = await listen(server, options.port);
  const url = new URL("http://127.0.0.1:" + port + "/trace-graph-app.html");
  url.searchParams.set("token", options.token);

  return {
    url: url.href,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })
  };
}
