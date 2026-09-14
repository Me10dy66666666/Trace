# Current-worktree continuation and conversation boundary

## Status

Accepted

## Context

The product continuation action is an in-place recovery action. The user explicitly accepts responsibility for saving any current work before returning to history, so the default path must create a named branch and check the historical commit out in the current registered worktree. TraceAndBack must not create an additional worktree for this default action.

An MCP App does not own the Agent Host's conversation lifecycle. Sending a ui/message request or a follow-up message does not create a new Codex task. The user can create that task manually after the current project worktree has been switched.

## Decision

trace.resume_from defaults to strategy=branch. It acquires the repository lock, rejects a dirty current worktree with DIRTY_WORKTREE before any mutation, creates trace/..., checks the target commit out in the current worktree, verifies HEAD, and creates the Trace Session. The original branch ref remains at its previous commit.

The Trace Graph UI calls this branch strategy and does not send an automatic host conversation request. It tells the user to create a new conversation manually in the current project and can copy the relevant startup information.

strategy=worktree remains an explicit compatibility and safety option. It retains the separate-worktree behavior and returns hostHandoff.status=host_action_required, because that branch is exclusively checked out in the returned worktree.

## Consequences

The original branch is preserved, and no workaround may use git switch --ignore-other-worktrees. If the current worktree is dirty, the user must commit or otherwise save the work before retrying; TraceAndBack does not silently checkpoint it in the default branch strategy.
