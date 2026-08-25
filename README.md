# 节律

面向 Fitbit Air 用户的中文健康数据仪表盘与自助 AI 教练。

当前分支包含本地演示仪表盘、Google OAuth / 账户管理，以及真实数据同步。授权成功后会立即为该用户同步最近 14 天的睡眠、HRV、静息心率和训练；随后独立 worker 每分钟检查到期连接，每个用户在上次成功后 6 小时再次同步。失败会在 30 分钟、1 小时、2 小时后重试，之后回到 6 小时周期。首页只读成功保存的本地快照，**不会**在打开页面时请求 Google。当前没有历史回填、webhook、拍照记餐、营养写回或 AI Coach。

## 本地演示

需要 Node.js 25 与 pnpm 11。不填 Google / 数据库密钥时：

```bash
pnpm install --frozen-lockfile
pnpm dev
```

打开 `http://localhost:3000/rhythm`。演示只使用服务器固定的 `demo_user`。

## Google OAuth 与 Docker

1. 复制 `.env.example` 为 `.env.local`（不要提交）。
2. 填入 Google OAuth Web client 的 `GOOGLE_HEALTH_CLIENT_ID` / `GOOGLE_HEALTH_CLIENT_SECRET`。
3. 生成本地密钥，不要复用示例值：

```bash
openssl rand -base64 32   # TOKEN_ENCRYPTION_KEY
openssl rand -hex 16      # POSTGRES_PASSWORD
openssl rand -hex 32      # SYNC_SECRET
```

4. `DATABASE_URL` 在 Compose 里会改写为容器内的 `db` 主机，`.env.local` 里仍需要 `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB`。
5. `SYNC_SECRET` 仅供 Compose 内的 `sync` worker 调用内部入口，不能给浏览器或外部服务。
6. 丢失 `TOKEN_ENCRYPTION_KEY` 且没有 `TOKEN_ENCRYPTION_KEY_PREVIOUS` 时，已保存的授权无法解密，必须重新连接。

```bash
docker compose --env-file .env.local up --build
```

然后只使用：

```
http://localhost:3000/rhythm
http://localhost:3000/rhythm/account
```

不要用 `http://127.0.0.1:3000`。本地 callback 必须是 `http://localhost:3000/rhythm/api/auth/google/callback`。

Google Cloud 还需：启用 Health API、Testing + Test users、[OAuth 设计](docs/superpowers/specs/2026-08-24-05-oauth-account-docker-design.md)中固定的 10 个 scope，以及授权网域 `doubiyang.com`。其中营养写入权限只为后续已确认餐食的写回预先授权；当前代码不会写入 Google Health。

- `https://doubiyang.com/rhythm`
- `https://doubiyang.com/rhythm/privacy`
- `https://doubiyang.com/rhythm/terms`

## 校验

```bash
pnpm test
pnpm lint
pnpm build
```

自动化测试不需要 Postgres，也不读取真实 Google 密钥。
