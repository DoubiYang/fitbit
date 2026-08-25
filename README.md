# 节律

面向 Fitbit Air 用户的中文健康数据仪表盘与自助 AI 教练。

当前分支包含本地演示仪表盘、Google OAuth / 账户管理，以及首次授权后的真实数据热同步。未配置密钥时仍是演示模式；配置完整后可在本机连接 Google Health。连接成功后，应用只会为**刚授权的用户**尝试同步最近 14 天的睡眠、HRV、静息心率和训练数据；首页只读成功保存的本地快照，**不会**在打开页面时请求 Google。当前没有全用户定时同步、历史回填、webhook、拍照记餐、营养写回或 AI Coach。

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
```

4. `DATABASE_URL` 在 Compose 里会改写为容器内的 `db` 主机，`.env.local` 里仍需要 `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB`。
5. 丢失 `TOKEN_ENCRYPTION_KEY` 且没有 `TOKEN_ENCRYPTION_KEY_PREVIOUS` 时，已保存的授权无法解密，必须重新连接。

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
