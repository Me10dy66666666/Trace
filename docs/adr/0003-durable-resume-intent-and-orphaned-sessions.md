# Durable resume intent and orphaned sessions

## Status

Accepted

## Context

A process can stop after Git has created a continuation worktree but before TraceAndBack persists its Trace Session. An operation id by itself cannot prove which filesystem worktree belongs to that interrupted operation. Scanning every Git worktree would risk adopting or changing a user-managed worktree.

## Decision

Each resume operation records its immutable intent before Git mutation: source Trace Node, target commit, branch name, and generated worktree name. During startup recovery, the Git adapter locates only the exact managed branch and worktree identified by that intent. The core verifies its HEAD against the target commit.

If that exact worktree exists and no Trace Session was persisted, TraceAndBack creates an `orphaned` Trace Session and marks the operation `RECOVERY_REQUIRED`. It does not delete, reset, or silently adopt the worktree as active. If a matching active session already exists, a later recovery slice may safely complete the operation.

## Consequences

The operation journal carries enough evidence for safe reconciliation across a restart, and a future user-facing recovery flow has a durable session to present. Existing databases receive nullable intent and recovery-detail columns, so operations created by older releases remain recoverable only when their Git evidence is unambiguous.
