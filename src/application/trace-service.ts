import { randomUUID } from "node:crypto";

import type { CheckpointResult, OperationRecord, TraceNode } from "../domain/checkpoint.js";
import type { TraceComparison } from "../domain/comparison.js";
import type { AttachConversationResult, ConversationAttachment } from "../domain/conversation.js";
import { TraceError } from "../domain/errors.js";
import type { GitAdapter } from "../domain/git-adapter.js";
import type { TraceHistoryPage } from "../domain/history.js";
import type { TraceNodeDetail } from "../domain/node-detail.js";
import {
  createContinueHandoff,
  type ContinueResult,
  type ResumeStrategy,
  type TraceSession
} from "../domain/resume.js";
import type { TraceStore } from "../domain/trace-store.js";
import type { RegisteredRepository, RepositoryInspection, RepositoryStatus } from "../domain/types.js";
import {
  parseWorkTraceSummary,
  type FinalizeSummaryResult,
  type SummaryConversationMode,
  type WorkTraceSummary,
  type WorkTraceSummaryRecord
} from "../domain/work-trace-summary.js";
import { FilesystemSecretScanner } from "../infrastructure/filesystem-secret-scanner.js";
import type { RepositoryLockManager } from "../infrastructure/repository-lock-manager.js";

export type TraceServiceDependencies = Readonly<{
  git: GitAdapter;
  locks: RepositoryLockManager;
  store: TraceStore;
  now?: () => Date;
}>;

export class TraceService {
  private readonly now: () => Date;
  private readonly secretScanner = new FilesystemSecretScanner();

  public constructor(private readonly dependencies: TraceServiceDependencies) {
    this.now = dependencies.now ?? (() => new Date());
  }

  public async recoverUnfinishedOperations(): Promise<readonly OperationRecord[]> {
    const recovered: OperationRecord[] = [];
    for (const operation of this.dependencies.store.listUnfinishedOperations()) {
      const reconciled = operation.operationType === "checkpoint"
        ? await this.recoverCheckpointOperation(operation)
        : await this.recoverResumeOperation(operation);
      if (reconciled !== null) {
        recovered.push(reconciled);
        continue;
      }
      this.dependencies.store.markOperationRecoveryRequired(operation.id, null);
      recovered.push({ ...operation, recovery: null, state: "RECOVERY_REQUIRED" });
    }
    return recovered;
  }

  public async registerRepository(input: Readonly<{ repositoryPath: string }>): Promise<RegisteredRepository> {
    const inspection = await this.dependencies.git.inspectRepository(input.repositoryPath);
    const existing = this.dependencies.store.findRepositoryByCommonDirectory(inspection.commonDirectory)
      ?? this.dependencies.store.findRepositoryByPath(inspection.repositoryPath);

    if (existing !== null) {
      if (existing.commonDirectory !== inspection.commonDirectory) {
        throw new TraceError(
          "REPO_IDENTITY_CHANGED",
          "The repository at this path no longer matches its registered identity.",
          false,
          { repositoryId: existing.id, repositoryPath: inspection.repositoryPath }
        );
      }
      return existing;
    }

    const repository: RegisteredRepository = {
      id: `repo_${randomUUID()}`,
      repositoryPath: inspection.repositoryPath,
      commonDirectory: inspection.commonDirectory,
      fingerprint: inspection.fingerprint,
      defaultBranch: inspection.branch,
      createdAt: this.now().toISOString()
    };
    this.dependencies.store.saveRepository(repository);
    return repository;
  }

  public async getStatus(
    input: Readonly<{ repositoryId: string; repositoryPath?: string }>
  ): Promise<RepositoryStatus> {
    const repository = this.requireRepository(input.repositoryId);
    const inspection = await this.inspectRegisteredRepository(repository, input.repositoryPath);

    return {
      repositoryId: repository.id,
      head: inspection.head,
      branch: inspection.branch,
      dirty: inspection.dirty,
      untrackedCount: inspection.untrackedCount,
      operationState: inspection.operationState,
      activeTraceSession: null
    };
  }

  public async getPublishedCommit(
    input: Readonly<{ repositoryId: string; repositoryPath?: string }>
  ): Promise<string | null> {
    const repository = this.requireRepository(input.repositoryId);
    return await this.dependencies.git.getPublishedCommit(input.repositoryPath ?? repository.repositoryPath);
  }

