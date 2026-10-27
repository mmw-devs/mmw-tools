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

- 用**四个反引号**包住（三个也能匹配，但仓库习惯四个）
- 必填 `operator` / `timestamp` / `changes`
- `changes[].field` 是**叶子路径**：`teams[0].players[0].streaming`，不是 `teams`
- `from` / `to` 必须与实际 diff 完全一致
- 允许声明祖先路径（如声明 `news` 覆盖 `news[2].text`），但精确到叶子最稳妥
- PR 里有多个 commit 时，**每个 commit 的日志都会被校验**

判据以 `scripts/validate-op-log.ts` 为准，别凭记忆。

## preflight ≠ CI

| 阶段 | 谁在跑 | 查什么 |
|---|---|---|
| preflight | `repo_edit` | schema、值域、业务自洽（如 `isLive` 与 `players[].streaming` 必须一致） |
| op-log 门禁 | `pr_create` 推送前 | 提交信息格式 + `changes` 与实际 diff 一致 |
| CI | GitHub | 上面两项 + 文件范围 |

所以「本地绿」只代表前一层过了。

## 流程

1. `engineer_run` 读上下文（含 AGENTS.md 摘要）
2. 读文件确认现状，别凭印象改
3. `repo_edit`：一次改一个语义单元，日志块如实声明
4. `pr_create`：draft PR，交人审

## 不要做的事

- **不要合并 PR** —— 合并由人做。插件的凭据在技术上具备合并能力，所以这条只能靠约束，不能靠权限。
- 不要直接 push 到 `main`
- 不要为了让校验通过而放宽校验、注释掉检查、或在 denylist 上找绕路
- 改动被拒绝时，先读拒绝原因（它来自仓库自己的脚本），不要重试同样的操作

## 被拒绝时怎么读错误

- `[preflight-failed]` —— 数据本身不自洽，改的是内容
- `[op-log-invalid]` —— 提交信息的日志块不对，改的是信息
- `[find-ambiguous]` —— `find` 片段不唯一，加长锚点
- `[allowlist-violation]` / `[branch-prefix]` —— 越界，停下来看规则
