# TraceAndBack MCP Interface Specification

版本：v1.0  
目标 MCP Protocol：2026-07-28  
建议实现：TypeScript MCP SDK v2

## 1. 目的

TraceAndBack MCP Server 向 AI Host 提供统一的项目历史、代码状态、Trace 数据和安全恢复能力。

核心职责：

```text
AI Host
    ↓
TraceAndBack MCP
    ↓
Trace Domain
    ↓
Git / Database / Conversation
```

MCP 层只负责协议适配。

Git 安全逻辑必须存在于独立 Domain/Service Layer。

## 2. MCP Protocol 基线

目标协议：

```text
2026-07-28
```

实现不得依赖旧版本必须存在的：

```text
initialize
initialized
Mcp-Session-Id
```

Server 应按照 stateless request core 设计。

服务器自己的 Trace Session 属于：

```text
application state
```

不是 MCP transport session。

## 3. Server Identity

建议：

```text
name:
traceandback

version:
0.1.0
```

## 4. Namespace

所有公开 Tool 使用：

```text
trace.*
```

例如：

```text
trace.get_history
trace.get_node
trace.get_status
trace.create_checkpoint
trace.resume_from
trace.compare
```

这样可以避免与 Host 其他 Git Tool 冲突。

## 5. Tool 分类

### Read Tools

不会修改代码：

```text
trace.get_status
trace.get_history
trace.get_node
trace.compare
trace.get_conversation
trace.search
```

### Mutating Tools

可能修改 Git/DB：

```text
trace.create_checkpoint
trace.resume_from
trace.attach_conversation
trace.create_tag
```

所有 mutating tool 必须进入：

```text
OperationManager
```

## 6. trace.get_status

用途：读取当前 repository 状态。

Input：

```json
{
  "repository": "/path/to/repo"
}
```

Output：

```json
{
  "repositoryId": "repo_123",
  "head": "a73c11",
  "branch": "main",
  "dirty": true,
  "untrackedCount": 2,
  "operationState": "normal",
  "activeTraceSession": "session_52"
}
```

operationState：

```text
normal
merge
rebase
cherry_pick
bisect
detached
unknown
```

Read-only：

```text
true
```

## 7. trace.get_history

用途：获取 Trace Timeline。

Input：

```json
{
  "repositoryId": "repo_123",
  "limit": 50,
  "cursor": null
}
```

Output：

```json
{
  "nodes": [
    {
      "id": "node_31",
      "commit": "a73c11",
      "title": "Refactor auth refresh",
      "createdAt": "2026-09-11T08:32:00Z",
      "gitParent": "node_27",
      "chronologicalParent": "node_30"
    }
  ],
  "nextCursor": null
}
```

排序默认：

```text
chronology DESC
```

## 8. trace.get_node

Input：

```json
{
  "nodeId": "node_31"
}
```

Output：

```json
{
  "id": "node_31",
  "commit": "a73c11",
  "summary": "...",
  "goal": "...",
  "decisions": [
    {
      "title": "Use refresh token rotation",
      "reason": "..."
    }
  ],
  "changedFiles": [
    {
      "path": "src/auth.ts",
      "additions": 42,
      "deletions": 11
    }
  ],
  "gitParent": "node_27",
  "chronologicalParent": "node_30",
  "conversationStatus": "available"
}
```

## 9. trace.compare

用途：比较两个 Trace Node。

Input：

```json
{
  "fromNode": "node_20",
  "toNode": "node_31"
}
```

Output：

```json
{
  "filesChanged": 8,
  "additions": 214,
  "deletions": 67,
  "summary": "...",
  "files": []
}
```

## 10. trace.get_conversation

Input：

```json
{
  "nodeId": "node_31",
  "mode": "summary"
}
```

mode：

```text
summary
messages
decisions
```

Output：

```json
{
  "provider": "workbuddy",
  "conversationId": "conv_21",
  "summary": "...",
  "decisions": []
}
```

Host 请求完整 messages 时，应受到用户隐私配置限制。

## 11. trace.create_checkpoint

用途：保存当前工作区为可恢复节点。

属于：

```text
mutating
```

Input：

```json
{
  "repositoryId": "repo_123",
  "reason": "before_resume",
  "includeUntracked": true
}
```

执行前：

```text
Repository Lock
Repository State Validation
Secret Scan
```

Output：

