# AGENTS.md — 工作约定

Status: living

本文件只写 agent 必须遵守的硬约束和触发条件，不复述完整规则：

- 文档权威顺序、状态标签与生成规则：见 [`docs/DOCUMENTATION.md`](docs/DOCUMENTATION.md)。
- 文档影响映射：见 [`docs/doc-map.json`](docs/doc-map.json)；下面的表由它生成。
- 语义核对流程：见 [`.dsh/skills/docs-ssot/SKILL.md`](.dsh/skills/docs-ssot/SKILL.md)。判断“文档该不该改、改成什么”时先加载这个 skill。

## 何时必须行动

- 改源码、契约、CI、部署脚本或任何被 `docs/doc-map.json` 列为 source 的文件。
- 新增、重命名、删除文档，或移动文档定义的职责。
- 发现文档与代码不一致，即使这次没有改对应源码。

## 改源码前

1. 对分支基点跑影响检查，并包含未提交改动：

   ```sh
   node scripts/doc-impact.mjs --base origin/main --worktree
   ```

   沙箱禁止 git 子进程时，显式传改动路径：

   ```sh
   node scripts/doc-impact.mjs --changed "src/a.ts,README.md"
   ```

2. 输出列出的每个文档，都要在同一个 change 内处理。不能留到下一个 PR。
3. 按 `docs-ssot` skill 做语义核对，不要只做空白、标点或无关句子的“仪式性修改”。
4. 在 PR 描述里为每个受影响文档写一行记录：

   ```text
   Doc-Impact: docs/example.md — 已更新：<改了哪条事实>
   Doc-Impact: docs/other.md — 无语义变更：<为什么这次源码改动不影响它定义的内容>
   ```

   无法给出可复核的依据时，写 `needs-human-review` 并停下，不要猜。
