import type { OperationRecord, OperationRecovery, OperationResult, TraceNode } from "./checkpoint.js";
import type { ConversationAttachment } from "./conversation.js";
import type { TraceSession } from "./resume.js";
import type { RegisteredRepository } from "./types.js";

export type TraceNodeList = Readonly<{
  nodes: readonly TraceNode[];
  nextCursorPosition: number | null;
}>;

export interface TraceStore {
  findRepositoryByPath(repositoryPath: string): RegisteredRepository | null;
  getRepository(repositoryId: string): RegisteredRepository | null;
  saveRepository(repository: RegisteredRepository): void;
  getOperation(operationId: string): OperationRecord | null;
  listUnfinishedOperations(): readonly OperationRecord[];
  createOperation(operation: OperationRecord): void;
  markOperationGitApplied(operationId: string): void;
  markOperationPrepared(operationId: string): void;
  markOperationDatabaseApplied(operationId: string): void;
  markOperationVerified(operationId: string): void;
  markOperationRecoveryRequired(operationId: string, recovery: OperationRecovery): void;
  completeOperation(operationId: string, result: OperationResult): void;
  failOperation(operationId: string): void;
  createNode(node: TraceNode): void;
  getNode(nodeId: string): TraceNode | null;
  findNodeByCommit(repositoryId: string, commit: string): TraceNode | null;
  findLatestNode(repositoryId: string): TraceNode | null;
  listNodes(repositoryId: string, limit: number, beforeChronologyPosition: number | null): TraceNodeList;
  createSession(session: TraceSession): void;
  getSession(sessionId: string): TraceSession | null;
  findSessionByWorktree(repositoryId: string, worktreePath: string): TraceSession | null;
  findConversationAttachment(sessionId: string, provider: string, conversationId: string): ConversationAttachment | null;
  createConversationAttachment(attachment: ConversationAttachment): void;
  hasConversationForNode(nodeId: string): boolean;
}
