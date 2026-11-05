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
