export type GitOperationState =
  | "normal"
  | "merge"
  | "rebase"
  | "cherry_pick"
  | "bisect"
  | "detached"
  | "unknown";

export type RegisteredRepository = Readonly<{
  id: string;
  repositoryPath: string;
  commonDirectory: string;
  fingerprint: string;
  defaultBranch: string | null;
  createdAt: string;
}>;

export type RepositoryInspection = Readonly<{
  repositoryPath: string;
  commonDirectory: string;
  fingerprint: string;
  head: string | null;
  branch: string | null;
  dirty: boolean;
  untrackedCount: number;
  operationState: GitOperationState;
}>;

export type RepositoryStatus = Readonly<{
  repositoryId: string;
  head: string | null;
  branch: string | null;
  dirty: boolean;
  untrackedCount: number;
  operationState: GitOperationState;
  activeTraceSession: string | null;
}>;
