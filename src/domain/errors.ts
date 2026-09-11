export type TraceErrorCode =
  | "REPOSITORY_NOT_FOUND"
  | "NOT_A_GIT_REPOSITORY"
  | "REPO_NOT_REGISTERED"
  | "REPO_IDENTITY_CHANGED"
  | "NODE_NOT_FOUND"
  | "NODE_REPOSITORY_MISMATCH"
  | "SESSION_NOT_FOUND"
  | "INVALID_CURSOR"
  | "REPO_LOCKED"
  | "UNSAFE_GIT_STATE"
  | "SECRET_DETECTED"
  | "CHECKPOINT_FAILED"
  | "WORKTREE_CREATE_FAILED"
  | "VERIFY_FAILED"
  | "OPERATION_INTERRUPTED"
  | "DATABASE_ERROR";

export class TraceError extends Error {
  public constructor(
    public readonly code: TraceErrorCode,
    message: string,
    public readonly recoverable: boolean,
    public readonly details: Readonly<Record<string, unknown>> = {}
  ) {
    super(message);
    this.name = "TraceError";
  }
}
