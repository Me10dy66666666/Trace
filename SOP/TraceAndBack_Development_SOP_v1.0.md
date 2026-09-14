# TraceAndBack Development SOP

版本：v1.0  
适用范围：TraceAndBack 全部代码仓库

## 1. 目标

定义统一研发流程，确保：

- 功能设计可追溯。
- Git 行为经过安全评审。
- MCP 接口保持兼容。
- 数据库升级可恢复。
- 每次 Release 都经过安全测试。
- 任何自动 Git 操作都不存在不可逆代码损失风险。

## 2. 研发基本流程

所有需求按照：

```text
Requirement
↓
Issue
↓
Design
↓
Implementation
↓
Unit Test
↓
Integration Test
↓
PR
↓
Review
↓
Merge
↓
Release
```

执行。

禁止：

```text
直接在 main 开发
```

## 3. Issue 分类

统一使用：

```text
feature
bug
security
refactor
performance
protocol
database
ui
docs
test
release
```

Priority：

```text
P0
P1
P2
P3
```

### P0

- 数据丢失风险。
- Git repository 损坏。
- Secret 泄漏。
- 无法恢复 checkpoint。
- 数据库重大损坏。

必须优先处理。

## 4. Branch 规范

推荐：

```text
main
develop
feature/*
fix/*
refactor/*
security/*
release/*
```

例如：

```text
feature/trace-history
feature/checkpoint
fix/worktree-lock
security/env-filter
```

## 5. Commit 规范

采用 Conventional Commits 风格：

```text
feat:
fix:
refactor:
test:
docs:
perf:
build:
chore:
security:
```

例如：

```text
feat(trace): add chronological parent relation
fix(git): prevent resume during rebase
security(scan): block checkpoint containing credentials
```

## 6. Feature 开发 SOP

### Step 1：建立 Issue

Issue 至少包含：

```text
Problem
Goal
Scope
Out of Scope
Acceptance Criteria
Risk
```

### Step 2：判断是否需要 ADR

以下情况必须写 ADR：

- 新 Git destructive operation。
- DB schema 大调整。
- 新 MCP public contract。
- 安全模型变化。
- 数据存储位置变化。
- Conversation 模型变化。
- 跨组件架构变化。

### Step 3：定义接口

优先定义：

```text
Types
Interfaces
Schemas
Errors
```

之后才实现业务代码。

### Step 4：实现

遵循：

```text
domain
→ service
→ infrastructure
→ transport
→ UI
```

MCP handler 不得包含大量业务逻辑。

### Step 5：测试

至少需要：

```text
unit
integration
contract
```

涉及 Git 状态变化时必须增加 repository scenario test。

### Step 6：PR

PR 必须包括：

```text
Summary
Behavior Change
Test Evidence
Risk
Rollback Plan
```

## 7. Git Operation SOP

所有修改 repository 状态的操作必须通过统一：

```text
GitOperationManager
```

禁止业务模块直接调用：

```text
exec("git ...")
```

写操作流程：

```text
Acquire Repository Lock
↓
Inspect Repository State
↓
Validate Allowed State
↓
Create Recovery Point if needed
↓
Execute Operation
↓
Verify Repository State
↓
Persist Trace Transaction
↓
Release Lock
```

## 8. Repository State 检查

执行以下操作前：

```text
checkpoint
resume
worktree
branch
commit
```

必须检测：

```text
dirty
untracked
ignored
detached HEAD
merge
rebase
cherry-pick
bisect
submodule
worktree state
```

遇到未知状态：

```text
FAIL CLOSED
```

即拒绝修改，而不是猜测。

## 9. Checkpoint SOP

触发条件：

```text
用户从历史节点继续
AND
当前 workspace 非 clean
```

流程：

```text
Lock repo
↓
Inspect
↓
Secret Scan
↓
Snapshot metadata
↓
Create checkpoint commit
↓
Create Trace Node
↓
Verify commit exists
↓
Verify recoverability
↓
Commit transaction
```

之后才能切换历史环境。

## 10. Resume SOP

默认不修改原 branch ref；在当前 worktree 创建并 checkout 新的 trace/... 分支。当前 workspace dirty 时必须先由用户保存。

执行：

```text
resume_from(node)
```

流程：

```text
Validate node
↓
Reject dirty current workspace
↓
Resolve target commit
↓
Create trace branch and checkout current worktree
↓
Verify HEAD
↓
Create Trace Session
↓
Return environment information
```

默认：

```text
new branch + current worktree
```

显式隔离策略：

```text
git worktree
```

