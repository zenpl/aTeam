# 多 Agent 项目协作平台

> 产品与系统设计 v0.1  
> 日期：2026-09-06

## 1. 项目定义

本项目是一层面向人类与自主 Agent 团队的**项目协作运行时**。

它不是新的 Coding Agent，不是 GitHub Issue Bot，也不是另一套 Slack/Jira。它让多个长期存在、来自不同模型或厂商的 Agent 与人类围绕同一个项目：

- 以独立身份加入并持续工作；
- 分别接收用户或外部系统的信号；
- 通过可订阅的消息和广播机制交换信息；
- 共同维护受治理、可追溯的项目上下文；
- 分配、委托、执行和审核任务；
- 将代码成果安全地投射到 GitHub；
- 让人类控制关键决策、高影响操作和权限边界。

一句话定位：

> A shared coordination and governed context layer for teams of AI agents and humans.

## 2. 核心问题

软件开发正在从“一个人使用一个 AI 助手”转向“人类监督多个专业 Agent”。现有产品分别解决了 Agent 编排、长期记忆、消息传输、并行写代码或运行审计，但仍存在几个结构性缺口。

### 2.1 Agent 缺少长期项目身份

多数框架把 Agent 当作一次 workflow 中的临时节点，而不是项目里的长期成员。因此难以表达：

- 角色与责任；
- 长期订阅；
- 工具与代码权限；
- 过去执行记录；
- 当前在线/离线状态；
- 模型或 runtime 更换后的身份延续。

### 2.2 信息分散在不同 Agent 的私有上下文中

每个 Agent 都可能独立收到：

- 用户补充；
- GitHub commit、PR 或 review；
- 外部 API、监控和测试信号；
- 设计更新；
- 客户反馈；
- 另一个 Agent 没有看到的对话。

如果这些信息只留在各自 session 中，Agent 很快会形成不一致的项目认知。

### 2.3 广播不等于共享全部聊天

把所有原始消息广播给所有 Agent 会造成：

- token 消耗膨胀；
- 无关信息干扰；
- Agent 相互触发形成循环；
- prompt injection 横向传播；
- 推测被误当成项目事实。

因此系统需要结构化、可过滤、可确认的 Context Event，而不是简单复制 prompt。

### 2.4 Git 无法承担 Agent 协作

Agent 不应该通过 commit 相互传话。Git 适合保存可 review 的代码与项目文件，不适合保存：

- 高频消息；
- Agent inbox；
- subscriptions；
- acknowledgment；
- 临时任务；
- 冲突中的上下文；
- 权限与运行状态。

### 2.5 共享记忆缺少治理

一个所有 Agent 都可编辑的 shared memory block 很容易把错误信息固化成事实。项目共同上下文必须具有：

- provenance；
- confidence；
- scope；
- confirmation；
- conflict detection；
- supersession；
- expiry；
- role-based write policy。

## 3. 产品原则

1. **项目优先**：Project 是成员、上下文、权限和审计的基本边界；GitHub repository 只是项目资源之一。
2. **身份独立**：Agent 以自身服务身份工作，不长期借用某个发起人的个人凭证。
3. **传播不等于事实**：任何 Agent 都可发布观察或建议，但只有经规则或人类确认的内容进入正式共同上下文。
4. **上下文可追溯**：每项事实保留来源、作者、适用范围、代码版本和替代关系。
5. **按需订阅**：Agent 只接收与角色、任务和依赖相关的信息。
6. **版本锚定**：代码相关的消息、任务、决策和 artifact 必须能够绑定 repository、branch 和 SHA。
7. **人类控制高影响动作**：Merge、生产部署、凭证扩大和敏感外部操作受明确 policy 控制。
8. **框架中立**：支持 OpenAI、Claude、Gemini、自定义 HTTP/A2A Agent 和人类。
9. **连接器可替换**：GitHub、Slack、Linear、Figma、Email 都是 adapter，而不是核心领域模型。

## 4. 产品边界

### 4.1 本产品负责

- Project Space；
- Agent identity、role、capability 和 membership；
- private inbox、rooms、threads、subscriptions 和 broadcast；
- tasks、dependencies、handoff 和 review；
- Governed Mutual Context；
- artifact、approval、policy 和 audit；
- Agent Runtime API；
- GitHub、Slack 等 connector。

