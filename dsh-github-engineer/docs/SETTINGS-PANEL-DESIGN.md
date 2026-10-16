# Settings Web Panel — Implementation Design (v0.3.0) — DONE

> **Status: implemented**. The file below is the design record. See
> the v0.3.0 commit history for what actually shipped.

## Goal

Expose a Settings → GitHub Engineer tab in the DSH web UI. The tab
shows OAuth status and lets the user start/refresh/revoke without
going through the agent. Internally it calls the same loopback routes
that the agent tools do.

## What we have to do

The DSH web UI uses a "client bundle" pattern:

1. The **host** (`src/index.ts`, compiled to `lib/index.js`) runs in
   the DSH Node process. It registers tools + routes.
2. The **client** (a new `src/client/`, output to `lib/client.js`) runs
   in the user's browser. It registers a React tab into the settings
   page via `ctx.slots`.

Two separate compilation pipelines. The client bundle wraps itself in
`window.__ModuleLoader__.load({...})` so the DSH web loader can pull
it at runtime.

## Pipeline split

| Output | Source | Compiled by | Format |
|---|---|---|---|
| `lib/index.js` | `src/index.ts` (host) | `tsc -p tsconfig.build.json` | ESM |
| `lib/client.js` | `src/client/index.tsx` (panel) | `tsc -p tsconfig.client.json` | IIFE via `window.__ModuleLoader__.load(...)` |

We cannot use `tsdown` here (Node 24 + pnpm combo bug, see commit
history). Instead we hand-roll the IIFE wrapper in `src/client/index.tsx`:

```tsx
import { /* … */ } from "react";
import { GithubPanel } from "./GithubPanel.js";

// Pure module body. Then we wrap with __ModuleLoader__ below.
function apply(ctx: { slots: { inject; register } }) {
  ctx.slots.inject("settings.section", () =>
    ctx.slots.register(
      { id: "github-engineer", name: "settings.section", order: 240, label: () => "GitHub Engineer" },
      GithubPanel
    )
  );
}

const inject = ["slots"];
export { apply, inject };

// IIFE wrapper expected by the DSH web loader.
(globalThis as any).__ModuleLoader__.load({
  id: "dsh-github-engineer",
  factory: (require: (id: string) => any) => {
    // Re-bind React at runtime — the loader provides its own React copy.
    const react = require("react");
    const jsxRuntime = require("react/jsx-runtime");
    // Re-execute the panel factory in the loader's React context.
    const module = { exports: { apply, inject } };
    return module.exports;
  },
});
```

Wait — that's not quite right. The panel body uses `react.useState` etc.,
which need the loader's `react` (not the bundled one). So we have to
let the panel body run inside the factory, not at module-init time.

Looking at dsh-feishu-mcp's `lib/client.js` more carefully:

```js
window.__ModuleLoader__.load({
  id: "dsh-feishu-mcp",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    // ...
    let react = require("react");
    let react_jsx_runtime = require("react/jsx-runtime");

    // ↓↓↓ ALL THE PANEL CODE INSIDE THE FACTORY ↓↓↓
    function FeishuPanel() { ... uses react.useState ... }
    function apply(ctx) { ctx.slots.inject(...); }
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
```

So **the entire client bundle is one big factory body**. There is no
"import { useState } from 'react'" at module top — `react` is captured
from the loader's `require`.

This means we can't use TypeScript imports for `react` in
`src/client/index.tsx` — the imports would be hoisted to module-init
(outside the factory), where `react` is undefined.

The trick: define everything in plain JS-style code, and inside the
factory call `require("react")` ourselves. Then bundle that with
tsdown. But we said tsdown is broken.

## Alternative: write client.js by hand

Look at dsh-feishu-mcp: their `client.js` is **already a hand-rolled
IIFE**, not a tsdown output. The `clientBundle` preset in
`tsdown.client.ts` wraps the panel source in the IIFE — but the panel
code itself doesn't import `react` directly.

Looking more carefully:

- The src `client/index.ts` only does:
  ```ts
  export const inject = ["slots"];
  export function apply(ctx) { ... }
  ```
- The src `client/FeishuPanel.tsx` uses `react.useState`, etc.

How is the panel source compiled to one factory that pulls `react` from
the loader? Answer: **tsdown rewrites imports**. When bundling, tsdown
sees `import { useState } from "react"` and turns it into a
factory-internal `react.useState` reference (where `react = require("react")`).

So we need a similar rewrite. Two options:

### Option 1: Skip tsdown, hand-write the IIFE in JS

Pros: no bundler dependency, transparent, easy to debug.
Cons: no JSX support without transformation, ~250 lines of boilerplate.

### Option 2: Use a small bundler we already have

Pros: ESM → IIFE in one step.
Cons: we don't have a working bundler.

