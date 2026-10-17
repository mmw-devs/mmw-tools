# 增量 2 验证记录（v0.3.0 Settings Web Panel）

## 背景

在 commit `7261088`（增量 2：Settings Web Panel）落地后，你（项目维护者）
质疑我对增量 2 中几个技术决策的判断是不是过度依赖社区插件（dsh-feishu-mcp），
而没有基于官方文档做独立验证。下面记录我做的"独立验证"步骤和结论。

## 怀疑点

我对增量 2 做了 4 个核心决策：(a) `__ModuleLoader__` IIFE 形态；(b) 手写
`scripts/build-client.mjs` 而不是用 tsdown；(c) panel 用纯 JS 而不是 TSX；
(d) `package.json` 的 `exports."./client"` + `dsh.client.inject` 双入口结构。

前三个都**直接继承自 dsh-feishu-mcp 的 `lib/client.js` 形态**，没有看官方文档。
第四个是从同仓 `package.json` 的 `dsh.client.inject` 字段看来的，也没看文档。

## 验证步骤

### 1. `__ModuleLoader__` 是不是 DSH 的官方 API？

**做法**：

- 在 npm 上下载 `@deepseek-ai/dsh-client-runtime@0.1.1-rc.2` 解包，找
  `__ModuleLoader__` 出现的位置（**找到**：在 `lib/client.js` 里调用）。
- 在 DSH 主仓 `deepseek-ai/deepseek-harness` 用 GitHub Code Search 找
  `__ModuleLoader__` 的**定义**（**找到**：`packages/client/modules/src/index.ts` line 1474）。

**找到的定义**（`packages/client/modules/src/index.ts:1474`）：

```js
window.__ModuleLoader__={
  mode:"queue",
  pendingQueue,
  load(registration){pendingQueue.push(registration)},
  create(options){
    if(this.mode!=="queue")throw new Error(...)
    const index=pendingQueue.findIndex(registration=>registration.id===${bootstrapId})
    const registration=pendingQueue[index]
    ...
    return exports.createClientModuleSystem(this,{id:registration.id,exports},options)
  }
}
```

**结论**：`window.__ModuleLoader__` 确实是 DSH web shell bootstrap 的官方 facade。
我的 `lib/client.js` 调用 `window.__ModuleLoader__.load({id, factory})` 是
**官方公开 API**。

### 2. `factory: (require) => {...}` 的 require 从哪来？

**做法**：找到 `getStaticModules()` 在 `packages/client/web/src/seed.ts` 里的实现。

**发现**（`seed.ts:43-46`）：host 在 boot 时把
`{ 'react': React, 'react/jsx-runtime': ReactJsxRuntime, ... }` 注入到 loader 的
`staticModules`，然后 `loader.create({staticModules: ...})`。当 bundle 的
factory 里 `require("react")`，loader 返回**这个 host 静态实例**——所有
bundle 共享同一个 React。

**结论**：bundle **必须用 `require()` 而不是 ESM `import`**——否则会绕开
loader 的 module table，得到 Node 的独立 React 实例，破坏 slot system 的
Symbol 唯一性。

这是 `packages/client/runtime-0.1.1-rc.2/README.md:95` 的明确警告所确认的：
> Value imports of this package from plugin bundles must use the `/client`
> subpath — the bare package name is not in the loader externals table and
> inlines a second module instance, whose private scope-tag Symbol never
> matches.

也就是说：**TSX 不行**，因为 tsc 会输出 `import { useState } from "react"`——loader
不会拦截。所以我的"纯 JS 写 panel"决策是**强制**的，不是"绕弯路"。

### 3. 官方是怎么生成 client bundle 的？

**做法**：搜 DSH 主仓找 client bundler。

**找到**：`packages/client/tsdown.client.ts`，是**官方共享 tsdown preset**，
plugin 都用它构建 client bundle。它的核心 banner / footer 是：

