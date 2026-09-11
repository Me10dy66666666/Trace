export type OperationState =
  | "PENDING"
  | "PREPARED"
  | "GIT_APPLIED"
  | "DB_APPLIED"
  | "VERIFIED"
  | "COMPLETED"
  | "FAILED"
  | "RECOVERY_REQUIRED";
