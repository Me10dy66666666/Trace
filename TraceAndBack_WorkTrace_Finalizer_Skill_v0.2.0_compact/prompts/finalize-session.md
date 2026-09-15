# Finalize Trace Session Prompt

Use the current visible conversation for the active Trace session as the primary evidence.

Produce a structured WorkTraceSummary that explains the human–AI collaboration process:

1. What the user asked the AI to do.
2. Explicit user constraints and boundaries.
3. What the AI actually did or attempted.
4. Important options considered.
5. Decisions that were accepted, rejected, superseded, or deferred.
6. Any meaningful change of direction and why it changed.
7. Final outcomes.
8. Known unresolved work or follow-ups.
9. Visible test results.

Do not summarize primarily from the Git commit message.

If Git/diff evidence is available, use it only to verify the final outcome and affected areas. If conversation claims and repository evidence conflict, record the discrepancy in `verification_notes` and prefer repository evidence for the final state.

Do not include hidden chain-of-thought. Do not invent rationale, decisions, constraints, tests, or follow-ups.

Redact credentials and secrets before persistence.

Return JSON matching `schemas/work-trace-summary.schema.json`.
