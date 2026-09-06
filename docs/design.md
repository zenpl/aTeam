# aTeam · 设计（Phase 0）

> 一句话：多个独立 session 对"世界现在什么样、现在该做什么"保持一致。git 做不到这一点，这个工具做。

来源：`docs/sources/design-v0.1.md`（系统设想）与 `docs/sources/field-report.md`（一天的真实运行记录）。后者修正了前者的重心：难点不在消息，在共享事实；异步的代价集中在行动而非信息；结构比自觉可靠。

## 三个矛盾和裁决

1. **共享事实 vs 变化的世界。** 事实只以带时间、来源、依赖的 reading 存在。过期 reading 被引用时报错，不会安静地被当成真。
2. **异步并行 vs 必须立刻执行。** 只有 instruction 是同步的：唯一收件人、限长 280 字、long-poll 秒级送达、必须 ack、超时升级给人。其余全部异步。
3. **结构堵住自证 vs 裁决者成为单点。** 职责分离是 API 规则，不是角色：定判据、干活、验收三方不能是同一个身份。人是唯一例外。

## 骨架

一张 append-only 事件表加两张辅助表（cursor、delivery）。所有视图读时算出。

| kind | 是什么 | 结构性后果 |
|---|---|---|
| reading | 某时刻对某个 surface 的一次测量 | 同 surface:key 的新 reading 取代旧的；任何事件 `writes` 命中其 `depends_on` 即失效；`valid_until` 到期即过期。被 `refs` 引用时若已失效，拒绝。 |
| instruction | 给唯一收件人的动作要求 | ≤280 字。收件人 pull 到即记录 delivered。必须 ack，过 `ack_by` 未 ack 进入人的 NEEDS HUMAN。 |
| ack | 对 instruction 的确认 | 只有收件人或人能 ack。 |
| task | 工作项生命周期 | claim 要声明 `touches`。两个在途 task 的 touches 有交集自动产生 seam。done 只是 owner 的声明。verify 必须带 surface，actor 不能是 owner 或判据作者，且无未决 seam。 |
| note | 讨论、决策、顾虑 | 不承载动作。`decision: true` 加 `supersedes` 构成决策台账。 |

焦点不是新 kind：`reading{surface: team, key: focus}`，最新一条即当前焦点，一个槽位。

三个派生视图：**board**（焦点、需要人、开放指令、任务按状态、seam、reading 有效性、在场），**presence**（每个 actor 上次事件或 cursor 时间），**seam**（touches 交集）。

一个协议循环，每个 session 每轮跑：

```
ateam sync            拉新事件，指令送达被记录，cursor 前进即心跳
ateam ack <id>        对每条给我的指令
（检查我依赖的 reading 是否仍有效，失效则重取）
干活，ateam reading / task / note 记录
```

## 不做的事

topic 与 subscription、room 与 thread、Context Package 裁剪、observation→confirmed 状态阶梯、组织与 RBAC、GitHub App、Slack、Web UI、token 预算、digest。一天 55 条事件，每个 agent 读全量即可。有真实压力再加。

## 验证

`packages/core/test/replay.test.ts` 把实战报告那一天的失败模式编成断言：F1/F2 送达与 ack 与超时，F3 焦点槽位，F4 seam，F5 职责分离与验证表面，F6/F7/F8 reading 失效与 surface 隔离，F11 看板派生，S8 在场。全绿是 Phase 0 的完成定义。

Phase 0 之后的真正验证是第二步：用它组织这个项目自己的开发，并从运行中产生改进任务。