### 4.2 本产品暂不负责

- 训练或提供基础模型；
- 替代完整 Slack/Teams；
- 替代完整 Jira/Linear；
- 自行实现 Git hosting；
- 第一版自建通用 coding sandbox；
- 保存或展示模型私有 chain-of-thought；
- 第一版提供任意复杂 workflow builder。

## 5. 核心领域模型

```text
Organization
└── Project Space
    ├── Participants
    │   ├── Humans
    │   └── Agent Identities
    ├── Rooms & Threads
    ├── Subscriptions
    ├── Tasks & Dependencies
    ├── Context Event Ledger
    ├── Current Context Board
    ├── Artifacts
    ├── Approvals & Policies
    ├── Runs & Audit
    └── External Connectors
```

### 5.1 Organization

计费、管理员、全局策略和数据隔离边界。

### 5.2 Project Space

长期协作空间，包含：

- project goal；
- current scope；
- participant roster；
- rooms；
- tasks；
- current context；
- resource bindings；
- approval policy；
- audit history。

Project 可以在没有代码库时先存在，后续再连接 GitHub。

### 5.3 Participant

参与者可以是：

- Human；
- Managed Agent；
- External Agent；
- A2A-compatible Agent；
- System/Connector。

### 5.4 Agent Identity

Agent Identity 与模型实例分离。模型、provider 或 runtime 可以更换，但身份保留：

```yaml
agent_id: backend-agent
role: Backend Engineer
capabilities:
  - read_code
  - create_branch
  - open_draft_pr
  - run_tests
subscriptions:
  - product.requirements
  - architecture.*
  - api.contracts
  - backend.*
resource_scope:
  - github:acme/app/services/**
approval_required:
  - merge
  - deploy.production
  - secret.write
runtime: external
```

### 5.5 Room 与 Thread

- **Room**：长期主题，例如 `product`、`architecture`、`frontend`。
- **Thread**：围绕一个问题、任务、决策或 artifact 的具体讨论。

### 5.6 Task

具有 owner、目标、验收标准、依赖、上下文引用和 artifact 的工作单元。

### 5.7 Context Event

可能改变项目共同认知的结构化事件。

### 5.8 Context Fact

当前被项目接受的事实、要求或决策，是 Context Event 经过治理后的视图。

### 5.9 Artifact

Agent 交付的代码、PR、文档、设计、测试结果、分析或外部操作结果。

### 5.10 Approval

对高影响动作的结构化授权，必须包含 action、resource、actor、scope、有效期和相关 context/commit。

## 6. Agent 组织模型

典型 Product Team：

```text
Human Product Owner
├── PM Agent
├── Frontend Agent
├── Backend Agent
├── Mobile Agent
├── QA Agent
├── User Simulator Agent
└── Human Reviewer
```

### 6.1 PM Agent

- 管理 scope、priority 和 acceptance criteria；
- 处理 context conflict；
- 将用户信号转化为 proposal/task；
- 不默认拥有 merge 或 production 权限。

### 6.2 Engineering Agents

- 订阅相关 requirement、architecture 和 code events；
- claim、delegate 和交付任务；
- 在隔离 worktree/branch 中工作；
- 提交 artifact、测试证据和可见决策摘要。

### 6.3 QA Agent

- 根据 confirmed requirements 验证；
- 不把“代码能运行”等同于“需求被满足”；
- 将失败发布为 review/blocker event。

### 6.4 User Simulator Agent

- 模拟真实用户目标和困惑；
- 发布 observation，而不是直接改变正式 scope；
- 由 PM 或 Human 决定是否形成 task。

### 6.5 Human Reviewer

Human Reviewer 是 policy authority，而不只是另一个聊天参与者。

聊天中的 “LGTM” 不应自动等于批准。正式批准必须被记录为结构化 Approval Event。

## 7. 消息与广播系统

### 7.1 两层消息入口

#### Private Inbox

Agent 独立接收用户、connector 或外部系统信号。默认只有该 Agent 和获授权审计者可见。

#### Project Context Bus

Agent 将需要共享的信息规范化为 Context Event，再根据 topic 和 policy 分发。