  public getHistory(input: Readonly<{ repositoryId: string; limit: number; cursor: string | null }>): TraceHistoryPage {
    this.requireRepository(input.repositoryId);
    const limit = Math.min(Math.max(input.limit, 1), 100);
    const page = this.dependencies.store.listNodes(
      input.repositoryId,
      limit,
      this.decodeHistoryCursor(input.cursor)
    );

    return {
      nodes: page.nodes.map((node) => ({
        id: node.id,
        commit: node.commit,
        title: node.title,
        createdAt: node.createdAt,
        gitParent: node.gitParentNodeId,
        chronologicalParent: node.chronologicalParentNodeId
      })),
      nextCursor: page.nextCursorPosition === null ? null : this.encodeHistoryCursor(page.nextCursorPosition)
    };
  }

  public async compare(input: Readonly<{ fromNode: string; toNode: string }>): Promise<TraceComparison> {
    const from = this.requireNode(input.fromNode);
    const to = this.requireNode(input.toNode);
    if (from.repositoryId !== to.repositoryId) {
      throw new TraceError(
        "NODE_REPOSITORY_MISMATCH",
        "Trace Nodes from different repositories cannot be compared.",
        false,
        { fromNode: from.id, toNode: to.id }
      );
    }

    const repository = this.requireRepository(from.repositoryId);
    const files = await this.dependencies.git.compareCommits(repository.repositoryPath, from.commit, to.commit);
    const additions = files.reduce((total, file) => total + file.additions, 0);
    const deletions = files.reduce((total, file) => total + file.deletions, 0);

    return {
      filesChanged: files.length,
      additions,
      deletions,
      summary: this.describeComparison(files.length, additions, deletions),
      files
    };
  }

  public async getNode(input: Readonly<{ nodeId: string }>): Promise<TraceNodeDetail> {
    const node = this.requireNode(input.nodeId);
    const repository = this.requireRepository(node.repositoryId);
    const changedFiles = await this.dependencies.git.getCommitChangedFiles(repository.repositoryPath, node.commit);

    const workSummary = this.dependencies.store.getWorkTraceSummary(node.id);
    const detail: TraceNodeDetail = {
      id: node.id,
      commit: node.commit,
      summary: node.title,
      goal: node.title,
      decisions: [],
      changedFiles,
      gitParent: node.gitParentNodeId,
      chronologicalParent: node.chronologicalParentNodeId,
      conversationStatus: this.dependencies.store.hasConversationForNode(node.id) || workSummary !== null
        ? "available"
        : "unavailable"
    };
    return workSummary === null
      ? detail
      : { ...detail, workSummary: workSummary.summary };
  }

  public async createCheckpoint(
    input: Readonly<{ operationId: string; reason: string; repositoryId: string; repositoryPath?: string }>
  ): Promise<CheckpointResult> {
    const previous = this.dependencies.store.getOperation(input.operationId);
    if (previous !== null) {
      return this.resolveRepeatedCheckpoint(previous);
    }

    const repository = this.requireRepository(input.repositoryId);
    const repositoryPath = input.repositoryPath ?? repository.repositoryPath;
    const lock = await this.dependencies.locks.acquire(repository);
    let operationCreated = false;

    try {
      const afterLock = this.dependencies.store.getOperation(input.operationId);
      if (afterLock !== null) {
        return this.resolveRepeatedCheckpoint(afterLock);
      }

      const inspection = await this.inspectRegisteredRepository(repository, repositoryPath);
      this.assertSafeMutationState(inspection);
      const operation: OperationRecord = {
        id: input.operationId,
        repositoryId: repository.id,
        intent: null,
        operationType: "checkpoint",
        result: null,
        recovery: null,
        state: "PENDING",
        createdAt: this.now().toISOString()
      };
      this.dependencies.store.createOperation(operation);
      operationCreated = true;
      this.dependencies.store.markOperationPrepared(input.operationId);

      if (!inspection.dirty) {
        const noOp: CheckpointResult = {
          operationId: input.operationId,
          created: false,
          nodeId: null,
          commit: inspection.head,
          recoverable: true
        };
        this.dependencies.store.completeOperation(input.operationId, noOp);
        return noOp;
      }

      const findings = await this.secretScanner.scan(
        repositoryPath,
        await this.dependencies.git.listVisibleChanges(repositoryPath)
      );
      if (findings.length > 0) {
        throw new TraceError(
          "SECRET_DETECTED",
          "Checkpoint blocked because a changed path may contain a secret.",
          false,
          { findings }
        );
      }

      const commit = await this.dependencies.git.createCheckpoint({
        operationId: input.operationId,
        reason: input.reason,
        repositoryPath
      });
      this.dependencies.store.markOperationGitApplied(input.operationId);
      await this.dependencies.git.verifyCommit(repositoryPath, commit);

      const node = this.createCheckpointNode(
        repository,
        commit,
        `Checkpoint: ${input.reason}`,
        inspection.head
      );
      this.dependencies.store.markOperationDatabaseApplied(input.operationId);
      const result: CheckpointResult = {
        operationId: input.operationId,
        created: true,
        nodeId: node.id,
        commit,
        recoverable: true
      };
      this.dependencies.store.markOperationVerified(input.operationId);
      this.dependencies.store.completeOperation(input.operationId, result);
      return result;
    } catch (error) {
      if (operationCreated) {
        this.dependencies.store.failOperation(input.operationId);
      }
      throw error;
    } finally {
      await lock.release();
    }
  }

