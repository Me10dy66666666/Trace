# TraceAndBack WorkTrace Finalizer Skill

Version: 0.1.0

## Purpose

This skill turns the **current visible AI development conversation** into a structured TraceAndBack work-history summary and persists it through the TraceAndBack MCP/Core.

The summary is about the **human–AI collaboration process**, not a rewritten Git commit message.

Primary questions the skill must answer:

- What task did the user assign to the AI?
- What constraints or boundaries did the user set?
- What did the AI actually do?
- What alternatives were discussed or attempted?
- What decisions were explicitly made, rejected, or revised?
- Did the direction change during the session? Why?
- What outcome was reached?
- What remains unresolved or deferred?

Git metadata and diff are secondary evidence used to verify the final code outcome. They must not replace the conversation-derived work summary.

## Architecture Contract

The skill is the **orchestrator**.

The TraceAndBack MCP/Core is the **state and persistence backend**.

Recommended flow:

```text
Current host conversation context
        ↓
TraceAndBack WorkTrace Finalizer Skill
        ↓
Extract structured WorkTraceSummary
        ↓
Optional Git/diff verification through MCP
        ↓
Persist summary through TraceAndBack MCP/Core
```

Do not route raw conversation content through the MCP server only to send it back to a model for interpretation when the current host model already has the conversation in context.

## When to Run

Run this skill when any of the following occurs:

1. A Trace session is being finalized.
2. A Git commit is detected and needs a Trace Card summary.
3. The user explicitly asks to save/finalize the current development history.
4. The host is about to leave or close the current development context and a final summary is required.

Do not run on every message. Prefer one finalization per Trace session or meaningful development checkpoint.

## Evidence Priority

Use evidence in this order:

1. Current visible user/assistant conversation in the active Trace session.
2. Visible tool calls and tool results from the session.
3. Explicit user approvals, rejections, constraints, corrections, and reversals.
4. Test commands and results, when visible.
5. Git diff / changed files / commit metadata as verification of final outcome.
6. Previous Trace node summary only as background context.

Never treat the Git commit message as the primary source of the AI work summary.

## Privacy Boundary

Only use content that the host makes visible to the skill.

Never request, infer, store, or summarize hidden chain-of-thought or other non-user-visible model reasoning.

Before persistence:

- redact tokens, passwords, credentials, API keys, private keys, and authorization headers;
- avoid copying large raw conversation excerpts into the summary;
- prefer concise structured facts;
- preserve user wording only where necessary to represent an explicit decision or constraint.

## Required Output

Produce a JSON object conforming to `schemas/work-trace-summary.schema.json`.

Required semantic sections:

- `user_requests`
- `ai_actions`
- `decisions`
- `direction_changes`
- `outcomes`
- `unresolved`

Optional sections include session title, tests, affected areas, confidence, and source references.

## Extraction Rules

### User Requests

Capture the work the user assigned to the AI, not merely the resulting code change.

Good:

- "Fix intermittent login loss without changing the backend."
- "Replace the current implementation but do not add a third-party dependency."

Bad:

- "Modified authStore.ts."

### Constraints

Capture explicit boundaries such as:

- frontend-only / backend-only;
- do not change API shape;
- do not add dependencies;
- preserve compatibility;
- do not touch a given file/module;
- defer a known issue.

Do not invent constraints.

### AI Actions

Summarize meaningful actions actually performed or clearly attempted, for example:

- inspected authentication flow;
- traced duplicate refresh requests;
- compared queue and mutex approaches;
- edited specific modules;
- ran tests;
- reverted an unsuccessful approach.

Avoid generic filler such as "analyzed the issue" unless the conversation provides no more specific evidence.

### Decisions

A decision should record:

- `statement` — what was decided;
- `made_by` — user, ai, or joint;
- optional `rationale` — only if visible in conversation;
- optional `status` — accepted, rejected, superseded, deferred.

Do not convert every AI suggestion into a decision. Suggestions only become decisions when adopted, rejected, or clearly acted upon.

### Direction Changes

Record meaningful changes of plan, including:

- abandoning an earlier approach;
- narrowing scope;
- switching implementation strategy;
- reverting a change after test failure;
- deferring a subproblem.

If no meaningful direction change happened, return an empty array.

### Outcomes

State what was achieved at the end of the session.

Use Git/diff/tool evidence to verify outcomes where possible.

If the conversation says something was completed but repository evidence contradicts it, prefer repository evidence for the final state and add a note in `verification_notes`.

### Unresolved

Capture known remaining work, deferred items, failed attempts that matter later, and explicit follow-ups.

