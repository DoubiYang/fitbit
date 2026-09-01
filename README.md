# 节律

面向 Fitbit Air 用户的中文健康数据仪表盘与自助 AI 教练。

当前分支包含本地演示仪表盘、Google OAuth / 账户管理、真实健康数据同步，以及手机优先的餐食审阅与显式营养同步。授权成功后会立即为该用户回填最近 35 天的睡眠、HRV、静息心率、训练与心率相关数据；随后独立 worker 每分钟检查到期连接，每个用户每小时同步一次。每种数据类型都有独立 cursor、错误与退避：失败后依次在 30 分钟、1 小时、2 小时重试，之后回到每小时周期；单一类型失败不会阻塞其他成功类型的保存或同步。首页只读成功保存的本地快照，**不会**在打开页面时请求 Google。

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
5. `SYNC_SECRET` 可选：不填时应用仍可授权和同步，但 Compose `sync` worker 不会调度。填了则仅供 worker 调用内部入口，不能给浏览器或外部服务。
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

Google Cloud 还需：启用 Health API、Testing + Test users、[OAuth 设计](docs/superpowers/specs/2026-08-24-05-oauth-account-docker-design.md)中固定的 10 个 scope，以及授权网域 `doubiyang.com`。营养写入权限仅用于用户已本地保存后、再明确点击“同步这一餐”的餐食写回；保存或打开页面不会写入 Google Health。

- `https://doubiyang.com/rhythm`
- `https://doubiyang.com/rhythm/privacy`
- `https://doubiyang.com/rhythm/terms`

## 餐食审阅与显式同步

连接账户并开启营养写回后，打开仪表盘的“记录餐食”入口（或 `/rhythm/meals/new`）：选择一张照片并同意本次 AI 识别，审阅草稿；改食材或克数会重新计算该菜全部营养，直接改营养值只覆盖该一项。AI 只会返回可逐项应用的建议，不会自动修改餐食。

“保存修改”只保存这餐的最新本地值，**不**向 Google 创建任务或发送写请求。只有用户随后点击“同步这一餐”，才为当前这一餐创建异步写回任务。已同步餐食重新编辑后，再次显式同步会先删除旧的 Google point，删除完成后才创建新的 point；状态未知时只按原名称精确查询恢复，绝不重复 POST 写入。

照片预览只保留在当前浏览器页面内存。用户明确同意后，当前照片只会传给本次视觉识别请求；服务端不保存照片字节或 data URL。原始识别结果只在未保存草稿期短暂保留，保存后草稿会删除。已保存餐食只保留当前结构化菜品和营养值，不保留识别原始值、修正历史、AI 建议或聊天消息。餐食助手/AI 建议请求只含当前结构化餐食和本次问题，不含照片或 OAuth token。

## 校验

```bash
pnpm test
pnpm lint
pnpm build
```

自动化测试不需要 Postgres，也不读取真实 Google 密钥。
