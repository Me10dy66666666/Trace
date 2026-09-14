export type ResumeStrategy = "branch" | "worktree";

export type ContinueHandoff =
  | Readonly<{
      status: "user_action_required";
      branchCheckout: "current_worktree";
      requiresHostAction: false;
      instructions: readonly string[];
    }>
  | Readonly<{
      status: "host_action_required";
      branchCheckout: "exclusive_worktree";
      requiresHostAction: true;
      instructions: readonly string[];
    }>;

export function createContinueHandoff(strategy: ResumeStrategy = "worktree"): ContinueHandoff {
  if (strategy === "branch") {
    return {
      status: "user_action_required",
      branchCheckout: "current_worktree",
      requiresHostAction: false,
      instructions: [
        "新分支已经在当前项目工作区 checkout。",
        "请在当前项目工作区手动创建新的开发对话。",
        "不需要再次执行 git switch，也不需要创建额外 worktree。"
      ]
    };
  }

  return {
    status: "host_action_required",
    branchCheckout: "exclusive_worktree",
    requiresHostAction: true,
    instructions: [
      "新分支已经在返回的独立 worktree 中 checkout。",
      "不要在原工作区切换同名分支。",
      "请直接打开该 worktree，或使用宿主提供的 Handoff/工作区接管能力。"
    ]
  };
}

export type ContinueResult = Readonly<{
  operationId: string;
  sourceNode: string;
  checkpointNode: string | null;
  newBranch: string;
  worktreePath: string;
  sessionId: string;
  strategy: ResumeStrategy;
  hostHandoff: ContinueHandoff;
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
