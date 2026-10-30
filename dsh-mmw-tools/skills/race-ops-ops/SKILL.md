---
name: race-ops-ops
description: 在 mmw-devs/ffxiv-race-ops 仓库执行内容变更时使用。说明哪些文件可改、提交信息里的结构化日志块怎么写、以及为什么 preflight 通过不等于 CI 通过。
---

# ffxiv-race-ops 作业规程

这份文档只写「规则在哪、为什么」，**不复述规则本身** —— 真正的判据是仓库里的脚本，两边各写一份必然漂移。

## 可修改范围

只有 `public/data.json`。

`denylist` 覆盖 `.github/`、`schema/`、`scripts/`、`constants.js`、`AGENTS.md`、`README.md`、`.pi/`、`dist/`。碰这些会被 `repo_edit` / `pr_create` 直接拒绝，不是警告。

## 分支

必须以 `content/` 开头。

## 提交信息必须带结构化日志块

这是本仓库最容易踩的坑：**代码校验全过，CI 仍然红**，因为 CI 还校验提交信息。

一个可用的提交信息长这样：

`````
content: t2 DRK 停止直播（streaming true → false）

````json
{
  "operator": "weunimix",
  "timestamp": "2026-10-28T01:16:00Z",
  "changes": [
    { "field": "teams[0].players[0].streaming", "from": true, "to": false }
  ]
}
````
`````

要点：

格式的**唯一判据**是 `scripts/validate-op-log.ts`。插件在 `pr_create` 推送前会调用它，
并把校验器的原始输出原样返回 —— 以那段输出为准，不要凭这里的描述记规则。

要读源码时看三个函数：`parseLogFromMessage`（怎么提取块）、`validateLogStructure`（字段要求）、
`deepDiff` + `isAncestorField`（声明与真实 diff 怎么对应）。

## preflight ≠ CI

| 阶段 | 谁在跑 | 查什么 |
|---|---|---|
| preflight | `repo_edit` | schema、值域、业务自洽（如 `isLive` 与 `players[].streaming` 必须一致） |
| op-log 门禁 | `pr_create` 推送前 | 提交信息格式 + `changes` 与实际 diff 一致 |
| CI | GitHub | 上面两项 + 文件范围 |

所以「本地绿」只代表前一层过了。

## 流程

1. `mmw_tools_run` 读上下文（含 AGENTS.md 摘要）
2. 读文件确认现状，别凭印象改
3. `repo_edit`：一次改一个语义单元，日志块如实声明
4. `pr_create`：推送分支并开 PR（默认 draft；这条流程要合并的话传 `draft: false`，或让 `pr_merge` 自己转 ready）
5. `pr_preview`：CI 跑完后取预览地址，把 **Branch Preview URL** 发给用户看
6. 等用户明确同意合并，再调用 `pr_merge`（宿主会再弹一次确认）

预览不是从 GitHub 页面上抄的，而是 hosting（Cloudflare Pages）check 里给出的链接；
刚开 PR 时它还没生成，`pr_preview` 传 `wait_seconds`（例如 60）等它出现即可。

## 不要做的事

- **用户没有明确同意前不要合并**。同意后正常调用 `pr_merge`；draft 状态会被自动转成 ready，
  不需要让用户去网页上点。宿主在执行前还会再确认一次。
- 是否「可合并」（检查是否通过、有无冲突）**以 GitHub 的分支保护为准**，工具只转述 `mergeStateStatus`，不要在别处重新判断一遍。
- 不要直接 push 到 `main`
- 不要为了让校验通过而放宽校验、注释掉检查、或在 denylist 上找绕路
- 改动被拒绝时，先读拒绝原因（它来自仓库自己的脚本），不要重试同样的操作

## 被拒绝时怎么读错误

- `[preflight-failed]` —— 数据本身不自洽，改的是内容
- `[op-log-invalid]` —— 提交信息的日志块不对，改的是信息
- `[find-ambiguous]` —— `find` 片段不唯一，加长锚点
- `[allowlist-violation]` / `[branch-prefix]` —— 越界，停下来看规则
