# Feature MVP core foundation

## Problem

The repository contains product and protocol design but no executable implementation of the safe history workflow.

## Goal

Deliver a local TypeScript MCP core that can register one Git repository, record Trace data, inspect its state, create a recoverable checkpoint, and safely continue from a historical node.

## Scope

- Local SQLite Trace store and durable operation journal.
- Repository fingerprinting, status inspection, lock management, secret scanning, checkpoint, and worktree-based continuation.
- Trace Node, Trace Session, Git/chronology relations, conversation-event attachment, and code-only summary fallback.
- The seven v1 MCP tools specified in `MCP-SPEC` and contract/integration tests.

## Out of Scope

- Workbuddy UI extension and graph rendering.
- Cloud sync, remote Git writes, team access, and external model-provider integration.
- Automatic merge, reset, force-push, or destructive branch operations.

## Acceptance Criteria

- A registered repository returns a safe, structured status.
- Dirty staged, unstaged, and untracked work becomes a recoverable checkpoint unless sensitive content is detected.
- Continuing from an old node creates a separate worktree and does not rewrite the current branch.
- Git and chronological relations remain independently queryable.
- Mutating operations are locked, journaled, idempotent by operation ID, and expose actionable errors.
- MCP schemas validate the minimum v1 tool set.

## Risk

Git state changes can endanger user code. All uncertain states must fail closed, checkpoint commits stay local, and every mutation must be verified before its journal entry is completed.
