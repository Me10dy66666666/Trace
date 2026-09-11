# Repository centered MCP contract

The public MCP contract will use the dotted `trace.*` tool names and `repositoryId` terminology defined by the dedicated MCP specification, backed by an explicit local repository registry. Earlier development material uses `project_id` and underscore tool names; those remain historical examples rather than a second public contract. This eliminates ambiguity between a Git repository, an IDE workspace, and an MCP transport session.

## Considered Options

We considered exposing arbitrary paths to every mutating tool and retaining both naming styles. Those choices would weaken the filesystem safety model and create a breaking compatibility burden before v1 is stable.