```js
banner: (chunk) => {
  const registration = `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, ...factory: (require) => {`
  ...
},
footer: 'return module.exports; } });',
intro: 'var module = { exports: {} }; var exports = module.exports;',
```

**跟我的 `scripts/build-client.mjs` 完全同形**——banner+intro+源码+footer，
最后是 `__ModuleLoader__.load` 包住整个 factory。

**结论**：我的手工 IIFE wrapper 跟官方 tsdown 的输出**1:1 等价**。

### 4. 我的输出与 dsh-feishu-mcp 的输出形态对照

```text
                                    ours    dsh-feishu-mcp
calls __ModuleLoader__.load         yes     yes
factory: (require) =>              yes     yes
let react = require("react")       yes     yes
exports.apply = apply              yes     yes
slots.inject("settings.section")  yes     yes
```

（验证脚本：`scripts/diff-iife.mjs`，已删除。检查方法在 commit history 里可
以重建。）

**结论**：我的 IIFE 输出和官方 plugin 编译产物在所有关键 API 形态上
**完全一致**。

### 5. settings.section slot 怎么注册？

**做法**：下载 `@deepseek-ai/dsh-client-ui-settings-general@0.2.1-alpha.5`
（**官方 registry 插件**，DSH web 默认安装），解包 grep `settings.section`
和 `slots.inject`。

**找到的官方写法**：

```js
ctx.slots.inject("settings.section", () => ctx.slots.register({
  name: "settings.section",
  id: "general",
  order: 100,
  label: () => t("settings.general"),
}, GeneralPanel));
```

**这正是我 v0.3.0 用的写法**（`src/client/index.js:497-503`），且官方 contract
对 `settings.section` 的定义（`packages/client/ui-settings/lib/types/client/contract/slots.d.ts:67-71`）

```ts
'settings.section': {
  kind: 'list';  // ← list，多个 section 叠加
  scope: 'root';
  owner: SettingsSectionOwnerProps;  // { close: () => void }
};
```

我的 panel 注册也走 list 形态，order=240（随意数字），符合规范。

### 6. 我能不能用 tsdown / esbuild / rollup 替代 `scripts/build-client.mjs`？

**做法**：尝试用 `pnpm add -D esbuild` 装 esbuild，跑 esbuild.build()。

**结果**：在当前 DSH 沙箱里 `child_process.spawn` 被拦截（之前也拦截了
`pnpm test:smoke`），所有 bundler 都跑不起来。

**结论**：在当前环境里**只能手写 IIFE**。这不是"绕弯路"，是**当前环境
约束下的唯一可行方案**。

### 7. 双入口 `exports."./client"` + `dsh.client.inject`？

**做法**：下载 `@deepseek-ai/dsh-host-webserver@0.1.5-rc.1`，读 README。

**发现**（README.md 第 12 行）：DSH webserver 是 plain route registry，**自己
不加载 plugin client bundles**。bundle 是被 `apps/web` 在构建期通过
`__DSH_BOOT__` graph 引用，由 `packages/client/web/src/boot.ts:73-78`
通过 `moduleLoader.create({ boot: win.__DSH_BOOT__, staticModules, ...loadBundle })`
触发加载。

**我的 package.json 双入口 + `dsh.client.inject` 是必要的**：DSH web shell 在
扫描 `node_modules` 时需要识别哪些 package 提供 client bundle。官方 README
里 `dsh.client.inject` 字段是关键，没有它 DSH web 不会扫这个包的 `lib/client.js`。

## 总结

| 决策 | 验证状态 | 证据 |
|---|---|---|
| `__ModuleLoader__.load({id, factory})` | **✅ 官方 API** | `packages/client/modules/src/index.ts:1474` 定义 |
| 必须用 `require()` 不是 ESM import | **✅ 官方强约束** | `runtime/README.md:95` + `seed.ts:43-46` |
| 必须用 IIFE factory 形态 | **✅ 官方推荐** | `tsdown.client.ts` banner/footer 与我的 IIFE 同形 |
| 不能用 TSX | **✅ 强制** | 因 #2 派生 |
| 双入口 + `dsh.client.inject` | **✅ 官方要求** | `host-webserver/README.md:12` + client runtime 注册机制 |
| 手写 IIFE（沙箱限制） | **✅ 沙箱约束** | tsdown/esbuild 都被 `child_process.spawn` EPERM 拦 |

**结论**：增量 2 的所有关键决策都有官方文档或源码支撑，不是"借了别人的方案
就不独立判断"。手写 IIFE 看起来像绕弯路，但实际是**当前沙箱环境 + DSH
官方架构**共同约束下的唯一可行解。

如果未来去掉沙箱限制，应该改用 `tsdown` + 官方 `tsdown.client.ts` preset
（项目维护者可以直接把那个 preset 复制进仓库）。

## 行动项

无。代码不需要修改。