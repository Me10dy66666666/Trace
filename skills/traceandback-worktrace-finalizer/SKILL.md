---
name: traceandback-worktrace-finalizer
description: Summarize the current visible human-AI development session when a Trace checkpoint or commit is being saved or the host is leaving the development context, then persist a structured WorkTraceSummary to TraceAndBack.
---

# TraceAndBack WorkTrace Finalizer

Version: 0.2.0

## Purpose

Summarize the **current visible human–AI development session** and persist it to TraceAndBack.

The summary must describe:
- what the user asked AI to do;
- explicit constraints and boundaries;
- what AI actually did or attempted;
- important decisions, rejections, and direction changes;
- final outcomes;
- unresolved or deferred work.

Do **not** turn the Git commit message or diff into the primary AI summary. Git is verification evidence, not the main narrative source.

## When to Run

Run when:
- a Trace session is finalized;
- a commit/checkpoint needs its collaboration summary;
- the user asks to save the current development history;
- the host is about to leave the current development context.

Do not run on every message.

## Evidence Priority

Use, in order:
1. current visible conversation for the active Trace session;
2. visible tool calls and results;
3. explicit user approvals, rejections, corrections, and constraints;
4. visible test results;
5. Git/diff metadata only to verify the final state.

Never infer or request hidden chain-of-thought.

## Procedure

## Two-phase checkpoint route

When the user asks to save, push, or checkpoint local changes, use this host-side sequence:

1. Call `trace.create_checkpoint` with the current repository identifier and the user-approved reason when a new local commit is needed.
2. Capture the returned `nodeId` and `commit`.
3. Build the WorkTraceSummary from the current visible conversation, then call `trace_finalize_commit` with `project_id`, `commit_oid`, and `node_id`.
4. Confirm the finalizer returns `stored: true`; only then report that the collaboration summary was saved.

`trace.start` only opens the Trace Graph. `trace.create_checkpoint` only writes Git history. Neither tool invokes this Skill or generates an AI summary.


1. Identify the active Trace session and relevant visible conversation window.
2. Use the host's current live conversation context directly when available.
3. Extract:
   - `user_requests`
   - `ai_actions`
   - `decisions`
   - `direction_changes`
   - `outcomes`
   - `unresolved`
4. Query only minimal Git evidence needed to verify claimed outcomes.
5. If conversation claims conflict with repository evidence, preserve the conversation history but use repository evidence for the final-state outcome and note the conflict.
6. Redact secrets and credentials.
7. Validate against `schemas/work-trace-summary.schema.json`.
8. Persist through `trace_finalize_session` or the compatibility fallback.

## Context Rule

If the host model already has the active conversation in context, **do not export and re-inject the whole conversation**.

Summarize directly from the live context and send only the structured result to TraceAndBack.

Only use a bounded visible-conversation export/reference when the required Trace-session messages are no longer available to the skill.

## Output Rule

Follow `schemas/work-trace-summary.schema.json`.

Do not invent:
- user goals or constraints;
- decisions or rationales;
- completed outcomes;
- unresolved tasks.

A suggestion is not a decision unless it was accepted, rejected, superseded, deferred, or clearly acted upon.

## MCP Contract

Preferred call:

```json
{
  "tool": "trace_finalize_session",
  "arguments": {
    "project_id": "p_01",
    "session_id": "s_102",
    "commit_oid": "a71c92...",
    "work_summary": "<WorkTraceSummary>",
    "conversation_mode": "summary-only"
  }
}
```

If `trace_finalize_session` is unavailable, use the compatible finalize/update tools without blocking Git or Trace-node creation.

## Privacy

Use only host-visible content. Never request or persist hidden reasoning. Redact secrets before persistence. Default to structured summary storage rather than raw conversation storage.

## Reference

For detailed extraction examples, edge cases, verification rules, and compatibility behavior, read `docs/behavior-reference.md` only when needed.
