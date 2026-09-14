# TraceAndBack 产品需求文档 PRD

版本：v1.0  
阶段：MVP  
产品形态：本地优先的 MCP Server + Workbuddy/IDE/Agent Host 可视化客户端  
核心定位：AI-native Development Timeline

## 1. 产品概述

TraceAndBack 是一个面向 AI 辅助软件开发场景的项目历史记录与安全恢复系统。

传统 Git 能准确记录“代码发生了什么变化”，但无法完整回答：

- 为什么进行这次修改？
- 修改之前开发者和 AI 讨论了什么？
- 哪些技术决策导致当前代码状态？
- 一个失败方案是从哪个历史状态开始产生的？
- 能否从某个历史节点重新开始，而不破坏当前代码？
- 当开发过程发生分叉时，真实工作顺序是什么？

TraceAndBack 将 Git 历史、AI 会话、代码 Diff、开发决策和真实工作时间线组合成一个可交互的开发历史图。

每一个关键开发状态表现为一张 Trace Card。

卡片之间存在两种不同关系：

1. Git ancestry：代码实际继承关系。
2. Chronology：开发者真实工作时间顺序。

二者必须独立记录。

## 2. 产品愿景

让软件开发历史从：

“代码从 A 变成了 B”

升级为：

“我们为什么从 A 走到 B、过程中讨论了什么、改了什么，以及能否安全地重新从 A 出发。”

长期目标是成为 AI 编程环境中的“项目记忆层”。

## 3. 目标用户

### 3.1 第一目标用户

使用 AI 编程工具进行中高频开发的个人开发者。

典型工具包括：

- ChatGPT / Workbuddy
- Cursor
- Claude Code
- VS Code Agent
- JetBrains AI
- CLI Agent

用户特点：

- 每天大量通过自然语言修改代码。
- 经常尝试不同方案。
- Git commit 粒度不稳定。
- 经常忘记某次修改为什么发生。
- 希望安全探索历史实现。

### 3.2 第二目标用户

小型工程团队。

价值包括：

- 了解代码背后的 AI 决策历史。
- Code Review 时理解修改原因。
- 新成员快速了解项目演进。
- 分析失败方案。
- 保存技术决策上下文。

## 4. 用户核心问题

### P1：Git 缺少修改原因

Git Diff 可以显示：

```text
auth.ts
+ refreshToken()
```

但不能可靠说明：

```text
为什么加 refreshToken？
AI 提出了哪些方案？
为什么最终选择这个方案？
```

### P2：AI 会话与代码脱节

开发者可能与 AI 连续沟通几十轮。

最后只有代码进入 Git，而关键推理过程留在聊天工具中。

### P3：历史版本恢复成本高

用户往往知道：

“昨天某个版本其实更好。”

但不知道：

- commit 是哪个；
- 当时讨论了什么；
- 从该版本继续会不会覆盖当前工作；
- 当前未提交内容是否会丢失。

### P4：Git 图无法表示真实探索路径

例如：

```text
Git：

A → B → C
    \
     D
```

实际开发顺序可能是：

```text
A → B → C → 回到 B → D
```

因此需要额外记录 chronology。

## 5. 产品核心对象

### 5.1 Trace Node

一个可恢复的项目历史节点。

至少关联：

- node_id
- repository_id
- commit_sha
- timestamp
- git_parent
- chronological_parent
- session_id
- summary
- decisions
- changed_files
- conversation_refs
- checkpoint_type

### 5.2 Trace Session

一次连续 AI 辅助开发过程。

表示：

```text
Base Commit
    ↓
AI Conversation
    ↓
Workspace Changes
    ↓
Result Commit
```

### 5.3 Trace Card

Trace Node 在 UI 中的视觉表达。

## 6. 核心用户流程

### Flow 1：正常提交

用户开发：

```text
Commit A
↓
与 AI 沟通
↓
修改代码
↓
Commit B
```

TraceAndBack 自动生成：

```text
Trace Card B
```

包含：

- Base：A
- Result：B
- 与 AI 的关键讨论
- 主要代码变化
- 修改文件
- 重要决策
- 风险/遗留问题

### Flow 2：查看开发历史

用户打开 Trace 页面。

看到：

```text
A ─── B ─── C
      │
      └──── D ─── E
```

卡片按照 chronology 排列。

Git lineage 通过连接关系表示。

用户点击节点可以查看：

- AI Summary
- Conversation
- Code Diff
- Decisions
- Changed Files
- Parent Node
- Derived Nodes

### Flow 3：从历史版本继续

当前：

```text
A → B → C
```

用户点击 B：

```text
从这里继续
```

系统必须首先检查 Working Tree。

如果当前工作区 clean，系统基于 B 创建：

```text
trace/<timestamp>
```

并直接在当前项目工作区 checkout 该新分支；不创建额外 worktree，也不执行 reset。

如果存在修改，系统必须停止并提示用户先提交或保存当前工作。用户完成保存后重新执行“从这里继续”。默认流程不自动 checkpoint，不覆盖用户未保存内容。

