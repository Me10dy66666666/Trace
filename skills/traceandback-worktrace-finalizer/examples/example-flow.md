# Example Flow

## Session

User: "登录经常掉，帮我看看。不要改后端。"

Assistant: investigates authentication and refresh flow.

User: "不要加第三方库。"

Assistant: compares mutex and queue strategies.

User: "用 queue。多 tab 这次先别做。"

Assistant: edits auth store and refresh logic, runs tests.

## Skill behavior

1. Read the current visible Trace-session conversation from host context.
2. Extract user goal and constraints.
3. Extract actual AI actions and tool-backed changes.
4. Record the queue decision and deferred multi-tab item.
5. Query TraceAndBack diff/test metadata only to verify final state.
6. Produce `WorkTraceSummary`.
7. Persist via `trace_finalize_session` or compatibility fallback.

## What the skill must NOT return

"Refactored authentication state management and added token refresh queue."

That is a code-change summary and loses the collaboration history.
