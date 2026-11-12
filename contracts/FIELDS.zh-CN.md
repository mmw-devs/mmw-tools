# 契约字段说明（v2，tool-centric）

> 配套文件：[`tools.json`](tools.json)、[`roles.json`](roles.json)、[`routes.schema.json`](routes.schema.json)
> 目的：解释每个字段的含义；**不是运行时文件**。

## 1. JSON 能不能写注释？

**不能。** `tools.json` / `roles.json` 是严格 JSON，`JSON.parse` 会拒绝 `//` 和 `/* */`。
字段说明看 JSON Schema 的 `description` 或本文件。

## 2. 模型

```
权限视角：tool -> requiredPermissions
工具视角：tool -> roles
运行时：role 能不能消费 tool
```

没有 `role -> permission` 映射。工具是授权单位；角色是成员标签。

## 3. `tools.json`

| 字段 | 必填 | 含义 |
|---|---|---|
| `contractVersion` | 是 | 当前为 `2`。 |
| `tools` | 是 | 工具列表。 |
| `tools[].id` | 是 | 工具 ID，例如 `race-ops`；授权单位。 |
| `tools[].title` | 是 | 工具显示名。 |
| `tools[].description` | 否 | 面向用户/管理员的说明。 |
| `tools[].always` | 否 | `true` 表示所有成员都可消费；用于状态工具。 |
| `tools[].roles` | 是 | 可消费该工具的角色；`always: true` 时可为空。 |
| `tools[].requiredPermissions` | 是 | 工具自身需要的技术权限，例如 `github:contents:write`；不是用户授权。 |
| `tools[].operations` | 是 | 工具内部 operation 列表。 |
| `operations[].id` | 是 | operation ID，例如 `repo_read`；在工具内唯一。 |
| `operations[].publicName` | 是 | agent 看到的工具名；MCP 为 `mcp__...`，原生为 `mmw_tools_*`。 |
| `operations[].description` | 是 | 给 agent 的说明；也会写进运行时行为提示，例如 `pr_merge` 在目标仓库声明了 `agentMerge: false` 时拒绝合并。 |
| `operations[].risk` | 是 | `read` 或 `write`；`write` 在授权表不新鲜时 fail closed。 |
| `operations[].roles` | 否 | operation-level 角色覆盖；例如 `select_repo` 显式声明四个角色，使其在选仓库前可被调用。未设置时继承 `tools[].roles`。 |

## 4. `roles.json`

| 字段 | 必填 | 含义 |
|---|---|---|
| `contractVersion` | 是 | 当前为 `2`。 |
| `roles` | 是 | 成员角色列表。 |
| `roles[].id` | 是 | 角色 ID，例如 `operator` / `admin`。 |
| `roles[].title` | 是 | 角色显示名。 |
| `roles[].description` | 否 | 面向管理员的说明。 |
| `roles[].admin` | 否 | `true` 表示可以进入管理 UI；不隐含任何工具权限。 |

## 5. `GET /v1/agent/routes` 字段

| 字段 | 含义 |
|---|---|
| `contractVersion` | 当前为 `2`。 |
| `catalogRevision` | `tools.json` 的 canonical SHA-256。 |
| `policyRevision` | 成员角色变化时递增。 |
| `ttlSeconds` | 授权表缓存时长，v2 默认 60。 |
| `allowed` | 允许消费的 tool ID 集合。 |
| `allowedOperations` | 允许调用的 operation 全 ID（`toolId.operationId`）；gate 优先检查。 |
| `denied[].toolId` | 被拒绝的工具。 |
| `denied[].requiredRoles` | 该工具需要的角色。 |

## 6. Annotated 示例（仅文档）

```jsonc
// 这是文档示例，不是 tools.json；运行时 JSON 不能带注释。
{
  "contractVersion": 2,
  "tools": [
    {
      "id": "race-ops",                 // 授权单位
      "roles": ["operator", "admin"],   // 谁能消费
      "requiredPermissions": [          // 工具需要什么，不是用户授权
        "github:contents:write",
        "github:pull_requests:write"
      ],
      "operations": [
        {
          "id": "repo_read",
          "publicName": "mcp__mmw-tools__repo_read",
          "risk": "read"
        },
        {
          "id": "pr_merge",
          "publicName": "mcp__mmw-tools__pr_merge",
          "risk": "write"
          // 可选：加 "roles": ["admin"] 做 operation-level 覆盖
        }
      ]
    }
  ]
}
```

当前 `pr_close` 也是这类 operation-level 覆盖的写操作，显式声明
`roles: ["editor", "operator", "admin"]`；它复用上面的字段结构，不新增字段。

## 7. 修改后怎么办

```sh
node scripts/check-contracts.mjs
node scripts/check-contracts.mjs --update
```

检查 `contracts/examples/` 的 diff，确认 `allowed` / `allowedOperations` 变化符合预期。
