# mmw-tools-auth 部署

目标主机：`106.54.44.57`（腾讯云，Ubuntu 24.04，Node 24 在 `/usr/local/bin/node`）。
主机名：`mmw-tools.mmw-team.icu`。

> 现有站点 `mmw-team.icu` 和 `race-ops-broker.mmw-team.icu` 不要改动。

## 1. DNS

DNSPod 添加：

```text
主机记录：mmw-tools
类型：A
值：106.54.44.57
TTL：600
```

验证：

```sh
curl -s 'https://dns.alidns.com/resolve?name=mmw-tools.mmw-team.icu&type=A'
```

## 2. 代码与契约

在本地仓库根目录打包（不要把本地 `.env` 带上去）：

```sh
tar czf /tmp/mmw-tools-auth.tgz \
  --exclude='mmw-tools-auth/.env' \
  --exclude='mmw-tools-auth/data' \
  mmw-tools-auth contracts

scp -i <key> /tmp/mmw-tools-auth.tgz ubuntu@106.54.44.57:/tmp/
scp -i <key> mmw-tools-auth/.env ubuntu@106.54.44.57:/tmp/mmw-tools-auth.env
```

服务器上：

```sh
sudo mkdir -p /opt/mmw-tools-auth
sudo tar xzf /tmp/mmw-tools-auth.tgz -C /opt
sudo mv /opt/contracts /opt/mmw-tools-auth/contracts
sudo cp /tmp/mmw-tools-auth.env /opt/mmw-tools-auth/.env
```

`/opt/mmw-tools-auth/.env` 至少要有：

```dotenv
FEISHU_APP_ID=...
FEISHU_APP_SECRET=...
FEISHU_TENANT_KEY=...
MMW_ORIGIN=https://mmw-tools.mmw-team.icu
MMW_PORT=4326
MMW_DATA_DIR=./data
MMW_CONTRACTS_DIR=./contracts
```

`MMW_CONTRACTS_DIR` 必须是 `./contracts`，不是仓库里的 `../contracts`。

## 3. systemd

```sh
sudo bash /tmp/server-install.sh
```

脚本会：

- 从 `/opt/mmw-review-system/.env.local` 复用同一个飞书组织的 `FEISHU_TENANT_KEY`；
- 创建 `/opt/mmw-tools-auth/data`（`ubuntu:ubuntu`，0700）；
- 安装 `/etc/systemd/system/mmw-tools-auth.service`；
- `systemctl enable --now mmw-tools-auth`；
- 检查 `http://127.0.0.1:4326/health`。

服务只监听回环，公网由 nginx 终止 TLS。

## 3.1 运维层：备份、健康检查、日志上限

`server-install.sh` 只负责把服务跑起来。再执行一次运维层安装（可重复执行）：

```sh
sudo bash /opt/mmw-tools-auth/deploy/install-ops.sh
```

它会：

- 安装 `/usr/local/lib/mmw-tools-auth/{backup,restore}.mjs` 和
  `/usr/local/sbin/mmw-auth-healthcheck`；
- 创建 `/var/backups/mmw-tools-auth`（`ubuntu:ubuntu`，0700）；
- 启用每日 03:20 的 SQLite 快照 timer（保留 7 份，带随机延迟）；
- 启用每 2 分钟的健康探测 timer；连续 3 次失败才重启服务；
- 安装 journald 容量 drop-in（`SystemMaxUse=200M`），避免日志占满 40GB 磁盘；
- 立即做一次快照并跑一次健康探测，失败则安装报错。

安装后检查：

```sh
systemctl list-timers 'mmw-tools-auth-*'
journalctl -u mmw-tools-auth-healthcheck -n 20 --no-pager
ls -lh /var/backups/mmw-tools-auth
```

## 4. 证书

```sh
sudo bash /tmp/issue-cert.sh
```

复用现有 acme.sh + `dns_tencent` + `/etc/acme/tencent.env`：

