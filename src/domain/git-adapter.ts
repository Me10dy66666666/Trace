import type { ChangedFile } from "./node-detail.js";
import type { RepositoryInspection } from "./types.js";

export type CreateGitCheckpointInput = Readonly<{
  operationId: string;
  reason: string;
  repositoryPath: string;
}>;

export type CreateGitWorktreeInput = Readonly<{
  repositoryPath: string;
  targetCommit: string;
  branchName: string;
  worktreeName: string;
}>;

export type WorktreeEnvironment = Readonly<{
  branch: string;
  worktreePath: string;
}>;

export type FindGitWorktreeForResumeInput = Readonly<{
  repositoryPath: string;
  branchName: string;
  worktreeName: string;
}>;

export type LocatedGitCheckpoint = Readonly<{
  commit: string;
  parentCommit: string | null;
}>;

export type GitCommitSummary = Readonly<{
  commit: string;
  parentCommit: string | null;
  title: string;
  createdAt: string;
}>;

export interface GitAdapter {
  inspectRepository(repositoryPath: string): Promise<RepositoryInspection>;
  listCommits(repositoryPath: string, limit: number): Promise<readonly GitCommitSummary[]>;
  listVisibleChanges(repositoryPath: string): Promise<readonly string[]>;
  createCheckpoint(input: CreateGitCheckpointInput): Promise<string>;
  findCheckpointByOperationId(repositoryPath: string, operationId: string): Promise<LocatedGitCheckpoint | null>;
  verifyCommit(repositoryPath: string, commit: string): Promise<void>;
  getCommitChangedFiles(repositoryPath: string, commit: string): Promise<readonly ChangedFile[]>;
  compareCommits(repositoryPath: string, fromCommit: string, toCommit: string): Promise<readonly ChangedFile[]>;
  createWorktree(input: CreateGitWorktreeInput): Promise<WorktreeEnvironment>;
  findWorktreeForResume(input: FindGitWorktreeForResumeInput): Promise<WorktreeEnvironment | null>;
  verifyWorktreeHead(worktreePath: string, targetCommit: string): Promise<void>;
}