  public async resumeFrom(
    input: Readonly<{
      operationId: string;
      nodeId: string;
      checkpointCurrent: boolean;
      strategy?: ResumeStrategy;
      repositoryPath?: string;
    }>
  ): Promise<ContinueResult> {
    const previous = this.dependencies.store.getOperation(input.operationId);
    if (previous !== null) {
      return this.resolveRepeatedResume(previous);
    }

    const strategy = input.strategy ?? "branch";
    const target = this.requireNode(input.nodeId);
    const repository = this.requireRepository(target.repositoryId);
    const repositoryPath = input.repositoryPath ?? repository.repositoryPath;
    const lock = await this.dependencies.locks.acquire(repository);
    let operationCreated = false;

    try {
      const afterLock = this.dependencies.store.getOperation(input.operationId);
      if (afterLock !== null) {
        return this.resolveRepeatedResume(afterLock);
      }

      const inspection = await this.inspectRegisteredRepository(repository, repositoryPath);
      this.assertSafeMutationState(inspection);
      if (strategy === "branch" && inspection.dirty) {
        throw new TraceError(
          "DIRTY_WORKTREE",
          "当前工作区存在未提交修改，请先提交或保存这些修改后再从历史版本继续。",
          true,
          {
            action: "commit_or_stash",
            branch: inspection.branch,
            repositoryPath,
            untrackedCount: inspection.untrackedCount
          }
        );
      }
      const branchName = this.createResumeBranchName(target.id, input.operationId);
      const worktreeName = this.createWorktreeName(target.id, input.operationId);
      await this.dependencies.git.verifyCommit(repositoryPath, target.commit);
      const operation: OperationRecord = {
        id: input.operationId,
        repositoryId: repository.id,
        operationType: "resume",
        intent: {
          kind: "resume",
          sourceNodeId: target.id,
          targetCommit: target.commit,
          branchName,
          worktreeName,
          strategy
        },
        result: null,
        recovery: null,
        state: "PENDING",
        createdAt: this.now().toISOString()
      };
      this.dependencies.store.createOperation(operation);
      operationCreated = true;
      this.dependencies.store.markOperationPrepared(input.operationId);

      const checkpointNode = strategy === "worktree" && input.checkpointCurrent && inspection.dirty
        ? await this.createCheckpointForResume(repository, repositoryPath, input.operationId, target.id, inspection.head)
        : null;

      const environment = strategy === "branch"
        ? await this.dependencies.git.createBranchAndCheckout({
            repositoryPath,
            targetCommit: target.commit,
            branchName
          })
        : await this.dependencies.git.createWorktree({
            repositoryPath,
            targetCommit: target.commit,
            branchName,
            worktreeName
          });
      if (checkpointNode === null) {
        this.dependencies.store.markOperationGitApplied(input.operationId);
      }
      await this.dependencies.git.verifyWorktreeHead(environment.worktreePath, target.commit);

      const session: TraceSession = {
        id: `session_${randomUUID()}`,
        repositoryId: repository.id,
        baseNodeId: target.id,
        sourceNodeId: target.id,
        branch: environment.branch,
        worktreePath: environment.worktreePath,
        startedAt: this.now().toISOString(),
        status: "active"
      };
      this.dependencies.store.createSession(session);
      this.dependencies.store.markOperationDatabaseApplied(input.operationId);
      const result: ContinueResult = {
        operationId: input.operationId,
        sourceNode: target.id,
        checkpointNode: checkpointNode?.id ?? null,
        newBranch: environment.branch,
        worktreePath: environment.worktreePath,
        sessionId: session.id,
        strategy,
        hostHandoff: createContinueHandoff(strategy)
      };
      this.dependencies.store.markOperationVerified(input.operationId);
      this.dependencies.store.completeOperation(input.operationId, result);
      return result;
    } catch (error) {
      if (operationCreated) {
        this.dependencies.store.failOperation(input.operationId);
      }
      throw error;
    } finally {
      await lock.release();
    }
  }

