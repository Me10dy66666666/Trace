# Local first safe Git operations

TraceAndBack will keep its metadata in a local SQLite database and perform every Git mutation through one operation manager that acquires a repository lock, writes an operation-journal record, validates Git state, and releases the lock. The default continuation path creates a new branch in the current worktree after requiring the user to save dirty work; an explicit separate-worktree strategy remains available when parallel isolation is desired. Destructive in-place history changes are rejected because the product's central promise is recoverability.

## Consequences

The MCP adapter remains stateless and thin, while recovery and idempotency live in the core. A process crash can leave an operation for recovery, but it must not silently discard user code.
