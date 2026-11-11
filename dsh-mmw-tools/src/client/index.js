/**
 * Settings panel — implementation of docs/PANEL-CONTRACT.md.
 *
 * The contract is the specification; this file is one rendering of it.
 * Two rules govern everything here:
 *
 *   1. At most two controls are visible at any time, and only the ones
 *      the action-by-state table permits. A control that would be inert
 *      must not be rendered — that was the original complaint.
 *   2. The user never confirms something the browser already reported.
 *      While `phase === "authorizing"` this component polls by itself.
 */

const inject = ["slots"];

const s = {
  root: { display: "flex", flexDirection: "column", gap: 8, fontSize: 13, lineHeight: 1.5 },
  title: { margin: 0, fontWeight: 600, fontSize: 14 },
  state: { margin: 0 },
  dim: { margin: 0, opacity: 0.7 },
  row: { display: "flex", gap: 8, flexWrap: "wrap" },
  button: {
    padding: "4px 12px",
    borderRadius: 6,
    border: "1px solid rgba(127,127,127,0.4)",
    background: "transparent",
    color: "inherit",
    cursor: "pointer",
    font: "inherit",
  },
  primary: {
    padding: "4px 12px",
    borderRadius: 6,
    border: "1px solid transparent",
    background: "#2f6feb",
    color: "#fff",
    cursor: "pointer",
    font: "inherit",
  },
  disabled: { opacity: 0.5, cursor: "default" },
  warn: { margin: 0, color: "#c26a00" },
  error: { margin: 0, color: "#c62828" },
};

function mmss(totalSeconds) {
  const secs = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(secs / 60);
  const rest = secs % 60;
  return `${m}:${String(rest).padStart(2, "0")}`;
}