Do not create speculative TODOs.

## Git Verification

When TraceAndBack MCP exposes the relevant tools/resources, retrieve only the minimum evidence needed, such as:

- changed files;
- diff stat;
- selected patch excerpts;
- test status;
- current commit/node identifiers.

Use Git verification to answer:

- Did the claimed output actually land in the repository?
- Which files/areas changed?
- Were tests run and what was their visible result?

Do not regenerate the whole work summary from Git.

## Preferred MCP Contract

Preferred tool:

`trace_finalize_session`

Suggested input shape:

```json
{
  "project_id": "p_01",
  "session_id": "s_102",
  "commit_oid": "a71c92...",
  "work_summary": { "...": "WorkTraceSummary" },
  "conversation_mode": "summary-only"
}
```

Suggested output:

```json
{
  "node_id": "n_103",
  "session_id": "s_102",
  "generation_status": "completed",
  "stored": true
}
```

### Compatibility Mode

If `trace_finalize_session` is not available, use the existing TraceAndBack tool set in this order where supported:

1. finalize/create the Trace node using `trace_finalize_commit`;
2. persist the structured summary using `trace_update_summary` or a host-specific summary attachment tool;
3. attach raw conversation events only if project policy permits and the host explicitly provides them.

Do not fail the Git/Trace finalization merely because summary persistence is unavailable. Return the summary to the host and mark persistence as pending/partial.

## Host Context Rule

If the host already provides the active conversation in model context, do **not** export and re-inject the same full conversation before summarizing.

Use the live context directly.

Only request an explicit conversation export when:

- the host skill runtime does not retain the necessary visible context;
- the Trace session spans context windows not currently available;
- the host provides a dedicated conversation export/reference API.

When an export is necessary, prefer message references or a bounded session window instead of the user's entire account/chat history.

## Finalization Procedure

1. Identify the active Trace project/session.
2. Determine the visible conversation boundary for this Trace session.
3. Extract user requests and constraints.
4. Extract meaningful AI actions and tool-backed work.
5. Extract decisions, rejections, and deferred items.
6. Detect direction changes.
7. Derive outcomes and unresolved work.
8. Query minimal Git/diff/test evidence if available.
9. Reconcile conversation claims with repository evidence.
10. Redact secrets.
11. Validate against `work-trace-summary.schema.json`.
12. Persist through the preferred TraceAndBack MCP tool.
13. Return a compact host-facing confirmation containing node/session IDs and persistence status.

## Failure Behavior

### Conversation unavailable

If the host cannot expose the relevant visible conversation:

- do not fabricate collaboration history;
- create a code-only or partial summary;
- set `summary_mode` to `code-only` or `partial`;
- preserve Trace node creation.

### MCP unavailable

If TraceAndBack MCP is unavailable:

- return the validated WorkTraceSummary to the host;
- do not claim it was persisted;
- allow the host to retry persistence later.

### Summary validation fails

Repair only formatting/schema problems that do not require inventing facts.

If required semantic information is absent, use empty arrays and lower `confidence` rather than hallucinating events.

## Non-Goals

This skill does not:

- generate or rewrite Git commit messages as its primary output;
- save hidden reasoning;
- replace TraceAndBack Git safety/checkpoint logic;
- decide branch/worktree operations;
- perform destructive Git operations;
- summarize unrelated conversation outside the active Trace session.

## Example

Conversation-derived result:

```json
{
  "schema_version": "0.1",
  "summary_mode": "conversation-first",
  "title": "修复登录状态随机失效并约束为前端改动",
  "user_requests": [
    {
      "request": "修复登录状态随机失效",
      "constraints": ["只修改前端", "不增加第三方依赖"]
    }
  ],
  "ai_actions": [
    {
      "action": "检查认证与 token 刷新流程",
      "result": "定位到并发 401 触发重复 refresh"
    },
    {
      "action": "比较 mutex 与 queue 两种实现策略",
      "result": "采用 queue 方案"
    },
    {
      "action": "重构 authStore 并实现 refresh queue"
    }
  ],
  "decisions": [
    {
      "statement": "采用 refresh queue，不引入第三方依赖",
      "made_by": "joint",
      "status": "accepted"
    },
    {
      "statement": "多标签页同步本次不处理",
      "made_by": "user",
      "status": "deferred"
    }
  ],
  "direction_changes": [],
  "outcomes": ["单页面并发刷新流程已统一"],
  "unresolved": ["跨标签页认证状态同步尚未覆盖"],
  "tests": [],
  "verification_notes": [],
  "confidence": 0.92
}
```
