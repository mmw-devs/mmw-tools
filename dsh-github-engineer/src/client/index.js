/**
 * dsh-github-engineer client entry — plain JavaScript.
 *
 * Why plain JS: the DSH web loader wraps this file in a factory like
 *
 *   window.__ModuleLoader__.load({
 *     id: "dsh-github-engineer",
 *     factory: (require) => {
 *       let react = require("react");
 *       let jsxRuntime = require("react/jsx-runtime");
 *       // ... our code ...
 *       exports.apply = apply;
 *       return module.exports;
 *     }
 *   });
 *
 * The factory provides React + jsx-runtime via require() — we close
 * over those references inside this module. Writing plain JS keeps
 * the runtime behavior transparent (no ESM/CJS interop, no React
 * duplicated by the build).
 *
 * `api.ts` is plain TS that doesn't touch React. It's compiled by tsc
 * into client-build/api.js, then concatenated into the IIFE by
 * scripts/build-client.mjs.
 */
import { githubApi, GithubApiError } from "./api.js";

/** Inline styles — kept tiny and theme-agnostic. */
const s = {
  card: {
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    maxWidth: "640px",
    padding: "14px 16px",
    borderRadius: "10px",
    border: "1px solid rgba(128,128,128,0.3)",
    fontSize: "13px",
    color: "inherit",
  },
  title: { fontWeight: 600, fontSize: "13px", margin: 0 },
  hint: { fontSize: "12px", opacity: 0.85, lineHeight: 1.5, margin: 0 },
  status: { fontSize: "12px", opacity: 0.85 },
  statusWarn: { fontSize: "12px", opacity: 0.9, color: "#c9763a" },
  statusErr: { fontSize: "12px", opacity: 0.9, color: "#c0392b" },
  statusOk: { fontSize: "12px", opacity: 0.9, color: "#2e8b57" },
  row: { display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" },
  label: { fontSize: "12px", opacity: 0.85, whiteSpace: "nowrap" },
  input: {
    flex: 1,
    minWidth: "180px",
    boxSizing: "border-box",
    padding: "5px 8px",
    borderRadius: "6px",
    border: "1px solid rgba(128,128,128,0.35)",
    background: "rgba(128,128,128,0.08)",
    color: "inherit",
    fontSize: "12px",
    fontFamily: "ui-monospace, SFMono-Regular, monospace",
  },
  button: {
    padding: "4px 10px",
    borderRadius: "6px",
    cursor: "pointer",
    border: "1px solid rgba(128,128,128,0.4)",
    background: "rgba(128,128,128,0.14)",
    color: "inherit",
    fontSize: "12px",
  },
  buttonPrimary: {
    padding: "5px 12px",
    borderRadius: "6px",
    cursor: "pointer",
    border: "1px solid rgba(60,120,200,0.6)",
    background: "rgba(60,120,200,0.18)",
    color: "inherit",
    fontSize: "12px",
    fontWeight: 600,
  },
  buttonDanger: {
    padding: "4px 10px",
    borderRadius: "6px",
    cursor: "pointer",
    border: "1px solid rgba(200,80,80,0.6)",
    background: "rgba(200,80,80,0.14)",
    color: "inherit",
    fontSize: "12px",
  },
  msg: {
    fontSize: "12px",
    whiteSpace: "pre-wrap",
    wordBreak: "break-all",
    opacity: 0.9,
    padding: "6px 8px",
    borderRadius: "6px",
    background: "rgba(128,128,128,0.08)",
  },
  block: {
    fontSize: "12px",
    padding: "8px 10px",
    borderRadius: "6px",
    background: "rgba(60,120,200,0.08)",
    border: "1px solid rgba(60,120,200,0.3)",
    wordBreak: "break-all",
  },
  disabled: { opacity: 0.5, cursor: "not-allowed" },
};

/** Format absolute Unix-ms as "Xh Ym" or "Y min" or "expired". */
function formatRemaining(timestampMs) {
  if (timestampMs <= 0) return "永不过期";
  const remaining = timestampMs - Date.now();
  if (remaining <= 0) return "已过期";
  const minutes = Math.floor(remaining / 60000);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes - hours * 60;
  return `${hours} 小时 ${mins} 分钟`;
}

/** Build the status line. */
function statusText(view) {
  if (view === null) return "加载中…";
  switch (view.status) {
    case "no_token":
      return `未授权 · 点击下方 [Connect GitHub] 发起 Device Flow`;
    case "device_pending":
      return `等待用户在浏览器完成授权（user_code 已展示在下方）`;
    case "authorized":
      return `已授权 · ${view.login || "(unknown)"} · scope: ${view.scope || "(none)"} · access_token ${formatRemaining(view.accessTokenExpiresAt)} 后过期`;
    case "reauth_needed":
      return `⚠️ access_token 失效 · 重新 [Connect GitHub]`;
  }
}

function statusStyle(view) {
  if (view === null) return s.status;
  switch (view.status) {
    case "authorized":
      return s.statusOk;
    case "device_pending":
      return s.statusWarn;
    case "reauth_needed":
      return s.statusErr;
    case "no_token":
      return s.status;
  }
}

/**
 * Build the React panel component. Called inside the IIFE factory with
 * the runtime provided by `__ModuleLoader__`.
 *
 * @param {object} runtime - { react, jsxRuntime }
 * @returns {Function} a React component
 */
function buildPanel(runtime) {
  // `react` / `react_jsx_runtime` are declared by the bundle wrapper in
  // this same scope (build-client.mjs: `let react = require("react")`).
  // The DSH client loader calls apply(ctx) with no options, so the
  // runtime is resolved from those locals — previously apply() insisted
  // on `opts.runtime` / `ctx.__githubEngineerRuntime`, threw, and the
  // catch below swallowed it: the panel never appeared and the only
  // trace was a console.warn.
  const resolved =
    runtime ??
    (typeof react !== "undefined" && react
      ? { react, jsxRuntime: typeof react_jsx_runtime !== "undefined" ? react_jsx_runtime : react }
      : null);
  if (!resolved) {
    throw new Error("react runtime unavailable in the client bundle scope");
  }
  const { useState, useEffect, useCallback } = resolved.react;
  const { jsx: _jsx, jsxs: _jsxs } = resolved.jsxRuntime;

  function GithubPanel() {
    const [viewState, setView] = useState(null);
    const [pending, setPending] = useState(null);
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState("");
    const [msgKind, setMsgKind] = useState("info");

    const refresh = useCallback(async () => {
      try {
        const v = await githubApi.getStatus();
        setView(v);
      } catch (err) {
        setMsg("读取状态失败: " + (err instanceof Error ? err.message : String(err)));
        setMsgKind("err");
      }
    }, []);

    useEffect(() => {
      void refresh();
    }, [refresh]);

    async function run(label, action) {
      setBusy(true);
      setMsg("");
      try {
        const result = await action();
        setMsg(result ?? label);
        setMsgKind("ok");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setMsg(`${label}: ${message}`);
        setMsgKind("err");
      } finally {
        setBusy(false);
      }
    }

    const startOauth = () => {
      void run("Connect GitHub", async () => {
        const result = await githubApi.oauthStart();
        if (!result.ok) {
          throw new GithubApiError(result.error ?? "未知错误");
        }
        if (!result.userCode || !result.verificationUri) {
          throw new GithubApiError("GitHub 响应缺少 userCode / verificationUri");
        }
        setPending(result);
        setMsg(
          `请在浏览器打开 ${result.verificationUri} 输 user_code ${result.userCode} 完成授权（5 分钟内）。`
        );
        setMsgKind("info");
      });
    };

    const finishOauth = () => {
      void run("OAuth 完成轮询", async () => {
        let attempts = 0;
        while (attempts < 60) {
          const result = await githubApi.oauthFinish();
          if (result.ok) {
            setPending(null);
            await refresh();
            return result.message;
          }
          await new Promise((r) => setTimeout(r, 2000));
          attempts += 1;
        }
        throw new GithubApiError("轮询超时（用户未在浏览器完成授权）");
      });
    };

    const refreshToken = () => {
      void run("Refresh", async () => {
        const result = await githubApi.oauthRefresh();
        if (!result.ok) {
          setMsgKind("err");
          throw new GithubApiError(result.message);
        }
        await refresh();
        return result.message;
      });
    };

    const revokeAll = () => {
      if (!window.confirm("确定要清空所有本地凭据？之后需要重新发起 Device Flow。")) return;
      void run("Revoke", async () => {
        const result = await githubApi.revoke();
        if (!result.ok) {
          setMsgKind("err");
          throw new GithubApiError(result.message);
        }
        setPending(null);
        await refresh();
        return result.message;
      });
    };

    const copyUserCode = () => {
      if (pending && pending.userCode) {
        const code = pending.userCode;
        void navigator.clipboard.writeText(code).then(
          () => {
            setMsg(`user_code 已复制到剪贴板: ${code}`);
            setMsgKind("info");
          },
          () => {
            setMsg("复制失败 — 请手动选中复制");
            setMsgKind("warn");
          }
        );
      }
    };

    const openVerificationUri = () => {
      if (pending && pending.verificationUri) {
        window.open(pending.verificationUri, "_blank", "noopener,noreferrer");
      }
    };

    const isAuthorized = viewState && viewState.status === "authorized";
    const isPending = viewState && viewState.status === "device_pending";
    const btn = busy ? Object.assign({}, s.button, s.disabled) : s.button;
    const btnPrimary = busy ? Object.assign({}, s.buttonPrimary, s.disabled) : s.buttonPrimary;
    const btnDanger = busy ? Object.assign({}, s.buttonDanger, s.disabled) : s.buttonDanger;

    const children = [
      _jsx("p", { style: s.title, children: "GitHub Engineer" }),
      _jsx("p", {
        style: s.hint,
        children:
          "通过 GitHub OAuth Device Flow 连接 GitHub。首次使用：点 Connect GitHub → 在浏览器打开 github.com/login/device → 输入 user_code 完成授权。Token 自动存到 ~/.dsh/dsh-github-engineer.json（mode 0600），access_token 8 小时、refresh_token 6 个月，到期自动续期。",
      }),
      _jsx("div", { style: statusStyle(viewState), children: statusText(viewState) }),
      _jsxs("div", {
        style: s.row,
        children: [
          _jsx("button", {
            type: "button",
            style: btnPrimary,
            disabled: busy,
            onClick: startOauth,
            children: isPending ? "重新获取 user_code" : "Connect GitHub",
          }),
          _jsx("button", {
            type: "button",
            style: btn,
            disabled: busy || !isAuthorized,
            onClick: refreshToken,
            children: "Refresh",
          }),
          _jsx("button", {
            type: "button",
            style: btnDanger,
            disabled: busy || !isAuthorized,
            onClick: revokeAll,
            children: "Revoke",
          }),
          _jsx("button", {
            type: "button",
            style: btn,
            disabled: busy || !isPending,
            onClick: finishOauth,
            title: "用户在浏览器完成授权后点这个",
            children: "我已完成授权",
          }),
        ],
      }),
    ];

    if (pending !== null) {
      children.push(
        _jsxs("div", {
          style: Object.assign({}, s.row, { marginTop: "2px" }),
          children: [
            _jsx("span", { style: s.label, children: "user_code:" }),
            _jsx("input", {
              style: s.input,
              readOnly: true,
              value: pending.userCode ?? "",
              onClick: copyUserCode,
              title: "点击复制",
            }),
            _jsx("button", {
              type: "button",
              style: btn,
              onClick: copyUserCode,
              children: "Copy",
            }),
            _jsx("button", {
              type: "button",
              style: btn,
              onClick: openVerificationUri,
              children: "Open github.com/login/device",
            }),
          ],
        })
      );
      children.push(
        _jsx("div", {
          style: s.block,
          children: `verification_uri: ${pending.verificationUri ?? ""}`,
        })
      );
    }

    if (msg !== "") {
      let styleObj = s.msg;
      if (msgKind === "err") styleObj = Object.assign({}, s.msg, { color: "#c0392b" });
      else if (msgKind === "warn") styleObj = Object.assign({}, s.msg, { color: "#c9763a" });
      else if (msgKind === "ok") styleObj = Object.assign({}, s.msg, { color: "#2e8b57" });
      children.push(_jsx("div", { style: styleObj, children: msg }));
    }

    return _jsx("div", { style: s.card, children });
  }

  return GithubPanel;
}

/** Required DSH client services. */
const inject = ["slots"];

/**
 * Register the GitHub Engineer settings panel.
 * Called by the DSH web UI loader.
 *
 * @param {object} ctx - DSH client context with `slots`.
 * @param {object} [opts] - internal options, esp. `{ runtime }` so we
 *   can pre-build the panel without depending on a closure passed
 *   through ctx.
 */
function apply(ctx, opts) {
  try {
    const runtime = (opts && opts.runtime) || (ctx && ctx.__githubEngineerRuntime) || null;
    const GithubPanel = buildPanel(runtime);
    ctx.slots.inject("settings.section", () =>
      ctx.slots.register(
        {
          id: "github-engineer",
          name: "settings.section",
          order: 240,
          label: () => "GitHub Engineer",
        },
        GithubPanel
      )
    );
  } catch (err) {
    console.error("[dsh-github-engineer] settings panel registration FAILED:", err);
    throw err;
  }
}

// Note: build-client.mjs rewrites the export below into CJS
// `exports.apply = apply; exports.inject = inject; exports.buildPanel
// = buildPanel;` before wrapping in the IIFE factory.
export { apply, inject, buildPanel };

// Side-effect import: ensures api.js is parsed into the bundle.
// eslint-disable-next-line no-unused-expressions
githubApi;