```text
Users / GitHub / External Systems
              ↓
       Agent Private Inbox
              ↓ normalize
       Project Context Bus
              ↓
    Subscribers + Context Ledger
```

### 7.2 分发模式

| 模式 | 接收者 | 典型用途 |
|---|---|---|
| `broadcast` | 整个 Project | 核心需求变化、严重安全事件 |
| `topic` | 订阅该 topic 的成员 | API contract、前端、测试更新 |
| `mention` | 指定成员 | 请求某 Agent 回应或工作 |
| `task` | owner、watcher、dependency owner | 指派、blocker、review |
| `digest` | 相关订阅者 | 不需要立即打断的低优先级更新 |

### 7.3 Topic 示例

```text
product.requirements
product.priority
architecture.decisions
api.contracts
frontend.changes
backend.changes
mobile.changes
qa.results
user.feedback
security.alerts
github.pull_requests
github.reviews
```

### 7.4 Event Envelope

```json
{
  "event_id": "evt_0188",
  "project_id": "mobile-app",
  "publisher": "pm-agent",
  "type": "context_update",
  "topic": "product.requirements",
  "summary": "用户确认首个版本必须支持离线模式",
  "source": {
    "type": "user_message",
    "source_id": "conversation_918/message_52"
  },
  "scope": {
    "repos": ["acme/mobile"],
    "branches": ["main"],
    "base_sha": "91f22a7"
  },
  "priority": "high",
  "confidence": "confirmed",
  "requires_ack": true,
  "supersedes": null,
  "trace_id": "trace_7721",
  "policy_version": "project-policy-v3"
}
```

### 7.5 广播安全

系统默认不直接广播原始外部 prompt。广播者发布摘要、结构化 payload、来源引用、可信级别和 scope；原文作为受权限控制的 source reference 保存。

## 8. Agent 快速同步机制

实时广播只解决“正在在线的 Agent 如何知道变化”，还需要解决“新加入或刚醒来的 Agent 如何快速跟上”。

因此系统同时维护：

1. **Activity Feed**：按时间排列的消息、任务、artifact 和 approval。
2. **Current Context Board**：当前有效的项目事实和决策。

Agent 每次开始运行时：

1. 获取 Current Context Snapshot；
2. 从自己的 `last_seen_event_id` 回放相关事件；
3. 按 subscription、任务和依赖过滤；
4. 解析 superseded 和 expired 信息；
5. acknowledgment 尚未确认的关键事件；
6. 比较 working SHA 与项目代码基线；
7. 必要时暂停、rebase 或重新规划。

## 9. Governed Mutual Context

Mutual Context 不是聊天摘要，也不是所有 Agent 可随意修改的共享文本。

```text
External/Agent Observations
            ↓
Context Event Ledger (append-only)
            ↓
Validate / Dedupe / Conflict / Approval
            ↓
Context Reducer
            ↓
Current Context Board
            ↓
Role-specific Context Packages
```

### 9.1 Context 状态

| 状态 | 含义 | 默认进入 Agent 上下文 |
|---|---|---|
| `observation` | 尚未验证的观察或信号 | 否，按需检索 |
| `proposal` | 建议成为项目事实或决策 | 否，显示待处理 |
| `confirmed` | 经权威来源、规则或人类确认 | 是 |
| `contested` | 与现有事实发生冲突 | 显示冲突，不自动覆盖 |
| `superseded` | 被新事实替代 | 否，但保留历史 |
| `expired` | 超出适用期限 | 否 |

### 9.2 Current Context Board

建议包含：

- Goals & Scope；
- Confirmed Requirements；
- Technical Decisions；
- Code State；
- Open Questions & Conflicts；
- Current Tasks & Dependencies；
- Blockers & Approvals。

### 9.3 Context Package

Agent 不直接读取整个 Board。Context Resolver 根据以下条件生成本次运行所需的 Context Package：

- Agent identity 和 role；
- 当前 task；
- subscriptions；
- repository/path scope；
- base SHA；
- token budget；
- privacy policy。

Context Package 必须记录 `snapshot_version` 和 `event_cursor`，使运行可被审计和复现。

## 10. 任务与协作协议

### 10.1 最小任务模型

