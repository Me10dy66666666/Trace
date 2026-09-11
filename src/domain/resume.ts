export type ContinueResult = Readonly<{
  operationId: string;
  sourceNode: string;
  checkpointNode: string | null;
  newBranch: string;
  worktreePath: string;
  sessionId: string;
}>;

export type TraceSession = Readonly<{
  id: string;
  repositoryId: string;
  baseNodeId: string;
  sourceNodeId: string;
  branch: string;
  worktreePath: string;
  startedAt: string;
  status: "active" | "orphaned";
}>;
