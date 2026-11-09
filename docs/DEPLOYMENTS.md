# Deployments

Status: historical, append-only. Each entry records what was true on that host at
that time. For the current state, read `/health` and `systemctl status`; for the
procedure, read [`mmw-tools-auth/deploy/README.md`](../mmw-tools-auth/deploy/README.md).

## 2026-11-10 — operation role ladder and the ops timers

- Commit: `1114b56` (`feat(contracts): give each race-ops operation a role range`).
- Target: `ubuntu@106.54.44.57`, `/opt/mmw-tools-auth`, Ubuntu 24.04, Node 24.22.1.
- Contract: `catalogRevision` moved from
  `sha256:91d56de8…` to `sha256:ab395698…`; `/health` served the new value.
- Before touching code: tarred `/opt/mmw-tools-auth` to
  `/var/backups/mmw-tools-auth/code-before-20261109T193216Z.tgz`, and took an
  online SQLite snapshot with `deploy/backup.mjs`.
- Deployed the `git archive` of the commit, keeping `.env` and `data/` in place;
  `server-install.sh` rewrote the unit (192M high / 256M max, 128 tasks) and the
  service came up with zero restarts.
- Installed `deploy/install-ops.sh`: daily snapshot timer, two-minute health
  probe, journald cap. The install ran one snapshot and one successful probe.
- Verified: public `/health` over HTTPS, unauthenticated `/v1/agent/routes` and
  `/api/me` both 401, restore of the snapshot into a scratch directory, and the
  previous code snapshot booting on a spare port with the old revision.
- Rollback: stop the service, restore the code tar, restore the SQLite snapshot
  with `restore.mjs`, start and check the journal. The tar and snapshots above
  are the concrete inputs.
