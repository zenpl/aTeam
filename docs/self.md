# aTeam · 本项目档案

> 2026-09-06。这是 aTeam 团队用 aTeam 开发 aTeam 这个**项目**的档案，不是平台的一部分。平台的产品定义在 `docs/product.md`。凡是只对本项目成立的约定，写在这里，不写进说明书核心。

| 项 | 本项目的值 |
|---|---|
| 角色集 | pd、pm、dev、frontend、qa；human |
| 表面 | 仓库（`repo`）、生产（`production`）；没有 staging |
| 仓库 | `zenpl/aTeam`，pnpm workspace；分支 `<role>/<task-id>`；集成分支由团队自己合并（human 09-06 定 Q20 = A） |
| 上线 | 推 `production` 分支即由 CI 部署到 `ateam.fly.dev`（持续自动发布，human 09-06 定）。**推的动作由团队做**：pm 组批，后落地的节点合并到集成分支并推 `production`，部署后记 `production:deployed.sha` 事实；human 不在部署路径上（Q20 = A，09-06 14:5x） |
| 事实形状 | `production:deployed.sha` 为 7–40 位十六进制，或 `unknown` |
| 工具 | `./bin/ateam`（需 `pnpm install && pnpm build`）、`./bin/deploy` |
| 语言 | 日志内容一律中文；代码标识符、路径、sha、命令原样 |

`CLAUDE.md` 里今天混着说明书核心（每轮的循环、规则、职责分离）和这份档案；拆分是 S0 的第一件事：核心由服务下发，仓库里只留存根加档案。