- 证书：`/etc/nginx/ssl/mmw-tools/fullchain.pem`
- 私钥：`/etc/nginx/ssl/mmw-tools/privkey.pem`
- 续期由 root 的 acme.sh cron 处理；`--reloadcmd "systemctl reload nginx"` 已注册。

> 首次签发使用 acme.sh 默认 CA（当前为 ZeroSSL）。证书 SAN 是
> `mmw-tools.mmw-team.icu`，有效期至 2027-02-01。

## 5. nginx

```sh
sudo cp /tmp/nginx-mmw-tools.conf /etc/nginx/sites-available/mmw-tools
sudo ln -sfn /etc/nginx/sites-available/mmw-tools /etc/nginx/sites-enabled/mmw-tools
sudo nginx -t
sudo systemctl reload nginx
```

配置要点：

- `server_name mmw-tools.mmw-team.icu;`
- `proxy_pass http://127.0.0.1:4326;`
- `access_log ... mmw_tools_noquery;`：不记录 `?secret=`、`?code=`、`?state=`；
- 80 → 301 HTTPS。

## 6. 首位管理员

```sh
sudo bash /tmp/set-bootstrap.sh
```

脚本会生成一次性 bootstrap token，并写入：

```text
/root/mmw-tools-bootstrap-url.txt
```

用你的飞书账号打开该 URL。**必须打开这个带 `?bootstrap=` 的地址**；从 `/`
页面点普通「使用飞书登录」不会触发 bootstrap，只会创建无角色成员。回调成功后
你成为首位管理员；之后从 `/opt/mmw-tools-auth/.env` 删除
`MMW_BOOTSTRAP_TOKEN` 并重启：

```sh
sudo systemctl restart mmw-tools-auth
sudo rm -f /root/mmw-tools-bootstrap*.txt
```

## 7. 验证

```sh
curl https://mmw-tools.mmw-team.icu/health
# {"ok":true,"contractVersion":2,"catalogRevision":"sha256:..."}

curl -s -o /dev/null -w '%{http_code}\n' https://mmw-tools.mmw-team.icu/api/me
# 401

curl -s -o /dev/null -w '%{http_code}\n' https://mmw-tools.mmw-team.icu/v1/agent/routes
# 401
```

`/auth/feishu/start` 的跳转必须包含：

```text
client_id=cli_aa685b6b70f89d2e
redirect_uri=https://mmw-tools.mmw-team.icu/auth/feishu/callback
```

如果跳转里出现别的 `client_id`，说明请求没有到 auth core，而是落到了主站。

## 8. 故障排查

- `curl http://127.0.0.1:4326/health` 失败：`systemctl status mmw-tools-auth`、`journalctl -u mmw-tools-auth -n 50`。
- SQLite `unable to open database file`：确认 `/opt/mmw-tools-auth/data` 是 `ubuntu:ubuntu` 0700；改完后 `systemctl reset-failed && systemctl restart`。
- 公网 `/health` 返回 `{"status":"ok"}`：请求到了主站，检查 DNS、`server_name`、证书 SAN。
- 浏览器 TLS 报 `SEC_E_WRONG_PRINCIPAL`：证书不包含子域名，检查 `fullchain.pem` 的 SAN。
- Feishu 回调报 `redirect_uri` 不匹配：检查飞书后台重定向 URL 与 `.env` 的 `MMW_ORIGIN` 是否完全一致。

## 9. 2GB 主机的资源预算

下面的数字是**上限预算**，不是实测值。部署后用
`systemctl show -p MemoryCurrent mmw-tools-auth`、`free -m`、`df -h` 校准。

