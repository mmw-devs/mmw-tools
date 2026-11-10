# AGENTS.md — 工作约定

Status: living

本文件只写 agent 必须遵守的硬约束和触发条件，不复述完整规则：

- 文档权威顺序、状态标签与生成规则：见 [`docs/DOCUMENTATION.md`](docs/DOCUMENTATION.md)。
- 文档影响映射：见 [`scripts/doc-map.json`](scripts/doc-map.json)。它是唯一索引，本文件只链接，不复制表。
- 语义核对流程：见 [`.dsh/skills/docs-ssot/SKILL.md`](.dsh/skills/docs-ssot/SKILL.md)。判断“文档该不该改、改成什么”时先加载这个 skill。

## 何时必须行动

- 改源码、契约、CI、部署脚本或任何被 `scripts/doc-map.json` 列为 source 的文件。
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

   `--worktree` 也会检查未跟踪的新 markdown；新建文档时，它会把“还没登记”的文件报出来。按 `docs-ssot` skill 在 `scripts/doc-map.json` 加条目，再重跑。

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
- tracked markdown 未登记、source glob 命中不到任何文件，都会让 CI 失败。不要通过删除映射、放宽 glob 或注释检查来绕过。
- CI 已经有 `Check documentation impact`，它只证明路径耦合与映射覆盖，不证明内容正确。不要为同一目的再加一遍检查；语义真假由 `docs-ssot` skill 与 review 负责。
- 文档定义的事实迁到别处时，改 `scripts/doc-map.json`，不要把原文档改成一句假话。

## 文档地图

[`scripts/doc-map.json`](scripts/doc-map.json) 是文档到源码的唯一映射：每个 tracked markdown 的职责、状态和触发它的源码范围都在里面。状态标错也在清单里修正，不要把历史快照改写成“当前”。改源码前先读它；本文件不复制第二份表。