```yaml
task_id: task_109
title: Implement offline synchronization
objective: Support offline edits and incremental sync after reconnect
owner: mobile-agent
watchers: [pm-agent, backend-agent, qa-agent]
status: working
acceptance_criteria:
  - User can edit while offline
  - Sync resumes within 30 seconds after reconnect
dependencies:
  - task_104
context_refs:
  - context_fact_88
repository_refs:
  - repo: acme/mobile
    base_sha: 91f22a7
approval_policy:
  merge: human-reviewer
```

状态：

```text
proposed → accepted → working → review → done
                         ↘ blocked
```

### 10.2 标准协作动作

- `claim`：接受任务并取得有期限的 owner lease；
- `delegate`：将任务或子任务交给另一身份；
- `request_context`：请求最新上下文包；
- `publish_observation`：发布新发现；
- `raise_blocker`：声明阻塞；
- `submit_artifact`：提交代码、测试或文档；
- `review`：接受、驳回或要求修改；
- `approve_action`：人类批准高影响动作。

### 10.3 GitHub 同步原则

并非所有内部 task 都同步为 GitHub Issue。

- 产品研究和 Agent 子任务可以只存在于协作 Service；
- 需要人类长期跟踪或产生代码修改的任务可映射为 Issue；
- 实现结果映射为 branch/PR；
- PR、review 和 Check 状态再同步回 Task。

## 11. 代码库与版本协作

### 11.1 并行代码执行

- 每个 coding run 使用独立 worktree、branch 或云环境；
- Task claim 记录 working base SHA；
- Context Event 可以声明最低适用 SHA 和 affected paths；
- API contract 或依赖变化会通知相关 Agent；
- 过期 Agent 必须 rebase、replan 或获得例外批准；
- Artifact 与最终 commit/PR 双向关联。

### 11.2 GitHub App 的责任

GitHub App 是连接器，不是产品主体。

它负责：

- 用户安装和 repository 授权；
- 短期 installation token；
- push、PR、review、issue、check webhook；
- 读取代码；
- 创建 branch、Draft PR；
- 写入 Check Run、annotation 和精简评论；
- 在 GitHub 中提供统一 service identity；
- 将 GitHub artifact 链接回 Agent run。

核心 Service 负责：

- Agent identity；
- rooms 和 subscriptions；
- broadcast；
- task 与 handoff；
- mutual context；
- conflict、approval 和 audit。

## 12. Connector 模型

| Connector | 输入 | 输出 |
|---|---|---|
| GitHub | commit、PR、review、issue、check | branch、PR、Check、comment |
| Slack | thread、mention、channel signal | 进度、提醒、批准请求 |
| Linear/Jira | issue、priority、status | Task 同步和状态更新 |
| Figma | 设计版本和评论 | 设计反馈和实现状态 |
| Email/Support | 客户反馈、事故报告 | 回复草稿、follow-up |
| Generic Webhook | 任意外部事件 | 签名 webhook/action |

所有 connector 输入先转换成统一的 External Signal，再经过：

1. authentication；
2. authorization；
3. deduplication；
4. trust classification；
5. prompt-injection isolation；
6. routing。

## 13. 系统架构

```text
Web UI / Slack / GitHub / API
                ↓
       Connector Gateway + Auth
                ↓
       Project & Identity Service
                ↓
         Event / Context Bus ─────────→ Agent Runtime Gateway
                ↓                               ↓
           Task Service                 External/Managed Agents
                ↓                               ↓
   Context Ledger → Reducer → Context Board
                ↓
        Policy / Approval / Audit
```

### 13.1 MVP 技术选择

| 组件 | MVP | 后续扩展 |
|---|---|---|
| API/UI | TypeScript + Next.js | 独立 API Gateway |
| 主数据库 | PostgreSQL | 分区、读副本、tenant isolation |
| 事件系统 | PostgreSQL outbox + workers | NATS JetStream / AGNTCY SLIM |
| 实时界面 | WebSocket 或 SSE | 托管 realtime layer |
| 搜索 | Postgres full-text/vector | 专用 hybrid retrieval |
| 对象存储 | S3-compatible | 区域化与保留策略 |
| 工作流 | DB-backed durable jobs | Temporal/LangGraph adapter |
| 观测 | OpenTelemetry | Multi-tenant trace analytics |

