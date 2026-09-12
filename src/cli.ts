import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { serveStdio } from "@modelcontextprotocol/server/stdio";


function defaultDatabasePath(): string {
  if (process.env.TRACEANDBACK_DATABASE_PATH !== undefined) {
    return resolve(process.env.TRACEANDBACK_DATABASE_PATH);
  }
  const stateDirectory = process.env.LOCALAPPDATA ?? process.env.XDG_STATE_HOME ?? resolve(process.cwd(), ".traceandback-data");
  return resolve(stateDirectory, "TraceAndBack", "trace.sqlite");
}

function printUsage(): void {
  process.stdout.write("Usage: traceandback serve\n");
}

async function serve(): Promise<void> {
  const databasePath = defaultDatabasePath();
  await mkdir(dirname(databasePath), { recursive: true });

  const [
    { TraceService },
    { createTraceMcpServer },
    { GitCli },
    { RepositoryLockManager },
    { SqliteTraceStore }
  ] = await Promise.all([
    import("./application/trace-service.js"),
    import("./mcp/create-trace-mcp-server.js"),
    import("./infrastructure/git-cli.js"),
    import("./infrastructure/repository-lock-manager.js"),
    import("./infrastructure/sqlite-trace-store.js")
  ]);
  const store = new SqliteTraceStore(databasePath);
  const trace = new TraceService({
    git: new GitCli(),
    locks: new RepositoryLockManager(),
    store
  });
  const recoveryRequired = await trace.recoverUnfinishedOperations();
  if (recoveryRequired.length > 0) {
    process.stderr.write(
      `TraceAndBack marked ${recoveryRequired.length} unfinished operation(s) as recovery-required.\n`
    );
  }
  const handle = serveStdio(
    () => createTraceMcpServer(trace),
    {
      legacy: "serve",
      onerror: (error) => process.stderr.write(`TraceAndBack MCP error: ${error.message}\n`)
    }
  );

  let closing = false;
  const close = () => {
    if (closing) {
      return;
    }
    closing = true;
    void handle.close().finally(() => store.close());
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

async function main(): Promise<void> {
  const argumentsAfterScript = process.argv.slice(2);
  const command = argumentsAfterScript[0] === "--"
    ? argumentsAfterScript[1] ?? "serve"
    : argumentsAfterScript[0] ?? "serve";
  if (command === "--help" || command === "-h") {
    printUsage();
    return;
  }
  if (command !== "serve") {
    process.stderr.write(`Unsupported command: ${command}\n`);
    printUsage();
    process.exitCode = 1;
    return;
  }
  await serve();
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "TraceAndBack could not start.";
  process.stderr.write(`TraceAndBack startup failed: ${message}\n`);
  process.exitCode = 1;
});
