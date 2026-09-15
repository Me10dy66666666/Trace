# Direct Trace startup command

## Status

Accepted

## Context

The MCP host previously launched TraceAndBack through `pnpm start`, which adds a package-manager script hop before the TypeScript runtime starts. Users also need a deterministic command that opens the current project's Trace Graph without a follow-up planning turn.

## Decision

The MCP configuration launches the process directly with:

```text
node --import tsx src/cli.ts start
```

The CLI accepts `start` as an explicit alias for `serve`. The MCP server exposes a zero-argument `trace.start` Tool. It resolves the current working directory as the repository, renders its project-scoped graph, and links the result to an auto-opening Trace Graph launcher. The launcher is registered in both MCP Apps (`text/html;profile=mcp-app`) and OpenAI host (`text/html+skybridge`) formats, and calls the host browser bridge so the full project graph opens in the built-in browser instead of remaining only in the conversation. `trace.render_graph` remains available for callers that need an explicit repository or pagination arguments.

Browser UI source is loaded lazily on the first page request, while unfinished-operation recovery remains part of process startup so safety is not traded for latency.

## Consequences

The common startup path has one fewer process/script resolution hop and one fewer startup file read. `trace.start` is intentionally a small interface: callers provide no arguments, and the current MCP project is the scope. Hosts that start the server outside the project directory should continue using `trace.render_graph` with an explicit repository.