  public async attachConversation(
    input: Readonly<{ operationId: string; sessionId: string; provider: string; conversationId: string }>
  ): Promise<AttachConversationResult> {
    const previous = this.dependencies.store.getOperation(input.operationId);
    if (previous !== null) {
      return this.resolveRepeatedAttachment(previous);
    }

    const session = this.requireSession(input.sessionId);
    const repository = this.requireRepository(session.repositoryId);
    const lock = await this.dependencies.locks.acquire(repository);
    let operationCreated = false;

    try {
      const afterLock = this.dependencies.store.getOperation(input.operationId);
      if (afterLock !== null) {
        return this.resolveRepeatedAttachment(afterLock);
      }

      const operation: OperationRecord = {
        id: input.operationId,
        repositoryId: repository.id,
        operationType: "attach_conversation",
        intent: null,
        result: null,
        recovery: null,
        state: "PENDING",
        createdAt: this.now().toISOString()
      };
      this.dependencies.store.createOperation(operation);
      operationCreated = true;
      this.dependencies.store.markOperationPrepared(input.operationId);

      const existing = this.dependencies.store.findConversationAttachment(
        session.id,
        input.provider,
        input.conversationId
      );
      if (existing === null) {
        const attachment: ConversationAttachment = {
          id: "conversation_" + randomUUID(),
          sessionId: session.id,
          provider: input.provider,
          conversationId: input.conversationId,
          retention: "summary",
          attachedAt: this.now().toISOString()
        };
        this.dependencies.store.createConversationAttachment(attachment);
      }
      this.dependencies.store.markOperationDatabaseApplied(input.operationId);

      const result: AttachConversationResult = { operationId: input.operationId, attached: true };
      this.dependencies.store.markOperationVerified(input.operationId);
      this.dependencies.store.completeOperation(input.operationId, result);
      return result;
    } catch (error) {
      if (operationCreated) {
        this.dependencies.store.failOperation(input.operationId);
      }
      throw error;
    } finally {
      await lock.release();
    }
  }

  public async finalizeSession(
    input: Readonly<{
      projectId: string;
      sessionId: string;
      commitOid?: string;
      nodeId?: string;
      workSummary: unknown;
      conversationMode?: SummaryConversationMode;
      operationId?: string;
    }>
  ): Promise<FinalizeSummaryResult> {
    const summary = parseWorkTraceSummary(input.workSummary);
    const session = this.requireSession(input.sessionId);
    const repository = this.requireRepository(input.projectId);
    this.assertSessionRepository(session.repositoryId, repository.id, session.id);
    const node = await this.resolveSummaryNode(repository, {
      nodeId: input.nodeId,
      commitOid: input.commitOid,
      fallbackNodeId: session.sourceNodeId,
      allowCreate: false
    });
    return this.persistWorkTraceSummary({
      node,
      sessionId: session.id,
      workSummary: summary,
      conversationMode: input.conversationMode,
      operationId: input.operationId
    });
  }

  public async finalizeCommit(
    input: Readonly<{
      projectId: string;
      commitOid: string;
      nodeId?: string;
      sessionId?: string;
      workSummary: unknown;
      conversationMode?: SummaryConversationMode;
      operationId?: string;
    }>
  ): Promise<FinalizeSummaryResult> {
    const summary = parseWorkTraceSummary(input.workSummary);
    const repository = this.requireRepository(input.projectId);
    const session = input.sessionId === undefined ? null : this.requireSession(input.sessionId);
    if (session !== null) {
      this.assertSessionRepository(session.repositoryId, repository.id, session.id);
    }
    const node = await this.resolveSummaryNode(repository, {
      nodeId: input.nodeId,
      commitOid: input.commitOid,
      allowCreate: true
    });
    return this.persistWorkTraceSummary({
      node,
      sessionId: session?.id ?? null,
      workSummary: summary,
      conversationMode: input.conversationMode,
      operationId: input.operationId
    });
  }