5. 契约改动先跑 `node scripts/check-contracts.mjs --update`，再审查生成 diff。
6. 跑根 [`README.md`](README.md#verify) 里的验证命令。

## 硬规则

- `contracts/tools.json` 和 `contracts/roles.json` 是契约唯一源。`contracts/REFERENCE.md` 与 `contracts/examples/` 是生成物，禁止手改。
- 叙事文档不复制易漂移事实（数量、端点表、角色矩阵、TTL、主机名、部署状态），而是链接到源。宁可写得模糊但保持为真，也不要精确但过期。
- `historical` 文档是快照：只追加带日期的更正说明，不改写成“当前”。`target design` 文档必须写明哪些部分尚未实现。
- 生成表过期、tracked markdown 未登记、source glob 命中不到任何文件，都会让 CI 失败。不要通过删除映射、放宽 glob 或注释检查来绕过。
- CI 已经有 `Check documentation impact`，它只证明路径耦合与映射覆盖，不证明内容正确。不要为同一目的再加一遍检查；语义真假由 `docs-ssot` skill 与 review 负责。
- 文档定义的事实迁到别处时，改 `docs/doc-map.json`，不要把原文档改成一句假话。

## 文档地图

<!-- doc-map:start -->
<!-- 由 docs/doc-map.json 生成。请勿手改。 -->
<!-- 重新生成：node scripts/doc-impact.mjs --write-agents -->

| 文档 | 状态 | 定义内容 | 这些变化时更新 |
|---|---|---|---|
| [`README.md`](README.md) | 常青 | 仓库入口：交付物、目录结构与验证命令。 | `AGENTS.md`<br>`.github/workflows/ci.yml`<br>`scripts/check-contracts.mjs`<br>`scripts/check-docs.mjs`<br>`scripts/doc-impact.mjs`<br>`docs/doc-map.json`<br>`mmw-tools-auth/deploy/**` |
| [`AGENTS.md`](AGENTS.md) | 常青 | Agent 的硬约束、触发条件与生成的文档影响索引。 | `docs/doc-map.json`<br>`scripts/doc-impact.mjs`<br>`scripts/check-docs.mjs`<br>`.github/workflows/ci.yml` |
| [`.dsh/skills/docs-ssot/SKILL.md`](.dsh/skills/docs-ssot/SKILL.md) | 常青 | 文档漂移治理的语义核对流程、Doc-Impact 记录与停止条件。 | `AGENTS.md`<br>`docs/DOCUMENTATION.md`<br>`scripts/doc-impact.mjs` |
| [`contracts/ERRORS.md`](contracts/ERRORS.md) | 常青 | 稳定错误码与响应信封。 | —（手动维护；无自动触发） |
| [`contracts/FIELDS.zh-CN.md`](contracts/FIELDS.zh-CN.md) | 常青 | v2 tool-centric 契约的逐字段说明。 | `contracts/tools.json`<br>`contracts/roles.json`<br>`contracts/tools.schema.json`<br>`contracts/routes.schema.json` |
| [`contracts/REFERENCE.md`](contracts/REFERENCE.md) | 生成 | 角色目录、工具目录与角色到操作矩阵的生成快照。 | `contracts/tools.json`<br>`contracts/roles.json`<br>`mmw-tools-auth/src/policy.mjs` |
| [`contracts/README.md`](contracts/README.md) | 常青 | v2 契约模型：工具角色、操作级覆盖、权限与生成产物。 | `contracts/tools.json`<br>`contracts/roles.json`<br>`contracts/tools.schema.json`<br>`mmw-tools-auth/src/policy.mjs`<br>`scripts/check-contracts.mjs` |
| [`dsh-mmw-tools-design.md`](dsh-mmw-tools-design.md) | 历史快照 | 架构与业务逻辑设计（v2，对齐 race-ops 的 AGENTS.md）。 | —（历史快照；无自动触发） |
| [`docs/DEPLOYMENTS.md`](docs/DEPLOYMENTS.md) | 历史快照 | 已验证部署的追加式记录。 | —（历史快照；无自动触发） |
| [`docs/DOCUMENTATION.md`](docs/DOCUMENTATION.md) | 常青 | 文档权威顺序、状态标签、生成规则与影响检查。 | `docs/doc-map.json`<br>`scripts/check-docs.mjs`<br>`scripts/doc-impact.mjs`<br>`.github/workflows/ci.yml` |
| [`docs/OBSERVABILITY.md`](docs/OBSERVABILITY.md) | 常青 | runId 传播、审计事件与 trace 存储决策。 | `dsh-mmw-tools/src/util/**`<br>`dsh-mmw-tools/src/gate/**`<br>`dsh-mmw-tools/src/index.ts`<br>`dsh-mmw-tools/mcp-server/src/**` |
| [`dsh-plugin-api-cheatsheet.md`](dsh-plugin-api-cheatsheet.md) | 历史快照 | DSH 0.1.5 插件 API 精要。 | —（历史快照；无自动触发） |
| [`github-oauth-app-checklist.md`](github-oauth-app-checklist.md) | 历史快照 | GitHub OAuth App 注册清单。 | —（历史快照；无自动触发） |
| [`lark-vs-dsh.md`](lark-vs-dsh.md) | 历史快照 | DSH 飞书插件与 lark-cli 的对比研究笔记。 | —（历史快照；无自动触发） |
| [`mmw-tools-routing-layer-plan.md`](mmw-tools-routing-layer-plan.md) | 常青 | 授权层为何如此设计：决策、边界与已知缺口。 | `mmw-tools-auth/src/**`<br>`dsh-mmw-tools/src/gate/**`<br>`dsh-mmw-tools/src/auth/**`<br>`dsh-mmw-tools/src/index.ts` |
| [`mmw-tools-routing-state-machine.md`](mmw-tools-routing-state-machine.md) | 目标设计 | auth、policy、transport 的目标状态机；不是已交付行为。 | `dsh-mmw-tools/src/gate/**`<br>`dsh-mmw-tools/src/auth/**`<br>`dsh-mmw-tools/src/index.ts`<br>`dsh-mmw-tools/src/util/run-context.ts` |
| [`dsh-mmw-tools/CHANGELOG.md`](dsh-mmw-tools/CHANGELOG.md) | 历史快照 | 插件逐增量历史。 | —（历史快照；无自动触发） |
| [`dsh-mmw-tools/README.md`](dsh-mmw-tools/README.md) | 常青 | 插件安装、配置、工具行为、安全模型与测试。 | `dsh-mmw-tools/src/**`<br>`dsh-mmw-tools/package.json`<br>`dsh-mmw-tools/cordis.patch.yml` |
| [`dsh-mmw-tools/docs/AUTH-BROKER.md`](dsh-mmw-tools/docs/AUTH-BROKER.md) | 历史快照 | GitHub App + token broker 拓扑的设计记录。 | —（历史快照；无自动触发） |
| [`dsh-mmw-tools/docs/INCREMENT-2-VERIFICATION.md`](dsh-mmw-tools/docs/INCREMENT-2-VERIFICATION.md) | 历史快照 | 对照 DSH 源码验证的客户端 bundle 构建决策。 | —（历史快照；无自动触发） |
| [`dsh-mmw-tools/docs/INCREMENT-3-CHECKLIST.md`](dsh-mmw-tools/docs/INCREMENT-3-CHECKLIST.md) | 历史快照 | 逐工具加固清单。 | —（历史快照；无自动触发） |
| [`dsh-mmw-tools/docs/INCREMENT-3-DESIGN.md`](dsh-mmw-tools/docs/INCREMENT-3-DESIGN.md) | 历史快照 | 八个 MCP 工具的设计。 | —（历史快照；无自动触发） |
| [`dsh-mmw-tools/docs/INCREMENT-4-CHECKLIST.md`](dsh-mmw-tools/docs/INCREMENT-4-CHECKLIST.md) | 历史快照 | mmw_tools_run 契约及其非 LLM 边界。 | —（历史快照；无自动触发） |
| [`dsh-mmw-tools/docs/INCREMENT-5-DESIGN.md`](dsh-mmw-tools/docs/INCREMENT-5-DESIGN.md) | 历史快照 | 审计事件与存储决策。 | —（历史快照；无自动触发） |
| [`dsh-mmw-tools/docs/NEXT-STEPS.md`](dsh-mmw-tools/docs/NEXT-STEPS.md) | 历史快照 | 冻结在 v0.6.0 的“有意缺失能力”清单。 | —（历史快照；无自动触发） |
| [`dsh-mmw-tools/docs/OPERATIONS-SYNC.md`](dsh-mmw-tools/docs/OPERATIONS-SYNC.md) | 常青 | 谁负责保持 race-ops AGENTS.md 与 cordis.patch.yml 同步。 | `dsh-mmw-tools/cordis.patch.yml`<br>`dsh-mmw-tools/src/agents-md-check.ts` |
| [`dsh-mmw-tools/docs/PANEL-CONTRACT.md`](dsh-mmw-tools/docs/PANEL-CONTRACT.md) | 常青 | 设置面板状态机与操作矩阵。 | `dsh-mmw-tools/src/client/**`<br>`dsh-mmw-tools/src/shared/api-paths.ts` |
| [`dsh-mmw-tools/docs/PUBLISHING.md`](dsh-mmw-tools/docs/PUBLISHING.md) | 常青 | 发布清单与分发渠道。 | `dsh-mmw-tools/package.json` |
| [`dsh-mmw-tools/docs/SETTINGS-PANEL-DESIGN.md`](dsh-mmw-tools/docs/SETTINGS-PANEL-DESIGN.md) | 历史快照 | 设置面板设计记录。 | —（历史快照；无自动触发） |
| [`dsh-mmw-tools/docs/T5-RUNBOOK.md`](dsh-mmw-tools/docs/T5-RUNBOOK.md) | 常青 | 真实往返的分步 runbook 与停止条件。 | —（手动维护；无自动触发） |
| [`dsh-mmw-tools/docs/TESTING.md`](dsh-mmw-tools/docs/TESTING.md) | 常青 | 测试分层、各层依赖与新增用例方式。 | `dsh-mmw-tools/package.json`<br>`dsh-mmw-tools/tests/**`<br>`dsh-mmw-tools/mcp-server/tests/**` |
| [`dsh-mmw-tools/skills/race-ops-ops/SKILL.md`](dsh-mmw-tools/skills/race-ops-ops/SKILL.md) | 常青 | race-ops-ops skill 的操作说明。 | —（手动维护；无自动触发） |
| [`mmw-tools-auth/README.md`](mmw-tools-auth/README.md) | 常青 | auth core 的安装、端点、安全属性与限制。 | `mmw-tools-auth/src/**` |
| [`mmw-tools-auth/deploy/README.md`](mmw-tools-auth/deploy/README.md) | 常青 | 生产部署、资源预算、备份恢复与回滚。 | `mmw-tools-auth/deploy/*.mjs`<br>`mmw-tools-auth/deploy/*.sh`<br>`mmw-tools-auth/deploy/*.conf`<br>`mmw-tools-auth/deploy/systemd/**` |
<!-- doc-map:end -->

## 维护映射

编辑 `docs/doc-map.json` 后运行：

```sh
node scripts/doc-impact.mjs --write-agents
```

两个文件一起提交。`scripts/doc-impact.mjs` 会校验每个文档存在、状态合法、source glob 相对仓库且至少命中一个 tracked 文件，并要求每个 tracked markdown 都已登记。上表是生成物，不要手改。
