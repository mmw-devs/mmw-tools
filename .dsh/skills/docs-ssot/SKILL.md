---
name: docs-ssot
description: 当源码改动触发文档影响检查、需要修改 AGENTS.md 或 scripts/doc-map.json、或要判断某段文档是否已经漂移时使用。给出语义核对步骤、Doc-Impact 记录格式和停止条件。
---

# 文档漂移治理规程

这份规程只解决一个问题：**CI 能证明“文档被碰过”，但证明不了“文档改对了”**。语义判断由执行者完成，判断结果必须留下可复核的记录。

权威顺序见 [`docs/DOCUMENTATION.md`](../../../docs/DOCUMENTATION.md)；硬约束见 [`AGENTS.md`](../../../AGENTS.md)；文档到源码的唯一映射见 [`scripts/doc-map.json`](../../../scripts/doc-map.json)。不要在本文件里复制这些内容。

## 何时使用

- `node scripts/doc-impact.mjs` 列出了某些文档。
- 你要新增、删除、重命名或移动文档。
- 你发现文档与代码不一致，即使这次没有改源码。
- 你要判断某条 `Doc-Impact: ... — 无语义变更` 是否成立。
- 你要为跨模块的产品决策写一份 `docs/ADR-*.md` 提案：用 `target design`，写明被否的选项与尚未实现的部分。
- 你要新增或重命名工具、operation：命名是契约的一部分，先看 [`docs/TOOL-NAMING.md`](../../../docs/TOOL-NAMING.md)。

## 输入

1. 本次 change 的 diff（含未提交改动时用 `--worktree`）。
2. 影响检查输出：受影响的文档路径与触发它的源文件。
3. 每个受影响文档的正文，以及被改动源码的公开行为。
4. 如果改的是契约，还要有 `contracts/REFERENCE.md` 与 golden route table 的生成 diff。

## 步骤

1. 跑影响检查，不要凭印象列文档：

   ```sh
   node scripts/doc-impact.mjs --base origin/main --worktree
   ```

   沙箱禁止 git 子进程时：

   ```sh
   node scripts/doc-impact.mjs --changed "path/a.ts,path/b.md"
   ```

2. 对每个受影响文档，先完整读它，再用 `grep` 找被改符号、端点、字段、错误码、命令或配置键。不要只读 diff 附近几行。
3. 判断这次源码改动是否改变了文档所定义的**对外可观察事实**。只改内部实现、注释、测试夹具，通常不改变对外事实；改默认值、校验、错误码、权限、输出形状，通常会。
4. 按下面的决策表处理，不要用同一种动作套所有情况。
5. 在 PR 描述里为每个受影响文档写一行 `Doc-Impact`。同一行要能让 reviewer 复核，不要写“已同步”这种无法验证的话。
6. 跑验证命令；如果影响检查仍列出文档，说明要么文档没改，要么映射已经不再是它该负责的事实。

## 决策表

| 情况 | 动作 |
|---|---|
| 文档直接写了被改的事实（端点、字段、错误码、默认值、权限、命令） | 在同一个 change 内更新该段，并写 `Doc-Impact: <path> — 已更新：<事实>` |
| 文档只链接到源，正文没有复制该事实 | 正文可以不动，写 `Doc-Impact: <path> — 无语义变更：<文档只链接，未复制该事实>` |
| 文档已经不再拥有这条事实，事实迁到了代码或另一份文档 | 改 `scripts/doc-map.json` 的 `sources`/`defines`，不要把原文档改成假话；写清迁移去向 |
| 新增了一个文档 | 在 `scripts/doc-map.json` 加条目：`status`、`defines`、`sources`；用 `--worktree` 确认不再报 “new markdown is not in scripts/doc-map.json”。如果入口文档（`README.md`、`docs/DOCUMENTATION.md`）的阅读指南确实需要收录它，就加一行；否则按“无语义变更”写清依据，不要为了过检查复制正文 |
| 文档是 `generated` | 跑生成命令（契约用 `node scripts/check-contracts.mjs --update`），审查生成 diff，禁止手改 |
| 文档是 `historical` | 不改写正文；需要时追加带日期的更正说明，并说明它不再是当前事实 |
| 文档正文说“设计已定、尚未实现”，但 map 标成 `historical` | 改 map 的 `status` 为 `target design`；不要为了通过检查把正文改写成“已实现” |
| 源码改动确实不影响任何文档事实，但文档仍被 glob 命中 | 写 `Doc-Impact: <path> — 无语义变更：<具体依据>`；依据必须是可检查的，例如“该文档只描述 CLI 名称，本次只改内部重试次数” |
| 无法判断，或依据依赖未合并的另一个 PR | 写 `needs-human-review` 并停下，不要用空白或标点改动蒙混过关 |

## 禁止

- 只加空行、改标点、换同义词，让路径出现在 diff 里。
- 删除映射、放宽 glob、注释掉检查，来让 CI 变绿。
- 把 `historical` 文档改写成“当前”，或把 `target design` 写成“已实现”。
- 在多个文档里重复同一张事实表；应该生成或链接。
- 为了让 `Doc-Impact` 好看而编造依据。

## 停止条件

遇到以下任一情况，停在 `needs-human-review`，并在 PR 里说明缺什么：

- 找不到哪份文档拥有被改事实。
- 文档与代码的冲突需要产品决策（例如角色范围、是否暴露新端点）。
- 需要改 `scripts/doc-impact.mjs`、`scripts/doc-map.json` 或 CI 才能让检查通过，但你不确定这是映射问题还是实现问题。
- 生成文件与源不一致，且你无法判断哪边是权威。

## 验证

```sh
node scripts/doc-impact.mjs --base origin/main --worktree
node scripts/check-docs.mjs
node scripts/check-contracts.mjs
node scripts/doc-impact.test.mjs
```

CI 的 `Check documentation impact` 负责路径耦合与映射覆盖；`check-docs` 负责已知过时标识符；本 skill 负责语义真假。不要新增一个重复跑路径检查的 CI 步骤。
