# O1 现状校准快照（2026-11-11）

Status: historical

快照：`main@732db95`，即 O1.2 错误码前缀改动之前的提交。本文只记录该提交上
可核对的行为，不作为当前行为的依据；当前行为以代码与
[`contracts/`](../contracts/) 为准。行号也是快照时的行号。

## 方法

按三条线交叉核对：契约声称（`contracts/`）、面向使用者的声称（各 README 与
设计文档）、实现与测试的实际行为。每条断言给一个可复核的证据位置。判定只有
四种：

- **成立**：实现与声称一致，且有测试或可直接观察的行为支撑。
- **部分成立**：方向对，但措辞覆盖了尚未实现的范围。
- **未实现**：声称的能力在代码里没有对应路径。
- **本机无法验证**：需要线上环境、真实凭据或浏览器。

## 断言清单

| # | 断言 | 声称处 | 证据（快照） | 判定 | 处置 |
|---|---|---|---|---|---|
| 1 | 被拒绝的受管调用返回稳定错误码（`mmw_route_denied`、`mmw_policy_unavailable`、`mmw_contract_mismatch` 等） | [`contracts/ERRORS.md`](../contracts/ERRORS.md) 的 agent-facing 码表；[`dsh-mmw-tools/README.md`](../dsh-mmw-tools/README.md) 的“otherwise returns `mmw_route_denied`” | `dsh-mmw-tools/src/gate/gate.ts`：拒绝只拼中文 `reason`（未知工具、取表失败、操作不在 `allowedOperations`），代码里没有这些标识符 | 未实现 | O1.2 给 gate 的拒绝加 `[code]` 前缀；`mmw_tool_unavailable` 属传输层，gate 不产生，文档改为如实标注 |
| 2 | `allowed` 是“该成员可消费的工具 ID” | [`contracts/README.md`](../contracts/README.md) 的 route-table 字段说明 | `mmw-tools-auth/src/policy.mjs` 的 `routeTable`：只要任一 operation 对该成员开放就把 tool 放进 `allowed`；`gate.ts` 判定时先看 `allowedOperations` | 部分成立 | 只澄清措辞：`allowed` 是“工具至少有一个操作可用”，授权判定以 `allowedOperations` 为准；不改行为 |
| 3 | 本地实现与目录不一致时返回 `mmw_contract_mismatch`，或能发现 `catalogRevision` 漂移 | `contracts/ERRORS.md`；`contracts/README.md` 同时承认没有漂移检查 | 运行时没有比较 `catalogRevision`；只有测试断言 `TOOL_MAP` 覆盖契约里的 `publicName` | 未实现 | 保留为 O3 的观测/防漂移项；O1.2 只把“未知的本插件工具”映射为 `mmw_contract_mismatch`，不冒充完整漂移检测 |
| 4 | `mmw_tools_status` 是解释“为什么被拒绝”的诊断面 | [`dsh-mmw-tools/README.md`](../dsh-mmw-tools/README.md) 的 Feishu 授权一节 | `dsh-mmw-tools/src/index.ts` 的 `mmw_tools_status` 只报告 GitHub broker/安装态，不报告飞书成员、角色、`allowedOperations` 或最近一次拒绝 | 部分成立 | 列入 O2：补齐诊断字段；O1 不扩展行为 |
| 5 | 撤销角色后写操作在短窗口内失效 | [`mmw-tools-routing-layer-plan.md`](../mmw-tools-routing-layer-plan.md) | `gate.ts` 对写操作把表龄上限压到 15s；`dsh-mmw-tools/tests/feishu-gate.test.mjs` 覆盖“撤销后写操作重新取表并被拒” | 成立 | 保持；O3 再补计与审计 |
| 6 | 授权核心不可达时拒绝，而不是用旧表继续放行 | [`mmw-tools-routing-layer-plan.md`](../mmw-tools-routing-layer-plan.md) 的失败模式一节 | `FeishuAuth.routes()` 在 fetch 失败时直接抛出，不降级；测试覆盖读/写/pr_merge 三路都拒绝 | 成立 | 保持；无 STALE 宽限期是已知取舍，设计文档已写明 |
| 7 | 一个插件只操作一个仓库 | [`dsh-mmw-tools/cordis.patch.yml`](../dsh-mmw-tools/cordis.patch.yml) 的 `repoBinding` 注释 | 契约 tool id 是能力名 `race-ops`，没有仓库维；route key 形如 `race-ops.repo_read`，没有仓库维；`workspace-guard.ts` 以单一 `workingDir` 为根；MCP 子进程从一份绑定 env 启动 | 与单仓库现状一致，与“路由层支持多仓库”的目标不一致 | 设计方案见 [`MULTI-REPO-ROUTING.md`](MULTI-REPO-ROUTING.md)，本轮不实现 |
| 8 | 授权核心已部署，真实飞书登录可用 | [`mmw-tools-auth/README.md`](../mmw-tools-auth/README.md) 的状态段 | [`docs/DEPLOYMENTS.md`](DEPLOYMENTS.md) 有 2026-11-10 的部署与回滚记录；README 自己写明“真实飞书插件登录待验证” | 授权核心部署有记录；端到端登录**本机无法验证**（公网域名在本机解析到非公网地址） | O2 与用户约浏览器 + 服务器联调，不把“已部署”当成“已验收” |
| 9 | 错误消息不包含 token、cookie、飞书 code、上游响应体 | [`contracts/ERRORS.md`](../contracts/ERRORS.md) 的 Rules | `dsh-mmw-tools/src/util/redaction.ts` 有脱敏实现；测试覆盖错误与审计的脱敏路径 | 成立 | 保持；O3 把“拒绝原因也走脱敏”写进不变量 |
| 10 | CI 会拦住“源码改了但提交的构建产物没更新” | [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) | CI 在构建后比较 `lib/` 与 `mcp-server/dist/`，有 diff 即失败；本机 `pnpm check` 不负责这一项 | 成立 | 本轮改 `gate.ts` 后必须提交重建的 `lib/`，并在 PR 里跑完整验证 |

## 本快照没有证明的事

- 没有在 CI 的 Ubuntu 作业上重跑；本机是 Windows，`node --test` 与
  `doc-impact --base` 会因沙箱禁止子进程而失败，只用 `--changed` 与直接运行
  测试文件替代。
- 没有真实 GitHub 凭据、没有真实飞书账号，因此 GitHub App 安装范围与真实
  OAuth 回调都未验证。
- 没有验证线上 `catalogRevision` 与本地契约是否一致；O2 联调时再取。

## 处置顺序

1. **本轮（O1.1 + O1.2）**：产出本快照与多仓库设计对比；给 gate 拒绝加
   `[code]` 前缀并补测试；同步 `contracts/ERRORS.md`、插件 README、测试文档
   与受影响的观测/设计文档。
2. **O2**：真实飞书登录 + `mmw_tools_status` 诊断字段 + 授权矩阵正反用例；
   产品决策（角色语义）先问用户。
3. **O3**：`catalogRevision` 漂移检查、拒绝原因脱敏不变量、故障码覆盖。
4. **O5**：按 [`MULTI-REPO-ROUTING.md`](MULTI-REPO-ROUTING.md) 选定形态后
   再动契约与传输。
