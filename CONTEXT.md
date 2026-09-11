# TraceAndBack

TraceAndBack preserves an AI-assisted development timeline for one registered Git repository. It keeps recoverable code states and their human-visible context without treating Git history as the entire development story.

## Language

**Repository**:
A Git repository explicitly registered with TraceAndBack and identified by a stable fingerprint.
_Avoid_: Project, workspace

**Trace Node**:
A recoverable development-history record associated with one Git commit, including an automatic checkpoint commit.
_Avoid_: Card, version

**Trace Session**:
A contiguous period of AI-assisted work that starts from a base Trace Node and can later produce one or more Trace Nodes.
_Avoid_: MCP session, chat session

**Trace Card**:
The visual presentation of a Trace Node for a human reader.
_Avoid_: Trace Node

**Git Parent**:
A Trace Node linked to a Git parent commit, representing code ancestry in the Git DAG.
_Avoid_: Previous node

**Chronological Parent**:
The Trace Node immediately preceding another node in the developer's real work sequence.
_Avoid_: Git Parent, source node

**Source Node**:
The historical Trace Node from which a new Trace Session begins, even when later commits have different Git parents.
_Avoid_: Chronological Parent

**Checkpoint**:
A Trace Node backed by an automatic, local-only Git commit that preserves a dirty working tree before a risky context change.
**Resume Intent**:
The recorded target state of a Continue From Operation Journal that identifies its source Trace Node, branch, and worktree for recovery.
_Avoid_: Request cache

**Orphaned Trace Session**:
A Trace Session reconstructed because its managed worktree survived but its original session record did not; it remains distinct from an active session until explicit recovery.
_Avoid_: Active session, abandoned worktree

_Avoid_: Stash, backup

**Continue From**:
Creating a new branch or worktree from a historical Trace Node while preserving the current development environment.
_Avoid_: Reset, rollback, checkout

**Operation Journal**:
The durable record of a mutating TraceAndBack operation and its recovery state.
_Avoid_: Log, audit trail

**Conversation Event**:
A user-visible AI or tool event attached to a Trace Session, subject to the repository's retention setting.
_Avoid_: Hidden reasoning, prompt trace
