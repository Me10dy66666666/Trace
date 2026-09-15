# TraceAndBack

TraceAndBack is a project-scoped development timeline for AI-assisted coding. It combines Git-backed Trace Nodes, safe local recovery, and host-generated collaboration summaries in one local-first MCP service.

## What it provides

- A Trace Graph for the current repository, with Git history and changed-file details.
- Recoverable local checkpoints that commit visible work to Git.
- Safe continuation from a historical Trace Node through a branch or verified worktree.
- Host-side `WorkTraceSummary` persistence without exporting raw conversation or hidden reasoning.
- A browser-based Trace Graph UI exposed through MCP.

## Requirements

- Node.js 24 or newer
- pnpm 11
- Git

## Install

```bash
pnpm install
```

## Run

Start the MCP server and the local Trace Graph browser service:

```bash
pnpm trace:start
```

The MCP configuration is in `.mcp.json`. The no-argument `trace.start` tool renders the current project graph and returns a host-openable browser URL.

## Main MCP tools

```text
trace.start
trace.get_status
trace.get_history
trace.get_node
trace.create_checkpoint
trace.resume_from
trace_finalize_session
trace_finalize_commit
trace_update_summary
```

The WorkTrace Finalizer Skill runs on the host. For a local save flow it first creates a checkpoint, then sends the structured summary to `trace_finalize_commit`. TraceAndBack validates, redacts, and stores the summary in SQLite; it does not call an external model or store hidden reasoning.

## Development

```bash
pnpm check
pnpm test
```

The project is private and currently has no published package or license metadata.