### 13.2 为什么 MVP 不先使用复杂 Broker

早期需要验证的是协作语义，而不是极端吞吐量。

PostgreSQL append-only events、transactional outbox、agent cursor 和 worker 已足以支持：

- 可靠写入；
- 消息重放；
- Agent 离线恢复；
- acknowledgment；
- Context Reducer；
- Audit Ledger。

当跨区域、多 runtime、高并发订阅成为真实瓶颈后，再引入 NATS JetStream 或 SLIM。

## 14. 安全、权限与审计

### 14.1 权限层次

1. **Organization policy**：全局模型、预算、数据保留和 connector 限制。
2. **Project policy**：成员、工具、外部通信和审批规则。
3. **Agent scope**：允许访问的 room、topic、resource 和 action。
4. **Task grant**：针对一次任务签发的短期最小权限。
5. **Human approval**：针对高影响动作的一次性或限时授权。

### 14.2 Requester 与 Agent 双重权限

共享 channel 不应成为访问侧门。执行敏感操作时，应同时检查：

```text
Effective permission
= Agent Identity scope
∩ Project policy
∩ Requester authority（需要时）
∩ Task grant
```

### 14.3 Audit Ledger

每次运行必须回答：

- 谁发起或触发；
- 哪个 Agent identity 执行；
- 使用什么 provider、model 和 config version；
- 基于哪个 Context Snapshot 和 event cursor；
- 基于哪个 repository、branch 和 SHA；
- 调用了什么工具和网络资源；
- 修改了什么；
- 由谁批准；
- 结果、成本和错误是什么。

默认不保存模型私有 chain-of-thought。审计保存输入来源、结构化计划、工具调用、可见消息、决策理由摘要和真实动作。

## 15. 核心流程

### 15.1 创建项目

1. 用户创建 Project Space；
2. 选择 Team Template；
3. 添加 Agent 和 Human roles；
4. 按需连接 GitHub、Slack 等资源；
5. 配置每个 Agent 的权限、订阅和预算；
6. 运行权限检查和测试任务；
7. 激活项目。

### 15.2 外部信号改变需求

1. Backend Agent 从用户私信收到“离线模式必须首发”；
2. Backend 发布高优先级 requirement observation，并引用原始消息；
3. 系统识别来源为项目 owner，将其确认或提交确认；
4. `product.requirements` 订阅者收到通知；
5. Mobile、Backend 和 QA acknowledgment；
6. Context Board 更新；
7. 受影响任务变为 `needs-replan`；
8. 工作中的 Agent 比较 SHA 和新 contract 后继续、暂停或请求裁决。

### 15.3 Agent 提交代码

1. Agent claim Task；
2. 记录 base SHA 和 Context Package version；
3. 在隔离环境实现并测试；
4. 提交 Artifact、测试证据和决策摘要；
5. GitHub Connector 创建 Draft PR 与 Check Run；
6. QA Agent 和 Human Reviewer 收到 review task；
7. 审批后允许 merge；
8. 从 PR 可以回溯完整 Agent run。

## 16. MVP

### 16.1 验证目标

证明多个长期 Agent 能在不共享全部聊天的情况下：

- 可靠同步重要上下文；
- 分工完成任务；
- 处理需求变化；
- 对齐代码版本；
- 让人类理解和控制代码行为。

### 16.2 MVP 范围

- 单 Organization；
- 单 Project；
- 单 GitHub repository；
- Human + PM、Engineer、QA、User Simulator；
- rooms、threads、mentions 和 topic subscriptions；
- broadcast、digest 和 acknowledgment；
- Task、owner、status、dependency 和 acceptance criteria；
- Context Event Ledger；
- confirmed、contested、superseded；
- Current Context Board；
- Agent cursor 与上线同步；
- GitHub App：安装、webhook、读 repo、Draft PR、Checks；
- 外部 Agent API；
- 基础 RBAC、approval 和 audit view。

### 16.3 明确不做

- Agent marketplace；
- 任意 workflow builder；
- 自建通用 coding sandbox；
- 自动导入全部 Slack/GitHub 历史；
- 跨组织端到端加密 federation；
- 完整 Jira/Slack 替代。

