# health.doubiyang.com 部署

目录：`/home/ubuntu/fitbit`。服务通过 `docker compose -f deploy/compose.yml` 管理，使用独立 PostgreSQL 数据目录及 OAuth 状态卷。

- MCP：`https://health.doubiyang.com/mcp`
- Google 登录/重新授权：`https://health.doubiyang.com/rhythm/account`
- Google OAuth 回调：`https://health.doubiyang.com/rhythm/api/auth/google/callback`

## 用户配置

在 Google Cloud 原 OAuth Web 客户端中新增：

1. 已获授权的 JavaScript 来源：`https://health.doubiyang.com`
2. 已获授权的重定向 URI：`https://health.doubiyang.com/rhythm/api/auth/google/callback`

原有本地和线上配置继续保留。然后打开账户页，以原 Google 账户登录并重新授权。迁移时的 Google refresh token 已过期，历史数据可查；恢复最新数据同步需要此步骤。

Codex 设置 → MCP servers → Add server，名称可填 `rhythm-health`，类型选择 Streamable HTTP，URL 填 `https://health.doubiyang.com/mcp`。保存、重启该连接并点击 Authenticate。无需填写静态 Token 或手工 client secret。浏览器打开确认页后登录绑定账户，再返回确认页刷新并同意。

CLI 可执行：

```sh
codex mcp add rhythm-health --url https://health.doubiyang.com/mcp
codex mcp login rhythm-health
```

## 运维

```sh
docker compose -f deploy/compose.yml ps
docker compose -f deploy/compose.yml logs --tail 50 mcp sync
docker compose -f deploy/compose.yml up --build -d
```

Nginx 配置模板在此目录。只为 health 子域名添加新站点，保留交易 MCP 与发布工具的配置。ACME 使用 `/var/www/fitbit-acme`，Certbot 定时续签，deploy hook 校验后重载 Nginx。

## Google 出站网络

北京服务器直连 Google 会连接超时。账户/同步应用加入现有 `rednotemove_app` Docker 网络，使用 `http://proxy-gateway:21862`（rednotemove 现有海外 OAuth 监听入口）。`7890` 默认是 DIRECT，不能用于此用途。未修改 rednotemove 的配置、节点或选择器，也未向公网开放代理端口。

Node 25 使用 `NODE_USE_ENV_PROXY=1` 使原生 fetch 使用代理；Google SDK 同时读取 `HTTPS_PROXY`。`NO_PROXY` 使数据库、应用内部请求和本机保持直连。此配置仅传给 Fitbit app，MCP 入站和数据库不经代理。现有网关及该监听端口必须可用；如果 rednotemove 更改了服务绑定或监听端口，需同步更新此处配置。

首次部署经用户明确许可，将本地数据库与必需配置通过 SSH 迁移到服务器。真实凭据存于权限0600的根目录 `.env.local`，不进入 Git。OAuth 状态卷应与数据库一起备份；不要删除卷或运行 `down -v`。

公网验证脚本（创建5分钟测试登录，最后删除会话并撤销令牌，只输出通过状态）：

```sh
docker run --rm --network fitbit_default --env-file .env.local \
  -v /home/ubuntu/fitbit/deploy/verify-oauth.mjs:/app/verify-oauth.mjs:ro \
  fitbit-mcp:latest node verify-oauth.mjs
```