```json
{
  "operationId": "op_91",
  "nodeId": "node_42",
  "commit": "91ac8f",
  "recoverable": true
}
```

错误：

```text
REPO_LOCKED
UNSAFE_GIT_STATE
DIRTY_WORKTREE
SECRET_DETECTED
CHECKPOINT_FAILED
BRANCH_CREATE_FAILED
VERIFY_FAILED
```

## 12. trace.resume_from

这是 TraceAndBack 最关键 Tool。

语义：

```text
安全地从历史 Trace Node 创建新分支，并将目标历史版本 checkout 到当前项目工作区
```

不是：

```text
破坏性 reset 当前 workspace
```

Input：

```json
{
  "nodeId": "node_18",
  "strategy": "branch",
  "checkpointCurrent": false
}
```

strategy：

```text
branch    # 默认：当前工作区必须 clean，在当前目录创建并 checkout 新分支
worktree  # 显式选择：创建独立 worktree；脏工作区可按 checkpointCurrent 保存
```

branch 策略在发现 dirty workspace 时必须立即返回 DIRTY_WORKTREE，不得自动 checkpoint、切换分支或覆盖当前修改。用户保存当前工作后可重新执行。

执行流程：

```text
Acquire Lock
↓
Inspect current repository
↓
If branch and dirty: return DIRTY_WORKTREE without mutation
↓
Validate target
↓
Create branch and checkout current worktree
  or create separate worktree when strategy=worktree
↓
Verify target HEAD
↓
Create new Trace Session
↓
Return environment
```

Output（branch 策略）：

```json
{
  "operationId": "op_103",
  "sourceNode": "node_18",
  "checkpointNode": null,
  "newBranch": "trace/node-18-20260911",
  "worktreePath": "/project",
  "sessionId": "session_77",
  "strategy": "branch",
  "hostHandoff": {
    "status": "user_action_required",
    "branchCheckout": "current_worktree",
    "requiresHostAction": false,
    "instructions": [
      "The new branch is already checked out in the current project worktree.",
      "Create a new development conversation in the current project worktree.",
      "Do not run git switch again or create another worktree."
    ]
  }
}
```

hostHandoff 是兼容性的结果元数据，不代表 TraceAndBack 会创建 Agent Host 对话。默认 branch 策略完成 Git checkout 后，用户可以手动在当前项目工作区创建新对话；MCP App 不会伪称已经打开新对话。只有显式使用 strategy=worktree 时，返回的独立 worktree 才需要宿主接管或由用户直接打开。

## 13. trace.attach_conversation

Host 可主动将当前 AI Conversation 绑定到 Trace Session。

Input：

```json
{
  "sessionId": "session_77",
  "provider": "workbuddy",
  "conversationId": "conv_982",
  "messages": []
}
```

MVP 推荐允许：

```text
conversationId only
```

或：

```text
selected message events
```

避免强制传完整会话。

Output：

```json
{
  "attached": true
}
```

## 14. trace.search

用途：搜索历史开发节点。

Input：

```json
{
  "repositoryId": "repo_123",
  "query": "token refresh",
  "limit": 20
}
```

搜索范围：

```text
summary
decision
conversation summary
file path
commit message
```

## 15. MCP Resources

除 Tools 外，可以提供稳定可读 Resources。

建议 URI：

```text
trace://repository/{repoId}
trace://repository/{repoId}/history
trace://node/{nodeId}
trace://node/{nodeId}/diff
trace://node/{nodeId}/conversation
```

Resources 应主要用于：

```text
Context retrieval
```

不要通过 Resource 执行 Git mutation。

## 16. MCP Prompts

可选提供：

```text
trace.explain_node
trace.compare_versions
trace.review_history
```

Prompt 不是产品核心依赖。

## 17. Tool Side Effect 标识

内部 Tool Registry 需要维护：

```ts
type ToolPolicy = {
  readonly: boolean;
  requiresRepoLock: boolean;
  requiresUserApproval: boolean;
  mayCreateCommit: boolean;
  mayCreateBranch: boolean;
  mayCreateWorktree: boolean;
};
```

例如：

```text
trace.get_history
readonly=true

trace.resume_from
readonly=false
requiresRepoLock=true
mayCreateCommit=true
mayCreateBranch=true
mayCreateWorktree=true
```

## 18. Error Contract

统一错误模型：

```json
{
  "code": "UNSAFE_GIT_STATE",
  "message": "Repository is currently rebasing.",
  "recoverable": true,
  "details": {
    "state": "rebase"
  }
}
```

