/**
 * Settings panel — one section, one credential.
 *
 * MMW Tools has exactly one user-facing login: Feishu. The broker owns the
 * GitHub App identity and mints repository tokens after verifying the Feishu
 * role, so there is no second GitHub login UI to render.
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
};

function formatRemaining(totalSeconds) {
  const secs = Math.max(0, Math.floor(totalSeconds));
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d > 0) return `${d} 天 ${h} 小时`;
  if (h > 0) return `${h} 小时 ${m} 分钟`;
  return `${m} 分钟`;
}

function buildFeishuPanel(runtime) {
  const resolved =
    runtime ??
    (typeof react !== "undefined" && react
      ? { react, jsxRuntime: typeof react_jsx_runtime !== "undefined" ? react_jsx_runtime : react }
      : null);
  if (!resolved) throw new Error("react runtime unavailable in the client bundle scope");
  const { useState, useEffect, useCallback } = resolved.react;
  const { jsx: _jsx } = resolved.jsxRuntime;

  return function MmwToolsPanel() {
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

    const children = [_jsx("p", { style: s.title, children: "MMW Tools" }, "t")];
    if (view.signedIn) {
      children.push(
        _jsx("p", { style: s.state, children: `已登录（飞书）· ${view.member?.name || ""}` }, "who"),
        _jsx("p", { style: s.dim, children: `角色：${view.roles?.length ? view.roles.join(", ") : "(无)"}` }, "roles"),
        _jsx(
          "p",
          { style: s.dim, children: `授权服务：${view.authServiceUrl} · 剩余 ${formatRemaining(view.secondsRemaining)}` },
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
    const Panel = buildFeishuPanel(runtime);
    ctx.slots.inject("settings.section", () =>
      ctx.slots.register(
        {
          name: "settings.section",
          id: "mmw-tools",
          order: 240,
          label: () => "MMW Tools",
        },
        Panel
      )
    );
    console.info("[dsh-mmw-tools] client apply ok — settings section registered");
  } catch (err) {
    console.error("[dsh-mmw-tools] settings panel registration FAILED:", err);
    throw err;
  }
}

const name = "dsh-mmw-tools";

export { apply, inject, buildFeishuPanel, name };