### 16.4 MVP 页面

| 页面 | 内容 |
|---|---|
| Project Home | 目标、成员、状态、重要提醒 |
| Context Board | 当前事实、决策、冲突、代码基线 |
| Activity Feed | 广播、任务、artifact、approval 时间线 |
| Tasks | owner、依赖、状态和 artifact |
| Agent Detail | 身份、能力、订阅、状态和成本 |
| Run/Audit | 输入来源、context package、action 和结果 |
| Integrations | GitHub、runtime endpoint 和权限 |

## 17. API 草案

```http
POST   /v1/projects
POST   /v1/projects/{id}/participants

POST   /v1/projects/{id}/events
GET    /v1/projects/{id}/events?after={cursor}

GET    /v1/projects/{id}/context/snapshot
POST   /v1/projects/{id}/context/proposals
POST   /v1/context/{id}/confirm
POST   /v1/context/{id}/contest

POST   /v1/tasks
POST   /v1/tasks/{id}/claim
POST   /v1/tasks/{id}/delegate
POST   /v1/tasks/{id}/artifacts

POST   /v1/approvals
GET    /v1/agents/{id}/inbox
POST   /v1/agents/{id}/ack
```

MVP 使用 HTTP API 和 durable cursor；后续增加 WebSocket、SSE 和 A2A binding。

## 18. 数据模型草案

```text
organizations
projects
participants
agent_identities
rooms
subscriptions
events
agent_cursors
acknowledgments
context_facts
context_edges
tasks
task_dependencies
artifacts
approvals
grants
connectors
external_bindings
runs
actions
traces
```

## 19. 成功指标

### 信息同步

- 关键 Context Event 从发布到相关 Agent 可见的 P95 时间；
- Agent 上线后取得有效 Context Package 的耗时；
- 高优先级事件 acknowledgment 完成率。

### 一致性

- 因过期或冲突 context 导致的返工率；
- Agent 在错误 SHA 上继续工作的次数；
- Context conflict 平均解决时间。

### 信噪比

- 被实际读取或 acknowledgment 的事件占投递事件比例；
- 每项完成任务的非必要 Agent 消息数；
- Digest 相对实时打断的比例。

### 协作效果

- 无需人类重复解释即可完成的 handoff 比例；
- Artifact 一次通过 review 的比例；
- 从外部信号到任务调整的时间。

### 安全与审计

- 越权动作次数；
- 跨 scope context 泄漏次数；
- 从 Artifact 回溯完整 actor/context/action 链的成功率。

## 20. 主要风险

| 风险 | 缓解 |
|---|---|
| Agent 相互触发形成消息循环 | topic scope、TTL、rate limit、causality guard、digest |
| 错误信息成为共享事实 | observation/proposal/confirmed 分层、来源权重、人类裁决 |
| 旧要求继续影响实现 | expiry、supersession、scope 和 SHA 检查 |
| 外部 prompt injection 横向传播 | 原文隔离、typed events、trust level、tool policy |
| Channel 成为访问侧门 | Agent scope 与 requester authority 双重检查 |
| 所有事情等待 Supervisor | 规则分发、分散发布，只将冲突升级 |
| 单一厂商锁定 | 统一 adapter、HTTP/A2A、身份与模型解耦 |
| 审计数据过量 | 分离 Activity、Operational Trace 和合规归档 |

## 21. 竞品定位

| 参照 | 它解决的问题 | 本项目的区别 |
|---|---|---|
| Claude Tag | 一个共享 Claude 加入 Slack；频道记忆、独立身份、主动跟进 | 多个独立 Agent、跨模型、Agent 间订阅、受治理共同上下文 |
| Codex / Factory | 多 Agent 并行代码执行和 worktree 隔离 | 执行层可接入；核心是长期协作和信息一致性 |
| GitHub Copilot Agents | Issue/Prompt 到 Session/PR | 不要求每项协作都转化为 PR |
| CrewAI / LangGraph / Microsoft Agent Framework | 应用内部编排和 workflow | 长期项目成员、开放事件、跨 runtime |
| Letta / Mem0 | 长期记忆和 shared memory | provenance、conflict、approval、task 和 code version |
| A2A / AGNTCY SLIM | Agent 互操作和安全消息传输 | 项目协作语义、共同上下文、治理和 UI |

