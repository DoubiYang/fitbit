# 健康数据远程 MCP

独立的只读 Streamable HTTP MCP，复用本项目 Google OAuth、每小时后台同步和 PostgreSQL。MCP 本身不向 Google 发请求；Dot 根据自己的定时任务读取数据和提醒。原账户页继续用于首次授权和重新连接。

## 启动

在根目录 `.env.local` 增加以下配置（不要提交真实密钥）：

```dotenv
MCP_USER_ID=已连接账户的本地用户UUID
MCP_TOKEN=至少32字符的随机密钥
MCP_PUBLIC_URL=https://你的域名/mcp
APP_ORIGIN=https://你的应用域名
```

用 `openssl rand -hex 32` 生成密钥。查本地账户 UUID：

```sh
docker compose exec -T db psql -U rhythm -d rhythm -c 'SELECT user_id, status FROM google_health_connections;'
docker compose --profile mcp up --build -d mcp
```

通过已有 HTTPS 反向代理，把 `/mcp` 原样代理至 `127.0.0.1:3001/mcp`，保留 Authorization 头。MCP 端口默认仅绑定回环地址。远程使用必须配置真实 HTTPS 域名和证书；本地验证可用 `MCP_PUBLIC_URL=http://localhost:3001/mcp`。

Dot 添加远程 MCP：URL 填 `MCP_PUBLIC_URL`，认证头填 `Authorization: Bearer <MCP_TOKEN>`。此版要求客户端支持自定义 Bearer Token；没有实现 MCP 客户端的 OAuth 授权服务器。Google OAuth 由现有账户页处理。

一个 MCP 实例固定绑定一个账户。多用户可先启动多个实例，分别使用不同 UUID、密钥及端口。客户端不能指定其他用户 UUID。

## 工具

- `get_sync_status()`：连接状态、最近成功同步、下一次同步、错误代码、是否超过36小时、账户授权地址。
- `get_health_data({from,to})`：最多42天的睡眠、HRV、静息心率、活动和每日心率汇总。日期为 `YYYY-MM-DD`；心率均值按观测覆盖秒数加权。
- `get_daily_summary({date})`：本地已保存的恢复、睡眠表现、TRIMP及今日可用负荷，附质量和同步时间。

缺失值不补零。每天的负荷会继续累计，过期数据须先检查同步。部分数据只保留最近42天，查询更早日期可能为空。Google 授权失效时，Dot 应提供返回的账户链接提醒重新连接。

测试：在此目录执行 `npm ci && npm test`。服务不记录请求正文、健康数据或密钥。生产查询连接强制只读。

真实数据库冒烟测试可在根目录执行以下命令。它通过 HTTP MCP 调用三个工具，只输出通过状态，不输出健康数据；有多个账户时需添加 `-e MCP_USER_ID=<UUID>`：

```sh
docker compose up -d db
docker run --rm --network fitbit_default --env-file .env.local \
  -e POSTGRES_HOST=db -e POSTGRES_USER=rhythm -e POSTGRES_DB=rhythm \
  -v "$PWD/mcp:/app:ro" -w /app node:25-bookworm-slim node smoke.mjs
```

示例 Dot 任务：每天早上查询同步状态和最近7天数据，总结睡眠、静息心率和HRV趋势；数据过期或缺失时先提醒同步，不把缺失解释为健康异常。