用户随后可以自己在当前项目工作区创建新的开发对话；TraceAndBack 不声称已经替用户打开新对话。

最终：

```text
Git：

A → B → C
    \
     E
```

且 C 永远保留。

### Flow 4：当前代码未提交时回到历史节点

系统必须：

1. 检测 dirty workspace。
2. 如果 dirty，提示用户提交或保存并立即停止，不执行 Git 切换。
3. 验证目标历史版本。
4. 创建 trace/<timestamp> 分支并在当前 worktree checkout 目标版本。
5. 验证目标 HEAD。
6. 创建新的 Trace Session。

任何步骤失败时，不得执行破坏性切换。

当用户显式选择独立 worktree 策略时，系统可以按 checkpointCurrent 创建 checkpoint，再创建并验证独立 worktree；该策略不是默认路径。

## 7. MVP 功能范围

### P0 必须完成

- 本地 Git Repo 检测。
- Commit 监听。
- Commit Diff 获取。
- Trace Node 创建。
- SQLite 本地数据库。
- Git ancestry 关系。
- Chronology 关系。
- AI conversation adapter 接口。
- Conversation summary。
- Changed files summary。
- Trace history 查询。
- 单节点详情。
- 当前 workspace 状态检查。
- 自动 checkpoint。
- 从历史节点安全继续。
- Git worktree 支持。
- 基础 Trace Graph UI。
- MCP Tools。
- 崩溃恢复日志。
- Repository 操作锁。

### P1

- 节点搜索。
- 两节点比较。
- Decision 提取。
- Tag。
- Bookmark。
- Timeline Filter。
- 多 AI provider adapter。

### P2

- Cloud Sync。
- Team Timeline。
- Shared Decision History。
- PR Integration。
- Remote Timeline Web UI。

## 8. MVP 非目标

第一版不做：

- GitHub 替代品。
- Git GUI 全功能客户端。
- 自动 merge。
- 自动解决冲突。
- 自动 force push。
- 强制覆盖用户分支。
- 项目源码云同步。
- 团队权限体系。
- IDE 全功能代码编辑。

## 9. Trace Card 信息结构

每张卡片默认展示：

```text
Commit SHA
时间
标题

本次目标

AI Discussion Summary

Key Decisions

Changed Files

Diff Stats

Warnings

[查看详情]
[比较当前]
[从这里继续]
```

## 10. 双关系模型

每个 Trace Node 同时具有：

```text
git_parent
```

以及：

```text
chronological_parent
```

示例：

实际工作：

```text
A → B → C → 回到 B → D
```

Chronology：

```text
A → B → C → D
```

Git：

```text
A → B → C
    \
     D
```

UI 不得混淆两种关系。

## 11. AI Conversation Binding

MVP 不直接假设所有 AI Host 都能提供统一历史 API。

定义 Adapter：

```text
ConversationProvider
```

标准能力：

```text
getCurrentConversation()
getMessagesSince(timestamp)
getConversationById(id)
```

若 Host 无法提供完整历史：

允许 Host 主动通过 MCP 向 TraceAndBack 提交 conversation event。

## 12. 安全原则

优先级：

```text
用户代码安全
>
历史数据完整性
>
自动化便利
```

禁止默认执行：

```text
git reset --hard
git clean -fd
git push --force
```

从历史节点继续默认使用：

```text
new branch + current worktree
```

需要并行隔离时显式使用：

```text
git worktree
```

## 13. 产品成功指标

### Reliability

- Trace 节点创建成功率 ≥ 99.5%
- 自动 checkpoint 可恢复率 = 100%
- 因 TraceAndBack 导致源码永久丢失次数 = 0

### Performance

普通仓库：

```text
get_history < 300ms
get_node < 200ms
workspace status < 500ms
```

不要求大型仓库完全满足上述目标。

### Product

关注：

- Timeline 打开次数。
- 从历史节点继续次数。
- Compare 使用率。
- Trace Card 展开率。
- 用户主动保存 checkpoint 次数。

## 14. MVP 验收条件

产品只有满足以下条件才允许进入 Beta：

- dirty workspace 恢复测试全部通过。
- worktree 创建失败不会损坏原 workspace。
- Trace DB 崩溃可恢复。
- Git 操作具备 repository lock。
- orphan node 可检测。
- checkpoint commit 可以恢复。
- detached HEAD 有正确处理。
- merge/rebase 状态不会误执行恢复操作。
- conversation 缺失不会阻断 Git Trace。
- MCP Tool schema contract tests 全部通过。

## 15. 第一阶段产品形态

推荐：

```text
TraceAndBack MCP Server
+
Local SQLite
+
Git Engine
+
Conversation Adapter
+
Workbuddy Timeline Client
```

架构必须保证未来无需重写核心，即可增加：

```text
VS Code
Cursor
Claude Code
CLI
Web Dashboard
JetBrains
```

## 16. 核心产品原则

TraceAndBack 不应成为“更漂亮的 Git Log”。

真正产品边界是：

```text
Git = What changed

TraceAndBack =
What changed
+ Why
+ What did AI and developer discuss
+ What decisions were made
+ Where can development safely restart
```
