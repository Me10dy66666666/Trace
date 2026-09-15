# TraceAndBack WorkTrace Finalizer Skill

Compact production package for summarizing the **current visible human–AI development session** and persisting a structured `WorkTraceSummary` to TraceAndBack.

## Design

The host-side skill is the orchestrator. It uses the current live conversation context, summarizes the collaboration process, optionally verifies the final state with minimal Git evidence, and sends the structured result to TraceAndBack MCP/Core.

TraceAndBack MCP/Core remains responsible for Git, Trace Session/Node state, persistence, history, checkpointing, and recovery.

## Package

- `SKILL.md` — compact runtime instructions.
- `docs/behavior-reference.md` — previous detailed rules and examples; consult only when needed.
- `schemas/work-trace-summary.schema.json` — structured summary schema.
- `schemas/trace-finalize-session.input.schema.json` — proposed MCP finalization input.
- `prompts/finalize-session.md` — minimal finalization prompt.
- `examples/example-summary.json` — example output.
- `examples/example-flow.md` — example end-to-end flow.

## Key rule

If the host already has the active conversation in context, do not export and re-inject the whole conversation. Summarize from the live context and persist only the structured result.