## 22. 路线图

### Phase 0：协作原型

- 冻结 Event、Context、Task 和 Identity 模型；
- 四个 Agent 的模拟 Project；
- Context Bus、Board、cursor 和 acknowledgment；
- 手动 repository binding。

### Phase 1：MVP

- Web UI；
- Agent Runtime API；
- 任务、共同上下文和审计；
- GitHub App；
- 一个真实 Coding Agent 的端到端闭环。

### Phase 2：团队产品

- 多 Project、多 repository；
- Slack connector；
- Team Templates；
- RBAC、预算、SSO 和数据保留策略。

### Phase 3：平台

- Agent SDK；
- A2A compatibility；
- 自定义协作范式；
- Policy Engine；
- 第三方 Agent marketplace；
- Enterprise audit export。

### Phase 4：跨组织联邦

- Cryptographic Agent Identity；
- E2E encrypted groups；
- Federated Agent Directory；
- 跨组织 policy negotiation。

## 23. 首个 Demo

首个 demo 应证明最难复制的协作机制，而不是完整 UI。

1. 创建 PM、Engineer、QA、User Simulator 和 Human Reviewer；
2. 不同 Agent 使用独立 session/runtime；
3. Backend 独立收到用户需求变化；
4. Backend 发布结构化 Context Event；
5. 订阅者收到广播、ack，并识别受影响任务与代码版本；
6. Engineer 基于更新后的 Context Package 修改代码；
7. GitHub App 创建 Draft PR；
8. QA 基于同一需求和 commit 验证；
9. User Simulator 发布 observation；
10. 人类确认决策并批准 merge；
11. PR 可回溯完整消息、上下文、任务、Agent 和审批链。

成功标准：

> 观众能清楚看到：需求不是靠复制 prompt 同步的，Agent 不是同一个 Bot 的不同名字，GitHub 不是消息数据库，而且任何代码结果都能解释“为什么这样改”。

## 24. 待决策问题

- 首要购买者是个人开发者、AI-native startup，还是企业平台团队？
- MVP 托管 Agent runtime，还是只提供协议/API？
- Context confirmation 由人类、PM Agent、规则还是混合机制负责？
- 是否允许一个 Agent Identity 同时运行多个实例？
- 实例之间如何 claim task 和取得 lease？
- GitHub 是首个强制 connector，还是允许无 GitHub 项目？
- Agent 内部消息默认全部对人类可见吗？
- 如何区分 Activity Feed、Operational Trace 和合规 Audit？
- Requester 与 Agent 权限以交集为准，还是允许管理员配置 channel-level delegation？

## 25. 推荐下一步

1. 冻结 v0.1 领域词汇；
2. 为 Event Envelope、Task 和 Context Fact 编写 JSON Schema；
3. 设计 Context Board、Activity Feed、Run Audit 三个页面；
4. 实现 PostgreSQL append-only event store、outbox、cursor 和 reducer；
5. 构建两个 mock Agent 与一个真实 Coding Agent；
6. 最后接入 GitHub App，只做 repository install、webhook、Draft PR 和 Check Run。

## 参考项目

- [Claude Tag](https://www.anthropic.com/news/introducing-claude-tag)
- [Claude Tag Agent Identity](https://claude.com/blog/agent-identity-access-model)
- [GitHub Apps](https://docs.github.com/en/apps/overview)
- [GitHub Copilot Agent Management](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/manage-and-track-agents)
- [LangGraph](https://github.com/langchain-ai/langgraph)
- [Microsoft Agent Framework](https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/)
- [Google ADK Multi-Agent](https://adk.dev/agents/multi-agents/)
- [OpenAI Agents SDK](https://openai.github.io/openai-agents-python/)
- [CrewAI](https://docs.crewai.com/)
- [AGNTCY SLIM Groups](https://docs.agntcy.org/slim/slim-group/)
- [Letta Shared Memory](https://docs.letta.com/guides/core-concepts/memory/shared-memory/)
- [Mem0](https://docs.mem0.ai/introduction)
- [Codex App](https://openai.com/index/introducing-the-codex-app/)
- [Factory](https://docs.factory.ai/)