建议错误码：

```text
REPOSITORY_NOT_FOUND
NOT_A_GIT_REPOSITORY
NODE_NOT_FOUND
COMMIT_NOT_FOUND
REPO_LOCKED
UNSAFE_GIT_STATE
DIRTY_WORKTREE
SECRET_DETECTED
CHECKPOINT_FAILED
WORKTREE_CREATE_FAILED
VERIFY_FAILED
DATABASE_ERROR
CONVERSATION_PROVIDER_ERROR
PERMISSION_DENIED
OPERATION_INTERRUPTED
```

## 19. Idempotency

Read Tools：天然幂等。

Mutating Tool 必须支持：

```text
operationId
```

或内部 request fingerprint。

避免 Host 重试造成：

```text
重复 commit
重复 worktree
重复 branch
```

例如相同 operation token：

```text
第二次调用返回第一次结果
```

而不是再执行一次。

## 20. Concurrency

每个 Repository 同时只允许一个 mutation。

Lock Key：

```text
repositoryId
```

允许并行：

```text
Repo A mutation
Repo B mutation
```

禁止并行：

```text
Repo A checkpoint
+
Repo A resume
```

## 21. Transaction Model

Git 与 SQLite 不支持天然分布式事务。

因此采用：

```text
Operation Journal
```

状态：

```text
PENDING
PREPARED
GIT_APPLIED
DB_APPLIED
VERIFIED
COMPLETED
FAILED
RECOVERY_REQUIRED
```

每次启动 Server 扫描：

```text
unfinished operations
```

并恢复或标记人工处理。

## 22. Security Boundary

MCP 客户端不得直接指定任意 shell 命令。

禁止设计：

```text
trace.git_command(command: string)
```

所有 Git 能力必须是高层语义 Tool，例如：

```text
create_checkpoint
resume_from
compare
```

避免演变成远程 Shell。

## 23. Filesystem Boundary

Server 应限制可操作 repository。

禁止任意客户端传：

```text
/
../../
~/.ssh
```

建议使用：

```text
Repository Registry
```

只有已注册 repositoryId 才能执行 mutation。

## 24. Conversation Privacy

conversation 数据默认：

```text
local only
```

支持三个 retention level：

```text
none
summary
full
```

推荐默认：

```text
summary
```

## 25. Transport

本地 Host：优先使用 SDK 支持的本地连接形式。

远端部署时：使用符合当前 MCP SDK 的 HTTP transport。

应用不得建立对旧：

```text
HTTP + SSE legacy transport
```

的长期核心依赖。

## 26. TypeScript 模块设计

建议：

```text
packages/
├── mcp-server/
├── domain/
├── git-engine/
├── trace-store/
├── conversation/
└── shared/
```

MCP：

```text
mcp-server
```

只依赖 Domain Service。

禁止：

```text
MCP handler
→ raw shell git
```

正确：

```text
MCP handler
→ TraceService
→ GitOperationManager
→ GitAdapter
```

## 27. MCP Tool 最小 MVP 集合

第一阶段只发布：

```text
trace.get_status
trace.get_history
trace.get_node
trace.compare
trace.create_checkpoint
trace.resume_from
trace.attach_conversation
```

不要第一版提供几十个小 Tool。

Tool 越少：

- Agent 越容易选择正确能力。
- 安全边界越明确。
- Schema 越稳定。
- 测试成本越低。

## 28. Compatibility Policy

TraceAndBack Tool Contract 遵循：

```text
Additive first
```

允许：

```text
新增 optional property
新增 Tool
```

谨慎：

```text
删除 property
改变 property 类型
修改 Tool 核心语义
```

Breaking change 必须进入 major release。

## 29. Contract Test

每个 Tool 自动验证：

```text
valid request
invalid request
missing field
unknown node
repository locked
database failure
Git unsafe state
retry/idempotency
```

Mutation Tool 额外验证：

```text
operation recovery
```

## 30. v1 MCP 验收条件

必须满足：

```text
所有 Tool schema 可验证
所有 read tools 无 Git side effect
所有 mutation 经过 repository lock
resume_from 不覆盖当前未保存代码
重复 mutation request 不产生重复状态
server 重启可以发现未完成 operation
conversation provider 失败不影响核心 Git 状态
```

满足上述条件后，TraceAndBack MCP API 才进入：

```text
v1 stable contract
```