### Option 3: Pre-compile TSX → JS, then wrap in IIFE

1. `tsc` with `jsx: react-jsx` produces JS with `import { jsx } from "react/jsx-runtime"`.
2. Hand-roll a small Node script that:
   - Reads the compiled JS
   - Replaces `import` statements with `require` references
   - Wraps everything in `window.__ModuleLoader__.load({...})`

This is the dsh-feishu-mcp approach minus tsdown. We can do this with
~80 lines of Node + a `tsc --jsx react-jsx` step.

## Decision: Hand-roll the IIFE wrapper

Since we already have `tsc` working in Node 24 (verified by smoke
tests), we'll:

1. Write `src/client/index.tsx` with normal React imports.
2. `tsc` compiles to `client-build/index.jsx` (intermediate).
3. A Node script `scripts/build-client.mjs` rewrites imports into
   factory-internal `require` calls and wraps in IIFE. Output:
   `lib/client.js`.

This matches dsh-feishu-mcp's output shape exactly. We don't need
tsdown.

## Detailed plan

### Files to add

```
src/client/
├── api.ts            # Browser fetch wrapper around /api/github-engineer/*
├── GithubPanel.tsx   # The React panel component
└── index.tsx         # apply() + inject export

scripts/
└── build-client.mjs  # Post-process tsc output → IIFE

tsconfig.client.json  # tsc config for the client build
```

### Browser API surface

```ts
class GithubApi {
  getStatus(): Promise<StatusView>
  oauthStart(): Promise<{ ok; userCode; verificationUri; expiresAt; interval; error? }>
  oauthFinish(): Promise<{ ok; message }>
  oauthRefresh(): Promise<{ ok; message }>
  revoke(): Promise<{ ok; message }>
}
```

Each maps to a loopback route we already have (status / oauth/start /
oauth/finish / oauth/refresh / revoke).

### Panel layout

```
┌────────────────────────────────────────────────┐
│ GitHub Engineer                              │
│ 通过 OAuth Device Flow 连接 GitHub…    │  (hint)
│ ─────────────────────────────                 │
│ Auth: 未授权                                    │
│ ─────────────────────────────                 │
│ [Connect GitHub]  [Refresh]  [Revoke]         │
│ ─────────────────────────────                 │
│ user_code: ABCD-1234         [Copy]            │
│ verification_uri: github.com/login/device      │
│ ─────────────────────────────                 │
│ Last status message: …                         │
└────────────────────────────────────────────────┘
```

Same plain-JSX, inline-style approach as dsh-feishu-mcp's panel. No
external UI deps.

### tsconfig.client.json

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "outDir": "client-build",
    "rootDir": "src/client",
    "jsx": "react-jsx",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": []
  },
  "include": ["src/client/**/*"],
  "exclude": ["node_modules", "lib", "client-build", "mcp-server", "tests", "src/index.ts", "src/auth", "src/routes.ts", "src/agents-md-check.ts"]
}
```

### Build script

```js
// scripts/build-client.mjs
//
// Reads client-build/index.js and wraps it in
//   window.__ModuleLoader__.load({ id, factory })
// matching dsh-feishu-mcp's client.js format. The factory re-binds
// `react` and `react/jsx-runtime` from the DSH loader.
```

### package.json additions

```jsonc
{
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "build:client": "tsc -p tsconfig.client.json && node scripts/build-client.mjs",
    "build:all": "pnpm build && pnpm build:client"
  },
  "dsh": {
    "client": {
      "inject": [
        "@deepseek-ai/dsh-client-runtime",
        "@deepseek-ai/dsh-client-connection",
        "@deepseek-ai/dsh-client-ui-settings"
      ],
      "platform": "web"
    }
  },
  "peerDependencies": {
    "@deepseek-ai/dsh-client-connection": "...",
    "@deepseek-ai/dsh-client-ui-settings": "...",
    "react": "^18.2.0",
    "react-dom": "^18.2.0"
  }
}
```

## What this does NOT do

- **No emoji** — same as dsh-feishu-mcp.
- **No theme detection** — inline styles only.
- **No multi-step navigation** — single card.
- **No settings persisted in browser storage** — every reload fetches
  the loopback `/api/github-engineer/status` for fresh state.

## Test strategy

Smoke test:
1. Run `pnpm build:client` — should produce `lib/client.js`.
2. Grep for the expected exports (`apply`, `inject`) and the panel
   component name.
3. Manually verify the IIFE shape by reading `lib/client.js` head/tail.
4. The full UI smoke test happens in DSH; we can't simulate that
   headlessly.

## Risk

If our hand-rolled IIFE shape doesn't match what `__ModuleLoader__`
expects, the panel won't appear. Mitigation: cross-check against the
lib/client.js from dsh-feishu-mcp (which is verified to work).