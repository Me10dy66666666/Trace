import type { AttachConversationResult } from "./conversation.js";
import type { ContinueResult } from "./resume.js";

export type TraceNode = Readonly<{
  id: string;
  repositoryId: string;
  commit: string;
  nodeType: "checkpoint" | "commit";
  title: string;
  gitParentNodeId: string | null;
  chronologicalParentNodeId: string | null;
  createdAt: string;
}>;

export type CheckpointResult = Readonly<{
  operationId: string;
  created: boolean;
  nodeId: string | null;
  commit: string | null;
  recoverable: boolean;
}>;

export type OperationResult = CheckpointResult | ContinueResult | AttachConversationResult;

export type ResumeOperationIntent = Readonly<{
  kind: "resume";
  sourceNodeId: string;
  targetCommit: string;
  branchName: string;
  worktreeName: string;
}>;

export type OperationIntent = ResumeOperationIntent | null;

export type OrphanedWorktreeRecovery = Readonly<{
  kind: "orphaned_worktree";
  sessionId: string;
  sourceNodeId: string;
  branch: string;
  worktreePath: string;
}>;

export type OperationRecovery = OrphanedWorktreeRecovery | null;

export type OperationRecord = Readonly<{
  id: string;
  repositoryId: string;
  intent: OperationIntent;
  operationType: "checkpoint" | "resume" | "attach_conversation";
  state: "PENDING" | "PREPARED" | "GIT_APPLIED" | "DB_APPLIED" | "VERIFIED" | "COMPLETED" | "FAILED" | "RECOVERY_REQUIRED";
  recovery: OperationRecovery;
  result: OperationResult | null;
  createdAt: string;
}>;