function hoursMinutes(totalSeconds) {
  const secs = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** The one-line state sentence for each of the four phases (contract §6). */
function stateLine(view) {
  switch (view.phase) {
    case "authorizing":
      return `等待浏览器授权 · 剩余 ${mmss(view.session.secondsRemaining)}`;
    case "signed_in":
      return view.mode === "feishu"
        ? `已登录（飞书）· ${view.session.login || "飞书成员"} · 令牌剩余 ${hoursMinutes(view.session.secondsRemaining)}`
        : `已登录 · ${view.session.login} · 会话剩余 ${hoursMinutes(view.session.secondsRemaining)}`;
    case "expired":
      return "会话已过期，请重新登录";
    default:
      return "未登录";
  }
}

function buildPanel(runtime) {
  // `react` / `react_jsx_runtime` are declared by the bundle wrapper in
  // this same scope (build-client.mjs: `let react = require("react")`).
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

  return function MmwToolsPanel() {
    const [view, setView] = useState(null);
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState(null);
    const [msgKind, setMsgKind] = useState("info");

    const load = useCallback(async () => {
      try {
        const next = await githubApi.getStatus();
        setView(next);
        return next;
      } catch (err) {
        setMsg(`读取状态失败：${err.message}`);
        setMsgKind("error");
        return null;
      }
    }, []);

    useEffect(() => {
      void load();
    }, [load]);

    // §5.1: while authorizing, poll by ourselves. No confirm button exists.
    const phase = view && view.phase;
    useEffect(() => {
      if (phase !== "authorizing") return undefined;
      let stopped = false;
      const timer = setInterval(async () => {
        if (stopped) return;
        try {
          const result = await githubApi.oauthFinish();
          if (result.ok) {
            stopped = true;
            clearInterval(timer);
            setMsg("登录完成。");
            setMsgKind("info");
          }
          await load();
        } catch {
          /* keep polling until the deadline; the state line shows progress */
        }
      }, 2000);
      return () => {
        stopped = true;
        clearInterval(timer);
      };
    }, [phase, load]);

    const run = async (label, fn) => {
      setBusy(true);
      setMsg(null);
      try {
        await fn();
      } catch (err) {
        setMsg(`${label}失败：${err.message}`);
        setMsgKind("error");
      } finally {
        setBusy(false);
        await load();
      }
    };

    const signIn = () =>
      run("发起登录", async () => {
        const started = await githubApi.oauthStart();
        if (!started.verificationUri) throw new Error("broker 没有返回登录链接");
        window.open(started.verificationUri, "_blank", "noopener,noreferrer");
        setMsg("已在浏览器打开授权页，完成后这里会自动继续。");
        setMsgKind("info");
      });

    const cancel = () => run("取消", () => githubApi.revoke());
    const reacquire = () =>
      run("获取仓库权限", async () => {
        const r = await githubApi.oauthRefresh();
        if (!r.ok) throw new Error(r.message || "broker 拒绝了请求");
        setMsg("仓库权限已就绪。");
        setMsgKind("info");
      });
    const signOut = () => run("退出登录", () => githubApi.revoke());

    if (!view) {
      return _jsx("div", {
        style: s.root,
        children: _jsx("p", { style: s.dim, children: "读取状态…" }),
      });
    }

    const btn = busy ? Object.assign({}, s.button, s.disabled) : s.button;
    const btnPrimary = busy ? Object.assign({}, s.primary, s.disabled) : s.primary;

    // §4: the action-by-state table, expressed as data. Nothing outside it
    // is rendered, which is the whole point of having the table.
    const actions = [];
    if (view.phase === "signed_out" || view.phase === "expired") {
      actions.push(
        _jsx(
          "button",
          { type: "button", style: btnPrimary, disabled: busy, onClick: signIn, children: "登录 GitHub（可选）" },
          "in"
        )
      );
    } else if (view.phase === "authorizing") {
      actions.push(
        _jsx("button", { type: "button", style: btn, disabled: busy, onClick: cancel, children: "取消" }, "cancel")
      );
    } else if (view.phase === "signed_in") {
      // A Feishu identity has no GitHub session to refresh or revoke here;
      // its logout lives in the Feishu panel.
      if (view.mode !== "feishu" && view.repoAccess.state !== "ready") {
        actions.push(
          _jsx(
            "button",
            { type: "button", style: btnPrimary, disabled: busy, onClick: reacquire, children: "重新获取仓库权限" },
            "reacquire"
          )
        );
      }
      if (view.mode !== "feishu") {
        actions.push(
          _jsx("button", { type: "button", style: btn, disabled: busy, onClick: signOut, children: "退出登录" }, "out")
        );
      }
    }

    const children = [
      _jsx("p", { style: s.title, children: "MMW Tools" }, "t"),
      _jsx("p", { style: s.state, children: stateLine(view) }, "state"),
    ];

    if (view.phase === "authorizing") {
      children.push(
        _jsx("p", { style: s.dim, children: "请在浏览器完成授权，完成后会自动继续。" }, "hint")
      );
    }
    if (view.phase === "signed_out" || view.phase === "expired") {
      children.push(
        _jsx(
          "p",
          { style: s.dim, children: "优先在下方「飞书授权」登录；GitHub 账号不是必需的。" },
          "feishu-hint"
        )
      );
    }
    if (view.phase === "signed_in") {
      const ready = view.repoAccess.state === "ready";
      children.push(
        _jsx(
          "p",
          {
            style: ready ? s.dim : s.warn,
            children: ready ? "仓库权限：就绪" : `仓库权限：不可用 · ${view.repoAccess.reason}`,
          },
          "repo"
        )
      );
      if (view.mode === "feishu") {
        children.push(
          _jsx(
            "p",
            { style: s.dim, children: "当前使用飞书身份授权，不需要 GitHub 账号。" },
            "feishu-mode"
          )
        );
      }
    }
    if (msg) {
      children.push(_jsx("p", { style: msgKind === "error" ? s.error : s.dim, children: msg }, "msg"));
    }
    children.push(_jsx("div", { style: s.row, children: actions }, "actions"));

    return _jsx("div", { style: s.root, children });
  };
}

/**
 * Feishu authorization section. Kept separate from the GitHub panel so the
 * two credentials cannot be confused; both are registered into the same
 * settings slot.
 */
function buildFeishuPanel(runtime) {
  const resolved =
    runtime ??
    (typeof react !== "undefined" && react
      ? { react, jsxRuntime: typeof react_jsx_runtime !== "undefined" ? react_jsx_runtime : react }
      : null);
  if (!resolved) throw new Error("react runtime unavailable in the client bundle scope");
  const { useState, useEffect, useCallback } = resolved.react;
  const { jsx: _jsx } = resolved.jsxRuntime;

  return function FeishuPanel() {
    const [view, setView] = useState(null);
    const [pending, setPending] = useState(false);
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState(null);

    const load = useCallback(async () => {
      try {
        const next = await feishuApi.getStatus();
        setView(next);
      } catch (err) {
        setMsg(`读取飞书授权状态失败：${err.message}`);
      }
    }, []);

    useEffect(() => {
      void load();
    }, [load]);

    useEffect(() => {
      if (!pending) return undefined;
      let stopped = false;
      const timer = setInterval(async () => {
        if (stopped) return;
        try {
          const result = await feishuApi.loginPoll();
          if (result.ok) {
            stopped = true;
            clearInterval(timer);
            setPending(false);
            setMsg("飞书登录完成。");
            await load();
          } else if (result.status === "denied" || result.status === "expired" || result.status === "error") {
            stopped = true;
            clearInterval(timer);
            setPending(false);
            setMsg(result.reason || result.error || "登录未完成");
          }
        } catch {
          /* keep polling; the user may still be in the browser */
        }
      }, 2000);
      return () => {
        stopped = true;
        clearInterval(timer);
      };
    }, [pending, load]);

    const start = async () => {
      setBusy(true);
      setMsg(null);
      try {
        const started = await feishuApi.loginStart();
        if (!started.ok || !started.loginUrl) throw new Error(started.error || "没有返回登录链接");
        window.open(started.loginUrl, "_blank", "noopener,noreferrer");
        setPending(true);
        setMsg("已打开飞书授权页，完成后这里会自动继续。");
      } catch (err) {
        setMsg(`发起飞书登录失败：${err.message}`);
      } finally {
        setBusy(false);
      }
    };

    const logout = async () => {
      setBusy(true);
      try {
        await feishuApi.logout();
        setMsg("飞书授权已清空。");
        await load();
      } catch (err) {
        setMsg(`退出失败：${err.message}`);
      } finally {
        setBusy(false);
      }
    };

    if (!view) return _jsx("p", { style: s.dim, children: "读取飞书授权状态…" });

    const children = [_jsx("p", { style: s.title, children: "MMW Tools 授权" }, "t")];
    if (view.signedIn) {
      children.push(
        _jsx("p", { style: s.state, children: `已登录 · ${view.member?.name || ""}` }, "who"),
        _jsx("p", { style: s.dim, children: `角色：${view.roles?.length ? view.roles.join(", ") : "(无)"}` }, "roles"),
        _jsx(
          "p",
          { style: s.dim, children: `授权服务：${view.authServiceUrl} · 剩余 ${Math.ceil(view.secondsRemaining / 60)} 分钟` },
          "svc"
        )
      );
    } else {
      children.push(
        _jsx("p", { style: s.state, children: "未登录飞书" }, "who"),
        _jsx("p", { style: s.dim, children: "登录后插件会按你的角色放行或拒绝工具调用。" }, "hint")
      );
    }
    if (msg) children.push(_jsx("p", { style: s.dim, children: msg }, "msg"));

    const actions = [];
    if (view.signedIn) {
      actions.push(
        _jsx("button", { type: "button", style: busy ? s.disabled : s.button, disabled: busy, onClick: logout, children: "退出飞书" }, "out")
      );
    } else {
      actions.push(
        _jsx(
          "button",
          { type: "button", style: busy || pending ? s.disabled : s.primary, disabled: busy || pending, onClick: start, children: pending ? "等待浏览器授权…" : "使用飞书登录" },
          "in"
        )
      );
    }
    children.push(_jsx("div", { style: s.row, children: actions }, "actions"));
    return _jsx("div", { style: s.root, children });
  };
}

/**
 * Register the panel. React comes from the bundle wrapper's scope
 * (build-client.mjs requires it and inlines this file beside it).
 */
function apply(ctx, opts) {
  try {
    const runtime = (opts && opts.runtime) || (ctx && ctx.__mmwToolsRuntime) || null;
    const GithubPanel = buildPanel(runtime);
    const FeishuPanel = buildFeishuPanel(runtime);
    ctx.slots.inject("settings.section", () =>
      ctx.slots.register(
        {
          name: "settings.section",
          id: "mmw-tools",
          order: 240,
          label: () => "MMW Tools",
        },
        GithubPanel
      )
    );
    ctx.slots.inject("settings.section", () =>
      ctx.slots.register(
        {
          name: "settings.section",
          id: "mmw-tools-feishu",
          order: 241,
          label: () => "MMW Tools 授权",
        },
        FeishuPanel
      )
    );
    console.info("[dsh-mmw-tools] client apply ok — settings sections registered");
  } catch (err) {
    console.error("[dsh-mmw-tools] settings panel registration FAILED:", err);
    throw err;
  }
}

const name = "dsh-mmw-tools";

export { apply, inject, buildPanel, buildFeishuPanel, name };
