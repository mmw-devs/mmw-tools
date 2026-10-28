# Publishing `dsh-github-engineer`

Two distribution channels. They differ in one important way: **whether the build output is present in the repository.**

| Channel | Command | Needs `lib/` committed? |
|---|---|---|
| npm | `dsh plugin --profile web add dsh-github-engineer` | No — `prepublishOnly` builds before packing |
| git | `dsh plugin --profile web add "git+https://github.com/mmw-devs/mmw-tools.git#path:/dsh-github-engineer"` | **Yes** — `dsh plugin add` does not run a build |
| source | `dsh plugin --profile web add file:/abs/path/to/dsh-github-engineer` | No — you build first |

`dsh plugin add` installs a package and mounts its `dsh.bundle`; it never runs a build step. So a git install only works if the artifacts the manifest points at already exist in the tree:

- `lib/index.js` — the host bundle (`main`)
- `lib/client.js` — the settings panel (`exports["./client"]`)
- `mcp-server/dist/index.js` — the spawned MCP server

Both `lib/` and `mcp-server/dist/` are listed in `.gitignore`, but that is
not the same as absent: **the files are already tracked** (13 under `lib/`,
11 under `mcp-server/dist/` at the time of writing), and gitignore never
applies to tracked paths. So git install does work as the tree stands —
0.8.1 was verified to ship `mcp-server/dist/guard.js` with the current
limit.

The trap is the other direction: `git add` silently skips a *newly
generated* file under an ignored directory, so a build that emits a new
module needs `git add -f`. Rebuild and commit the output in the same
commit as the source change, always.

To refresh an existing install after a new commit lands on `main`, re-run
the same add command; `dsh plugin add` re-resolves the branch head. The
spawned MCP server is created at plugin load, so the app has to restart
before a new `mcp-server/dist` takes effect.

## Choosing

**Ship on npm only** (recommended while the plugin is `0.x`):

- Nothing generated enters git.
- One command for users.
- `prepublishOnly` guarantees the tarball matches the source.

**Also support git install** — already true, since 0.8.x:

1. `lib/` and `mcp-server/dist/` stay tracked even though both are in `.gitignore`; leave them tracked.
2. Run `pnpm build:all` and `pnpm --filter dsh-github-engineer-mcp build`.
3. Commit the output together with the source change that produced it, in the same commit. A source-only commit leaves the published artifact stale, which is worse than either extreme. A newly emitted file needs `git add -f` because of the ignore rule.

The cost is that every source change now touches generated files. Do not mix the two: if `lib/` is committed, it must be regenerated in every commit that changes `src/`.

## Use `file:`, not `link:`

`dsh plugin add link:<dir>` symlinks the package and tells pnpm **not**
to resolve the package's peer dependencies. The host bundle still loads,
which is why the mistake is easy to miss — but the browser-side module
is listed in the boot payload and then never served, so the Settings
panel silently does not appear.

`file:<dir>` resolves peers against the profile and serves the client
module correctly. Use it for every local install, including the T5
runbook.

## Why `.npmignore` exists

npm falls back to `.gitignore` when a package has no `.npmignore`, and
this package's `.gitignore` excludes `lib/`. Left alone, `npm publish`
would produce a tarball without `lib/index.js` — the plugin would
install, mount nothing, and appear broken.

`.npmignore` lists the same exclusions *except* `lib/`, which reopens
the artifact for packing. `pnpm check:pack` asserts the outcome
offline. Do not delete either file without re-running that check.

## Release checklist

```sh
cd dsh-github-engineer

# 1. Bump the version in package.json and add a CHANGELOG section.
#    Also update version in this list when you tag.

# 2. Clean build from scratch — a stale dist in the tree is the most
#    common cause of "works here, fails for users".
rm -rf lib client-build mcp-server/dist
pnpm --filter dsh-github-engineer-mcp build
pnpm build:all

# 3. Verify.
pnpm check
(cd mcp-server && pnpm test)

# 4. Confirm the tarball contains what the manifest promises.
pnpm check:pack
#    Offline equivalent of `npm pack --dry-run`: applies `files` plus
#    `.npmignore` and asserts that lib/index.js, lib/client.js,
#    mcp-server/dist/index.js, cordis.patch.yml, LICENSE, README.md,
#    and CHANGELOG.md are present while src/, tests/, and
#    client-build/ are not. Run it from a machine that can write to
#    the npm cache if you additionally want npm's own opinion
#    (`npm pack --dry-run`).

# 5. Tag and push.
git add -A
git commit -m "Release v$(node -p "require('./package.json').version")"
git tag "v$(node -p "require('./package.json').version")"
git push && git push --tags
```

### To publish on npm

`package.json` currently sets `"private": true`, which blocks publishing. Flip it in the release commit:

```sh
# 1. Set "private": false (or delete the field).
# 2. Confirm the name is free.
npm view dsh-github-engineer version
# 3. Publish. prepublishOnly runs `pnpm build:all` first.
npm publish --access public
```

Keep `"private": true` between releases. It is the cheapest guard against publishing a half-built tree by accident, and it does not affect `pnpm install`, `link:` installs, or `npm pack --dry-run`.

### To publish to `awesome-dsh-plugin`

The list is a curated README; an entry is a single markdown line plus a `dsh-plugin` GitHub topic on the repository.

1. Add the repository topic: `gh repo edit mmw-devs/mmw-tools --add-topic dsh-plugin`
2. Open a PR against [`awesome-dsh-plugin/awesome-dsh-plugin`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) adding one line under the matching category — **Identity & Communication** for the repository-operation plugins, or **GitOps & Code Review** if you consider it a code-review tool. The line format is:

   ```markdown
   - [mmw-devs/mmw-tools](https://github.com/mmw-devs/mmw-tools) - Single-repository GitHub engineer for DeepSeek Harness: reads the repository's AGENTS.md, edits only allowlisted paths, runs a pre-flight check before every commit, and opens a draft PR on a `content/*` branch. OAuth Device Flow, no auto-merge.
   ```

3. Every claim in that line is checked against the source before merge — "edits only allowlisted paths" and "no auto-merge" are both literally true here (the merge tool does not exist).

## After release

- Install from a clean profile and confirm the panel appears: `dsh plugin --profile web add …` → restart `dsh web` → **Settings → GitHub Engineer**.
- Confirm `engineer_status` reports the expected binding in a fresh conversation.
- Watch for the first audit file at `~/.dsh/dsh-github-engineer-audit.jsonl` after one `engineer_run`.