| 项目 | 预算 | 控制手段 |
|---|---|---|
| 系统、sshd、云厂商 agent | 350 MiB | 不跑 Docker/Postgres/Redis |
| nginx | 30 MiB | 单 worker 配置（发行版默认） |
| `mmw-tools-auth` 常驻 | 96 MiB 工作集 | `MemoryHigh=192M`、`MemoryMax=256M`、Node heap 上限 160 MiB |
| SQLite + 页缓存 | 32 MiB | 单进程、小库；不使用独立数据库服务 |
| 备份进程（瞬时） | 48 MiB | 每日一次，结束后退出 |
| 余量 | ≈ 1.0 GiB | 留给内核页缓存和突发流量 |

磁盘：应用代码很小，SQLite 库通常在几 MiB 量级；7 份快照、200 MiB journal
上限、证书和 nginx 日志都在 40GB 内留出大量余量。`/var/backups/mmw-tools-auth`
目前只在本机，磁盘损坏会同时丢库和快照；需要异地副本时用 `rsync`/对象存储，
不要为此在这台机器上常驻一个新服务。

Docker、Postgres、Redis 在 2GB 预算下都没有明确收益：auth core 是单进程、
单写者，SQLite 已经覆盖事务和持久化；引入容器运行时只会增加常驻内存和升级面。

## 10. 备份与恢复

快照使用 SQLite 的 backup API，写入临时文件后做 `PRAGMA integrity_check`，
通过后才改名到最终文件；失败不会覆盖旧快照。

```sh
# 手动快照（timer 之外）
sudo /usr/local/bin/node /usr/local/lib/mmw-tools-auth/backup.mjs \
  --data-dir /opt/mmw-tools-auth/data \
  --out-dir /var/backups/mmw-tools-auth \
  --keep 7

# 查看
ls -lh /var/backups/mmw-tools-auth
```

恢复必须先停服务，避免在进程仍持有旧文件时替换数据库：

```sh
sudo systemctl stop mmw-tools-auth
sudo /usr/local/bin/node /usr/local/lib/mmw-tools-auth/restore.mjs \
  --backup /var/backups/mmw-tools-auth/auth-YYYYMMDDTHHMMSSmmmZ.sqlite \
  --data-dir /opt/mmw-tools-auth/data
sudo systemctl start mmw-tools-auth
curl -fsS http://127.0.0.1:4326/health
```

`restore.mjs` 会先校验快照，再把当前库复制为
`auth.sqlite.before-restore-<timestamp>`；恢复错了可以用这个文件再恢复回去。
恢复后用管理员页面确认成员数量和角色，再观察一次登录流程。

## 11. 回滚

部署前先留一份代码快照（不含 `.env` 和 `data`）：

```sh
sudo tar czf "/var/backups/mmw-tools-auth/app-$(date +%Y%m%dT%H%M%S).tgz" \
  -C /opt/mmw-tools-auth --exclude=data --exclude=.env .
```

回滚代码：

```sh
sudo systemctl stop mmw-tools-auth
sudo tar xzf /var/backups/mmw-tools-auth/app-<timestamp>.tgz -C /opt/mmw-tools-auth
sudo bash /opt/mmw-tools-auth/deploy/server-install.sh
```

如果新版本改过数据库结构，代码回滚之外还要恢复部署前的数据库快照（第 10 节）。
回滚后验证：`/health` 正常、`/api/me` 与 `/v1/agent/routes` 未登录返回 401、
管理员能登录、route table 与 `contracts/REFERENCE.md` 一致。

nginx 配置改动前先 `cp` 一份到同目录 `.bak`；回滚时覆盖回去、`nginx -t` 通过后
再 `systemctl reload nginx`。不要回滚证书文件本身。

## 12. 尚未自动化的部分

- 快照没有异地副本；需要另配 `rsync` 或对象存储。
- 没有蓝绿/多实例；SQLite 单进程是刻意选择。
- 快照/恢复脚本已在本地验证快照、完整性校验、保留数量和恢复流程；systemd、
  nginx、证书切换只能在目标主机验证，首次执行时按第 3.1、10、11 节逐条确认。
