# Local first safe Git operations

TraceAndBack will keep its metadata in a local SQLite database and perform every Git mutation through one operation manager that acquires a repository lock, writes an operation-journal record, validates Git state, verifies the result, and releases the lock. The alternative of direct MCP-handler shell calls or destructive in-place history changes is rejected because the product's central promise is recoverability: continuation creates a worktree by default and preserves dirty work through a checkpoint.

## Consequences

The MCP adapter remains stateless and thin, while recovery and idempotency live in the core. A process crash can leave an operation for recovery, but it must not silently discard user code.
