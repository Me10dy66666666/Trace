import { randomUUID } from "node:crypto";

import type { CheckpointResult, OperationRecord, TraceNode } from "../domain/checkpoint.js";
import type { TraceComparison } from "../domain/comparison.js";
import type { AttachConversationResult, ConversationAttachment } from "../domain/conversation.js";
import { TraceError } from "../domain/errors.js";
import type { GitAdapter } from "../domain/git-adapter.js";
import type { TraceHistoryPage } from "../domain/history.js";
import type { TraceNodeDetail } from "../domain/node-detail.js";
import type { ContinueResult, TraceSession } from "../domain/resume.js";
import type { TraceStore } from "../domain/trace-store.js";
import type { RegisteredRepository, RepositoryInspection, RepositoryStatus } from "../domain/types.js";
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
    const existing = this.dependencies.store.findRepositoryByPath(inspection.repositoryPath);

    if (existing !== null) {
      if (existing.fingerprint !== inspection.fingerprint) {
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

  public async getStatus(input: Readonly<{ repositoryId: string }>): Promise<RepositoryStatus> {
    const repository = this.requireRepository(input.repositoryId);
    const inspection = await this.inspectRegisteredRepository(repository);

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
    await Promise.all([
      this.dependencies.git.verifyCommit(repository.repositoryPath, from.commit),
      this.dependencies.git.verifyCommit(repository.repositoryPath, to.commit)
    ]);
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
    await this.dependencies.git.verifyCommit(repository.repositoryPath, node.commit);
    const changedFiles = await this.dependencies.git.getCommitChangedFiles(repository.repositoryPath, node.commit);

    return {
      id: node.id,
      commit: node.commit,
      summary: node.title,
      goal: node.title,
      decisions: [],
      changedFiles,
      gitParent: node.gitParentNodeId,
      chronologicalParent: node.chronologicalParentNodeId,
      conversationStatus: this.dependencies.store.hasConversationForNode(node.id) ? "available" : "unavailable"
    };
  }

  public async createCheckpoint(
    input: Readonly<{ operationId: string; reason: string; repositoryId: string }>
  ): Promise<CheckpointResult> {
    const previous = this.dependencies.store.getOperation(input.operationId);
    if (previous !== null) {
      return this.resolveRepeatedCheckpoint(previous);
    }

    const repository = this.requireRepository(input.repositoryId);
    const lock = await this.dependencies.locks.acquire(repository);
    let operationCreated = false;

    try {
      const afterLock = this.dependencies.store.getOperation(input.operationId);
      if (afterLock !== null) {
        return this.resolveRepeatedCheckpoint(afterLock);
      }

      const inspection = await this.inspectRegisteredRepository(repository);
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
        repository.repositoryPath,
        await this.dependencies.git.listVisibleChanges(repository.repositoryPath)
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
        repositoryPath: repository.repositoryPath
      });
      this.dependencies.store.markOperationGitApplied(input.operationId);
      await this.dependencies.git.verifyCommit(repository.repositoryPath, commit);

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
    input: Readonly<{ operationId: string; nodeId: string; checkpointCurrent: boolean }>
  ): Promise<ContinueResult> {
    const previous = this.dependencies.store.getOperation(input.operationId);
    if (previous !== null) {
      return this.resolveRepeatedResume(previous);
    }

    const target = this.requireNode(input.nodeId);
    const repository = this.requireRepository(target.repositoryId);
    const lock = await this.dependencies.locks.acquire(repository);
    let operationCreated = false;

    try {
      const afterLock = this.dependencies.store.getOperation(input.operationId);
      if (afterLock !== null) {
        return this.resolveRepeatedResume(afterLock);
      }

      const inspection = await this.inspectRegisteredRepository(repository);
      this.assertSafeMutationState(inspection);
      const branchName = this.createResumeBranchName(target.id, input.operationId);
      const worktreeName = this.createWorktreeName(target.id, input.operationId);
      await this.dependencies.git.verifyCommit(repository.repositoryPath, target.commit);
      const operation: OperationRecord = {
        id: input.operationId,
        repositoryId: repository.id,
        operationType: "resume",
        intent: {
          kind: "resume",
          sourceNodeId: target.id,
          targetCommit: target.commit,
          branchName,
          worktreeName
        },
        result: null,
        recovery: null,
        state: "PENDING",
        createdAt: this.now().toISOString()
      };
      this.dependencies.store.createOperation(operation);
      operationCreated = true;
      this.dependencies.store.markOperationPrepared(input.operationId);

      const checkpointNode = input.checkpointCurrent && inspection.dirty
        ? await this.createCheckpointForResume(repository, input.operationId, target.id, inspection.head)
        : null;

      const environment = await this.dependencies.git.createWorktree({
        repositoryPath: repository.repositoryPath,
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
        sessionId: session.id
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
      const environment = await this.dependencies.git.findWorktreeForResume({
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
    input: Readonly<{ repositoryId: string; limit: number }>
  ): Promise<TraceHistoryPage> {
    const repository = this.requireRepository(input.repositoryId);
    const limit = Math.min(Math.max(input.limit, 1), 100);
    const commits = await this.dependencies.git.listCommits(repository.repositoryPath, limit);
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

    return {
      nodes: commits.map((commit, index) => ({
        id: nodeIdByCommit.get(commit.commit) ?? commit.commit,
        commit: commit.commit,
        title: commit.title,
        createdAt: commit.createdAt,
        gitParent: commit.parentCommit === null
          ? null
          : nodeIdByCommit.get(commit.parentCommit) ?? null,
        chronologicalParent: commits[index + 1] === undefined
          ? null
          : nodeIdByCommit.get(commits[index + 1]?.commit ?? "") ?? null
      })),
      nextCursor: null
    };
  }

  private async createCheckpointForResume(
    repository: RegisteredRepository,
    operationId: string,
    sourceNodeId: string,
    gitParentCommit: string | null
  ): Promise<TraceNode> {
    const findings = await this.secretScanner.scan(
      repository.repositoryPath,
      await this.dependencies.git.listVisibleChanges(repository.repositoryPath)
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
      repositoryPath: repository.repositoryPath
    });
    this.dependencies.store.markOperationGitApplied(operationId);
    await this.dependencies.git.verifyCommit(repository.repositoryPath, commit);

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

  private async inspectRegisteredRepository(repository: RegisteredRepository): Promise<RepositoryInspection> {
    const inspection = await this.dependencies.git.inspectRepository(repository.repositoryPath);
    if (inspection.fingerprint !== repository.fingerprint) {
      throw new TraceError(
        "REPO_IDENTITY_CHANGED",
        "The registered repository fingerprint has changed.",
        false,
        { repositoryId: repository.id, repositoryPath: repository.repositoryPath }
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
      return operation.result;
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