  public async updateSummary(
    input: Readonly<{
      projectId: string;
      nodeId: string;
      sessionId?: string;
      commitOid?: string;
      workSummary: unknown;
      conversationMode?: SummaryConversationMode;
      operationId?: string;
    }>
  ): Promise<FinalizeSummaryResult> {
    const summary = parseWorkTraceSummary(input.workSummary);
    const repository = this.requireRepository(input.projectId);
    const session = input.sessionId === undefined ? null : this.requireSession(input.sessionId);
    if (session !== null) {
      this.assertSessionRepository(session.repositoryId, repository.id, session.id);
    }
    const node = await this.resolveSummaryNode(repository, {
      nodeId: input.nodeId,
      commitOid: input.commitOid,
      allowCreate: false
    });
    return this.persistWorkTraceSummary({
      node,
      sessionId: session?.id ?? null,
      workSummary: summary,
      conversationMode: input.conversationMode,
      operationId: input.operationId
    });
  }

  private async resolveSummaryNode(
    repository: RegisteredRepository,
    input: Readonly<{
      nodeId?: string;
      commitOid?: string;
      fallbackNodeId?: string;
      allowCreate: boolean;
    }>
  ): Promise<TraceNode> {
    const requestedNodeId = input.nodeId ?? input.fallbackNodeId;
    if (requestedNodeId !== undefined) {
      const node = this.requireNode(requestedNodeId);
      if (node.repositoryId !== repository.id) {
        throw new TraceError(
          "NODE_REPOSITORY_MISMATCH",
          "The summary target node belongs to a different repository.",
          false,
          { nodeId: node.id, repositoryId: repository.id }
        );
      }
      if (input.commitOid !== undefined && input.commitOid !== node.commit) {
        throw new TraceError(
          "NODE_REPOSITORY_MISMATCH",
          "The supplied commit does not match the summary target node.",
          false,
          { nodeId: node.id, commitOid: input.commitOid, nodeCommit: node.commit }
        );
      }
      await this.dependencies.git.verifyCommit(repository.repositoryPath, node.commit);
      return node;
    }

    if (input.commitOid === undefined) {
      throw new TraceError(
        "NODE_NOT_FOUND",
        "A Trace Node or commit is required to persist a work summary.",
        false,
        { repositoryId: repository.id }
      );
    }

    await this.dependencies.git.verifyCommit(repository.repositoryPath, input.commitOid);
    const existing = this.dependencies.store.findNodeByCommit(repository.id, input.commitOid);
    if (existing !== null) {
      return existing;
    }
    if (!input.allowCreate) {
      throw new TraceError(
        "NODE_NOT_FOUND",
        "The requested commit does not have a Trace Node.",
        false,
        { commit: input.commitOid, repositoryId: repository.id }
      );
    }

    await this.getGitHistory({ repositoryId: repository.id, limit: 100 });
    const created = this.dependencies.store.findNodeByCommit(repository.id, input.commitOid);
    if (created === null) {
      throw new TraceError(
        "NODE_NOT_FOUND",
        "The requested commit is outside the available Trace history.",
        true,
        { commit: input.commitOid, repositoryId: repository.id }
      );
    }
    return created;
  }