当前 worktree dirty 时不得自动 checkpoint；必须向用户返回明确的保存提示。strategy=worktree 才允许按 checkpointCurrent 保存 dirty workspace。

禁止自动：

```text
reset --hard
force checkout with discarded changes
force push
```

## 11. MCP Tool 开发 SOP

增加 MCP Tool 时：

### Step 1

新增 Tool Contract。

定义：

```text
name
description
inputSchema
outputSchema
errors
sideEffects
```

### Step 2

判断：

```text
Read-only
或
Mutating
```

### Step 3

Mutating tool 必须声明：

```text
requiresRepoLock
requiresApproval
rollbackStrategy
```

### Step 4

实现 Service。

### Step 5

实现 MCP Adapter。

### Step 6

执行 Contract Test。

### Step 7

更新：

```text
MCP_SPEC.md
CHANGELOG.md
```

## 12. MCP Breaking Change SOP

禁止直接修改已有 Tool 参数含义。

优先：

```text
additive change
```

若必须 Breaking：

```text
new tool/version
```

例如：

```text
trace.resume_from
```

变成：

```text
trace.resume_from_v2
```

或在明确版本机制成熟后统一切换。

## 13. Database Migration SOP

所有 schema 修改必须 migration。

禁止：

```text
启动时偷偷修改 schema
```

migration：

```text
001_initial.sql
002_add_decisions.sql
003_add_operation_log.sql
```

每个 migration 必须验证：

```text
upgrade
rollback strategy
old data preserved
large database
crash during migration
```

生产用户数据原则：

```text
Never destructive by default
```

## 14. Security SOP

任何准备提交的数据必须检查：

- `.env`
- credential
- private keys
- access token
- cloud key
- SSH material

发现高风险 secret：

默认：

```text
block automatic checkpoint
```

向用户返回明确原因。

不得将源码/会话上传到远端，除非：

```text
用户明确启用云功能
```

## 15. AI Conversation SOP

Conversation adapter 不得成为 Git 操作强依赖。

如果 AI Conversation 获取失败：

```text
Git Trace 正常创建
conversation_status = missing
```

后续允许补录。

禁止：

```text
因为 AI provider API 失败
→ Git commit/checkpoint 失败
```

## 16. Logging SOP

每一次 Repository mutation 必须产生 Operation Record：

```text
operation_id
repo_id
operation_type
started_at
finished_at
before_head
after_head
status
error
```

不得记录：

- Secret。
- 完整 `.env`。
- Access Token。

## 17. Pull Request Checklist

```text
[ ] Acceptance Criteria 满足
[ ] Unit Tests
[ ] Integration Tests
[ ] MCP Contract Tests
[ ] Git Safety Tests
[ ] DB Migration Tests（如适用）
[ ] Security Review（如适用）
[ ] Documentation Updated
[ ] No Secret
[ ] Rollback Plan
```

## 18. Code Review 重点

涉及 Git：

```text
是否可能丢代码？
```

涉及 DB：

```text
旧用户数据是否安全？
```

涉及 MCP：

```text
是否 breaking？
```

涉及 AI：

```text
provider 失败是否影响核心 Git？
```

## 19. Release SOP

发布前：

```text
Version Freeze
↓
Full Test
↓
Fresh Install
↓
Upgrade Test
↓
Checkpoint Recovery Test
↓
Crash Recovery Test
↓
Package
↓
Release Candidate
↓
Release
```

Release Checklist：

```text
[ ] test suite passed
[ ] migrations tested
[ ] worktree tests passed
[ ] dirty workspace test passed
[ ] detached HEAD test passed
[ ] rebase/merge protection passed
[ ] recovery test passed
[ ] changelog updated
[ ] version updated
[ ] MCP schemas validated
[ ] docs updated
```

## 20. Bug SOP

一般 Bug：

```text
Reproduce
↓
Regression Test
↓
Fix
↓
Verify
```

P0 Bug：

```text
Stop risky release
↓
Create reproducible repository
↓
Protect user data
↓
Fix
↓
Regression Test
↓
Patch Release
```

## 21. Definition of Done

一个 Feature 只有同时满足以下条件才算完成：

```text
Implementation
+
Automated Tests
+
Acceptance Criteria
+
Documentation
+
Recovery Consideration
+
Backward Compatibility Consideration
```

单纯“代码可以运行”不算完成。

## 22. 核心工程原则

第一原则：

```text
Do not lose user code.
```

第二原则：

```text
Every mutation must be recoverable.
```

第三原则：

```text
Git history and Trace history are related,
but they are not the same thing.
```

第四原则：

```text
AI context failure must not corrupt Git state.
```