  private persistWorkTraceSummary(
    input: Readonly<{
      node: TraceNode;
      sessionId: string | null;
      workSummary: WorkTraceSummary;
      conversationMode?: SummaryConversationMode;
      operationId?: string;
    }>
  ): FinalizeSummaryResult {
    if (input.operationId !== undefined) {
      const previous = this.dependencies.store.findWorkTraceSummaryByOperationId(input.operationId);
      if (previous !== null) {
        if (previous.nodeId !== input.node.id) {
          throw new TraceError(
            "SUMMARY_OPERATION_REUSED",
            "The summary operation id was already used for a different Trace Node.",
            false,
            { operationId: input.operationId, nodeId: input.node.id, previousNodeId: previous.nodeId }
          );
        }
        return this.summaryResult(previous);
      }
    }

    const existing = this.dependencies.store.getWorkTraceSummary(input.node.id);
    const now = this.now().toISOString();
    const record: WorkTraceSummaryRecord = {
      nodeId: input.node.id,
      repositoryId: input.node.repositoryId,
      sessionId: input.sessionId ?? existing?.sessionId ?? null,
      commitOid: input.node.commit,
      conversationMode: input.conversationMode ?? existing?.conversationMode ?? "summary-only",
      operationId: input.operationId ?? existing?.operationId ?? null,
      summary: input.workSummary,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    this.dependencies.store.saveWorkTraceSummary(record);
    return this.summaryResult(record);
  }

  private summaryResult(record: WorkTraceSummaryRecord): FinalizeSummaryResult {
    return {
      node_id: record.nodeId,
      session_id: record.sessionId,
      generation_status: "completed",
      stored: true
    };
  }

  private assertSessionRepository(sessionRepositoryId: string, repositoryId: string, sessionId: string): void {
    if (sessionRepositoryId === repositoryId) {
      return;
    }
    throw new TraceError(
      "NODE_REPOSITORY_MISMATCH",
      "The Trace Session belongs to a different repository.",
      false,
      { sessionId, sessionRepositoryId, repositoryId }
    );
  }

  private describeComparison(filesChanged: number, additions: number, deletions: number): string {
    const fileLabel = filesChanged === 1 ? "file" : "files";
    const additionLabel = additions === 1 ? "addition" : "additions";
    const deletionLabel = deletions === 1 ? "deletion" : "deletions";
    return String(filesChanged) + " " + fileLabel + " changed, " + String(additions) + " " + additionLabel + ", " + String(deletions) + " " + deletionLabel;
  }

  private async recoverCheckpointOperation(operation: OperationRecord): Promise<OperationRecord | null> {
    if (operation.operationType !== "checkpoint") {
      return null;
    }
    const repository = this.dependencies.store.getRepository(operation.repositoryId);
    if (repository === null) {
      return null;
    }

    try {
      const checkpoint = await this.dependencies.git.findCheckpointByOperationId(
        repository.repositoryPath,
        operation.id
      );
      if (checkpoint === null) {
        return null;
      }
      await this.dependencies.git.verifyCommit(repository.repositoryPath, checkpoint.commit);
      const existingNode = this.dependencies.store.findNodeByCommit(repository.id, checkpoint.commit);
      const node = existingNode?.nodeType === "checkpoint"
        ? existingNode
        : this.createCheckpointNode(
          repository,
          checkpoint.commit,
          `Recovered checkpoint: ${operation.id}`,
          checkpoint.parentCommit
        );
      const result: CheckpointResult = {
        operationId: operation.id,
        created: true,
        nodeId: node.id,
        commit: checkpoint.commit,
        recoverable: true
      };
      this.dependencies.store.completeOperation(operation.id, result);
      return { ...operation, state: "COMPLETED", result };
    } catch {
      return null;
    }
  }

  private async recoverResumeOperation(operation: OperationRecord): Promise<OperationRecord | null> {
    const intent = operation.intent;
    if (operation.operationType !== "resume" || intent === null || intent.kind !== "resume") {
      return null;
    }
    const repository = this.dependencies.store.getRepository(operation.repositoryId);
    const sourceNode = this.dependencies.store.getNode(intent.sourceNodeId);
    if (
      repository === null ||
      sourceNode === null ||
      sourceNode.repositoryId !== repository.id ||
      sourceNode.commit !== intent.targetCommit
    ) {
      return null;
    }

    try {
      const strategy = intent.strategy ?? "worktree";
      const environment = strategy === "branch"
        ? await this.dependencies.git.findBranchCheckoutForResume({
            repositoryPath: repository.repositoryPath,
            branchName: intent.branchName
          })
        : await this.dependencies.git.findWorktreeForResume({
            repositoryPath: repository.repositoryPath,
            branchName: intent.branchName,
            worktreeName: intent.worktreeName
          });
      if (environment === null) {
        return null;
      }
      await this.dependencies.git.verifyWorktreeHead(environment.worktreePath, intent.targetCommit);
      if (this.dependencies.store.findSessionByWorktree(repository.id, environment.worktreePath) !== null) {
        return null;
      }

      const session: TraceSession = {
        id: `session_${randomUUID()}`,
        repositoryId: repository.id,
        baseNodeId: sourceNode.id,
        sourceNodeId: sourceNode.id,
        branch: environment.branch,
        worktreePath: environment.worktreePath,
        startedAt: operation.createdAt,
        status: "orphaned"
      };
      this.dependencies.store.createSession(session);
      const recovery = {
        kind: "orphaned_worktree" as const,
        sessionId: session.id,
        sourceNodeId: sourceNode.id,
        branch: environment.branch,
        worktreePath: environment.worktreePath
      };
      this.dependencies.store.markOperationRecoveryRequired(operation.id, recovery);
      return { ...operation, recovery, state: "RECOVERY_REQUIRED" };
    } catch {
      return null;
    }
  }

  public async getGitHistory(
    input: Readonly<{ repositoryId: string; limit: number; repositoryPath?: string }>
  ): Promise<TraceHistoryPage> {
    const repository = this.requireRepository(input.repositoryId);
    const limit = Math.min(Math.max(input.limit, 1), 100);
    const repositoryPath = input.repositoryPath ?? repository.repositoryPath;
    const commits = await this.dependencies.git.listCommits(repositoryPath, limit);
    const existingByCommit = new Map<string, TraceNode | null>();
    const nodeIdByCommit = new Map<string, string>();

    for (const commit of commits) {
      const existing = this.dependencies.store.findNodeByCommit(repository.id, commit.commit);
      existingByCommit.set(commit.commit, existing);
      nodeIdByCommit.set(commit.commit, existing?.id ?? `node_${randomUUID()}`);
    }

    for (let index = commits.length - 1; index >= 0; index -= 1) {
      const commit = commits[index];
      if (commit === undefined || existingByCommit.get(commit.commit) !== null) {
        continue;
      }
      const olderCommit = commits[index + 1];
      const gitParentNodeId = commit.parentCommit === null
        ? null
        : nodeIdByCommit.get(commit.parentCommit)
          ?? this.dependencies.store.findNodeByCommit(repository.id, commit.parentCommit)?.id
          ?? null;
      this.dependencies.store.createNode({
        id: nodeIdByCommit.get(commit.commit) ?? `node_${randomUUID()}`,
        repositoryId: repository.id,
        commit: commit.commit,
        nodeType: "commit",
        title: commit.title,
        gitParentNodeId,
        chronologicalParentNodeId: olderCommit === undefined
          ? null
          : nodeIdByCommit.get(olderCommit.commit) ?? null,
        createdAt: commit.createdAt
      });
    }

    return this.getHistory({ repositoryId: repository.id, limit, cursor: null });
  }

  private async createCheckpointForResume(
    repository: RegisteredRepository,
    repositoryPath: string,
    operationId: string,
    sourceNodeId: string,
    gitParentCommit: string | null
  ): Promise<TraceNode> {
    const findings = await this.secretScanner.scan(
      repositoryPath,
      await this.dependencies.git.listVisibleChanges(repositoryPath)
    );
    if (findings.length > 0) {
      throw new TraceError(
        "SECRET_DETECTED",
        "Continuation blocked because the current workspace may contain a secret.",
        false,
        { findings }
      );
    }

    const commit = await this.dependencies.git.createCheckpoint({
      operationId,
      reason: `before_resume_from_${sourceNodeId}`,
      repositoryPath
    });
    this.dependencies.store.markOperationGitApplied(operationId);
    await this.dependencies.git.verifyCommit(repositoryPath, commit);

    return this.createCheckpointNode(
      repository,
      commit,
      `Checkpoint: before continuing from ${sourceNodeId}`,
      gitParentCommit
    );
  }

  private createCheckpointNode(
    repository: RegisteredRepository,
    commit: string,
    title: string,
    gitParentCommit: string | null
  ): TraceNode {
    const gitParentNodeId = gitParentCommit === null
      ? null
      : this.dependencies.store.findNodeByCommit(repository.id, gitParentCommit)?.id ?? null;
    const chronologicalParentNodeId = this.dependencies.store.findLatestNode(repository.id)?.id ?? null;
    const node: TraceNode = {
      id: `node_${randomUUID()}`,
      repositoryId: repository.id,
      commit,
      nodeType: "checkpoint",
      title,
      gitParentNodeId,
      chronologicalParentNodeId,
      createdAt: this.now().toISOString()
    };
    this.dependencies.store.createNode(node);
    return node;
  }

  private requireSession(sessionId: string): TraceSession {
    const session = this.dependencies.store.getSession(sessionId);
    if (session === null) {
      throw new TraceError("SESSION_NOT_FOUND", "Trace Session was not found: " + sessionId, false, { sessionId });
    }
    return session;
  }

  private requireRepository(repositoryId: string): RegisteredRepository {
    const repository = this.dependencies.store.getRepository(repositoryId);
    if (repository === null) {
      throw new TraceError(
        "REPO_NOT_REGISTERED",
        `Repository is not registered: ${repositoryId}`,
        false,
        { repositoryId }
      );
    }
    return repository;
  }

  private requireNode(nodeId: string): TraceNode {
    const node = this.dependencies.store.getNode(nodeId);
    if (node === null) {
      throw new TraceError("NODE_NOT_FOUND", `Trace Node was not found: ${nodeId}`, false, { nodeId });
    }
    return node;
  }

  private async inspectRegisteredRepository(
    repository: RegisteredRepository,
    repositoryPath = repository.repositoryPath
  ): Promise<RepositoryInspection> {
    const inspection = await this.dependencies.git.inspectRepository(repositoryPath);
    if (inspection.commonDirectory !== repository.commonDirectory) {
      throw new TraceError(
        "REPO_IDENTITY_CHANGED",
        "The repository path does not belong to the registered repository.",
        false,
        { repositoryId: repository.id, repositoryPath }
      );
    }
    return inspection;
  }

  private assertSafeMutationState(inspection: RepositoryInspection): void {
    if (inspection.operationState === "normal" || inspection.operationState === "detached") {
      return;
    }
    throw new TraceError(
      "UNSAFE_GIT_STATE",
      `Repository is currently in an unsafe Git state: ${inspection.operationState}.`,
      true,
      { state: inspection.operationState }
    );
  }

  private resolveRepeatedCheckpoint(operation: OperationRecord): CheckpointResult {
    if (
      operation.operationType === "checkpoint" &&
      operation.state === "COMPLETED" &&
      operation.result !== null &&
      "created" in operation.result
    ) {
      return operation.result;
    }
    throw new TraceError(
      "OPERATION_INTERRUPTED",
      `Operation ${operation.id} is not complete and needs recovery before it can be retried.`,
      true,
      { operationId: operation.id, state: operation.state }
    );
  }

  private resolveRepeatedResume(operation: OperationRecord): ContinueResult {
    if (
      operation.operationType === "resume" &&
      operation.state === "COMPLETED" &&
      operation.result !== null &&
      "sourceNode" in operation.result
    ) {
      return {
        ...operation.result,
        strategy: operation.result.strategy ?? operation.intent?.strategy ?? "worktree",
        hostHandoff: operation.result.hostHandoff
          ?? createContinueHandoff(operation.result.strategy ?? operation.intent?.strategy ?? "worktree")
      };
    }
    throw new TraceError(
      "OPERATION_INTERRUPTED",
      `Operation ${operation.id} is not complete and needs recovery before it can be retried.`,
      true,
      { operationId: operation.id, state: operation.state }
    );
  }

  private resolveRepeatedAttachment(operation: OperationRecord): AttachConversationResult {
    if (
      operation.operationType === "attach_conversation" &&
      operation.state === "COMPLETED" &&
      operation.result !== null &&
      "attached" in operation.result
    ) {
      return operation.result;
    }
    throw new TraceError(
      "OPERATION_INTERRUPTED",
      "Operation " + operation.id + " is not complete and needs recovery before it can be retried.",
      true,
      { operationId: operation.id, state: operation.state }
    );
  }

  private encodeHistoryCursor(position: number): string {
    return `chronology:${position}`;
  }

  private decodeHistoryCursor(cursor: string | null): number | null {
    if (cursor === null) {
      return null;
    }
    const match = /^chronology:([1-9]\d*)$/.exec(cursor);
    if (match?.[1] === undefined) {
      throw new TraceError("INVALID_CURSOR", "The history cursor is invalid.", false, { cursor });
    }
    const position = Number(match[1]);
    if (!Number.isSafeInteger(position)) {
      throw new TraceError("INVALID_CURSOR", "The history cursor is invalid.", false, { cursor });
    }
    return position;
  }

  private createResumeBranchName(nodeId: string, operationId: string): string {
    return `trace/${this.safeIdentifier(nodeId)}-${this.safeIdentifier(operationId)}`;
  }

  private createWorktreeName(nodeId: string, operationId: string): string {
    return `node-${this.safeIdentifier(nodeId)}-${this.safeIdentifier(operationId)}`;
  }

  private safeIdentifier(value: string): string {
    const normalized = value.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
    return normalized === "" ? "operation" : normalized.slice(0, 48);
  }
}
