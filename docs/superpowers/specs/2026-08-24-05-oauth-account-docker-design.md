# Google OAuth、账户管理与 Docker 本地部署设计

**状态：** 用户已同意方案 A，待实现
**日期：** 2026-08-24
**对应工作项：** 在本机以 Google OAuth 登录，安全持久化 Google Health 授权，并提供本地账户管理

## 1. 目标与范围

本切片让用户可在本项目启动的 Web 应用中：

1. 通过 Google OAuth 登录并授权 Google Health 的最小只读权限；
2. 在 PostgreSQL 中安全保存属于自己的授权连接与会话；
3. 在账户页查看连接状态、重新授权、退出和断开；
4. 为下一切片的真实 Health 数据同步提供服务端 refresh token 与 `healthUserId`。

本切片**不**拉取、保存或展示真实健康记录；不启动历史回填、webhook、AI Coach、拍照记餐或任何写入 Google Health 的功能。授权成功只表示后续同步具备凭据，页面须诚实显示“已连接，等待同步”。

## 2. 选定方案与替代方案

选定方案是项目内 Docker Compose：Next.js `app` 服务与 PostgreSQL `db` 服务各自运行在容器中。数据库实际数据通过 `./.data/postgres` 挂载到项目目录，且 `.data/` 不进入 Git；token 进入 PostgreSQL 前由应用层 AES-256-GCM 加密。

未选方案：

- 临时内存 OAuth：重启会丢失授权，无法支持 refresh token 或可靠同步；
- 不落库的 cookie token：会向浏览器暴露敏感凭据；
- 直接实现后台同步、webhook 和完整生产运营：超出“先登录并管理账户”的范围，且依赖真实 Google Cloud 配置和 Fitbit Air 数据验证。

Google Health 使用 Google OAuth 2.0；应用需在 Google Cloud 注册 Web OAuth client、配置 redirect URI、测试用户与所需 scope。新创建的测试模式 client 需要把实际授权者加入 Test users；测试模式 refresh token 最长 7 天有效，UI 必须显示授权可能到期而不是承诺永久连接。[Google Health OAuth 配置](https://developers.google.com/health/setup)

## 3. 容器与本地配置

### 3.1 Compose 服务

```text
浏览器 → http://localhost:3000 → app (Next.js)
                                      │
                                      └─ docker 网络 → db (PostgreSQL)
                                                       └─ ./.data/postgres
```

- `app`：用多阶段 Dockerfile 构建并运行 Next.js，公开 `3000`；只从 compose 环境读取配置。
- `db`：固定 PostgreSQL 主版本，默认只在 compose 网络可见，不映射宿主机数据库端口。
- `.data/postgres`：宿主机项目目录内的数据卷；在 `.gitignore` 排除。
- `.env.local`：仅供 Docker Compose 注入，保存 Google client ID/secret、数据库口令、cookie 签名密钥与 token 加密密钥；不提交。
- app 在启动时不会生成或替换密钥。任一安全配置缺失时，OAuth 路由 fail closed，账户页显示“本地授权尚未配置”。

### 3.2 需要的配置

```dotenv
DATABASE_URL=postgresql://rhythm:local-password@db:5432/rhythm
GOOGLE_HEALTH_CLIENT_ID=
GOOGLE_HEALTH_CLIENT_SECRET=
GOOGLE_HEALTH_REDIRECT_URI=http://localhost:3000/api/auth/google/callback
TOKEN_ENCRYPTION_KEY=             # 32 bytes, base64 encoded
SESSION_COOKIE_SECRET=             # 至少 32 random bytes, base64 encoded
APP_ORIGIN=http://localhost:3000
```

`TOKEN_ENCRYPTION_KEY` 与 `SESSION_COOKIE_SECRET` 必须不同。开发者在自己的 `.env.local` 生成并保管它们；不得贴到聊天、日志、截图、测试 fixture 或 Git 中。

## 4. 最小权限与身份模型

首次连接只请求：

- `https://www.googleapis.com/auth/googlehealth.sleep.readonly`
- `https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly`
- `https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly`

不请求 nutrition 或任意 write scope。Google 明确要求只请求产品实际所需的 scope，并对部分同意做降级处理；连接记录保存实际授予 scope，账户页据此显示“权限不完整”。[Google Health scope 指引](https://developers.google.com/health/scopes)

本产品的健康身份主键是服务端调用 Google Health `users.getIdentity` 得到的 `healthUserId`。不会把浏览器提供的 ID、email 或 OAuth callback 参数当作健康数据归属。Google Health 文档规定需要以 identity 端点取得用户 ID。[Data Access and Authorization](https://developers.google.com/health/migration/data-access)

`users` 的内部 UUID 是系统所有权边界；`google_health_connections.health_user_id` 唯一且与某一 `users.id` 绑定。若已登录账户重新连接，身份必须与原连接相同，否则拒绝替换并要求先断开，避免误绑定另一个人的健康数据。

## 5. 数据库模型

### `users`

| 字段 | 用途 |
| --- | --- |
| `id` UUID PK | 内部用户边界 |
| `created_at`, `updated_at` | 审计时间 |

### `google_health_connections`

| 字段 | 用途 |
| --- | --- |
| `id` UUID PK | 在第一次加密前创建的不可变 connection ID；用于 token envelope AAD |
| `user_id` UUID UNIQUE FK | 连接的本地所有者 |
| `health_user_id` TEXT UNIQUE | Google Health identity |
| `token_envelope_ciphertext` | 包含 access/refresh token 的单个版本化 AES-GCM 密文，不保存明文 |
| `token_envelope_iv`, `token_envelope_auth_tag`, `encryption_key_version` | 每个 envelope 独有的 nonce、认证 tag 与密钥轮换版本 |
| `access_token_expires_at` | 后续同步按需刷新 token |
| `granted_scopes` TEXT[] | 实际同意而非期望权限 |
| `status`, `last_error_code`, `connected_at`, `updated_at` | 账户页状态，不保存 Google 原始错误或 token |

token envelope 的明文仅在服务端内存中短暂存在，格式固定为 `{ accessToken, refreshToken }`。加密时须以 `connection_id + user_id + "token-v1" + key_version` 作为 AAD；不得复用 nonce，且不得让不同连接的密文互换后仍可解密。重新授权若没有返回新的 refresh token，必须先解密既有 envelope、保留 refresh token 后整体重新加密；不得以空值覆盖。

### `sessions`

| 字段 | 用途 |
| --- | --- |
| `id` UUID PK | 服务端 session ID |
| `user_id` UUID FK | 已登录用户 |
| `token_hash` | 随机 session token 的 SHA-256 哈希；明文不入库 |
| `expires_at`, `created_at`, `last_seen_at` | 到期与清理 |

session 固定有效 14 天，不做静默滑动续期；完成一次成功 OAuth callback 后才新建 session。cookie 必须为 host-only（不设 `Domain`）、`Path=/; HttpOnly; SameSite=Lax`，生产环境加 `Secure`。每次读取都验证未过期；过期 session 从数据库删除、清除 cookie，并返回未登录状态。

### `oauth_transactions`

短期表，只保存 `state` 的哈希、PKCE verifier 的加密密文、发起授权时的 `initiating_user_id`（可空）和过期时间。成功、失败或过期后删除，默认最大寿命 10 分钟。它绑定一个 `HttpOnly` 短期 cookie，callback 必须同时验证 cookie、state、DB 记录与过期时间，且使用常量时间比较。

## 6. 路由、会话与 OAuth 流程

### 路由

| 方法 / 路径 | 行为 |
| --- | --- |
| `GET /account` | 无 session 显示连接入口；有 session 显示本账户与授权状态 |
| `GET /api/auth/google/start` | 创建 OAuth transaction，设置短期 cookie，302 到 Google |
| `GET /api/auth/google/callback` | 验证 transaction，服务端换 token、取得 identity、事务性 upsert 连接、建 session，302 到 `/account` |
| `POST /api/account/reauthorize` | 仅已登录用户；以完整只读 scope 集合重新进入 start 流程 |
| `POST /api/account/logout` | 删除当前 session 并清除 cookie |
| `POST /api/account/disconnect` | 仅已登录用户；尽力撤销 Google token、删除本地连接及所有该用户 session，清除 cookie |

所有变更账户状态的接口只允许 `POST`，检查同源 `Origin`，使用 `HttpOnly; SameSite=Lax` cookie，并拒绝缺失/错误 session。生产环境的 cookie 设置 `Secure`；`localhost` 开发环境按浏览器限制允许非 Secure cookie。

### 授权顺序

1. 用户访问 `/account`，点击“连接 Google Health”。
2. app 生成高熵 `state`、PKCE verifier/challenge 与短期 transaction，随后构造带 `access_type=offline` 的授权 URL。首次连接可使用 `prompt=consent` 获得 refresh token；正常重访不强制重复 consent。
3. Google callback 到 app。app 在服务端验证所有 anti-CSRF/PKCE 要素；失败时不交换或保存 token。
4. app 用 Google 官方 OAuth2 client library 换 token，调用 Google Health identity 接口，检查实际授予的只读 scope。
5. app 先确定不可变所有者：未登录 callback 遇到已知 `healthUserId` 时，为该既有 `users.id` 新建 session；未登录 callback 只有在未知 identity 时才能创建新 user 与 connection。已登录重新授权只能更新该 user 自己已有的 connection；若 identity 属于另一 user，拒绝回调且绝不转移连接。所有者确定后，再用一个数据库事务写入加密 token、连接状态与随机 session。
6. `/account` 显示已连接状态；`/` 改为以 server session 取用户。真实同步尚未实现时只显示等待同步状态，不再显示其他用户或演示数据。

Google 的标准配置使用 `access_type=offline` 以获得 refresh token，且建议仅在初次或 scope 变化时带 `prompt=consent`；refresh token 应按用户的实际同步需求按需刷新，而不是批量刷新。[Google Health OAuth 配置](https://developers.google.com/health/setup)

## 7. UI 状态与诚实降级

账户页只显示必要的状态，不显示 email、Google token、完整 Google 错误内容或 `healthUserId`：

| 状态 | 可见内容 | 可执行动作 |
| --- | --- | --- |
| 未配置 | “需要本地 Google Health 配置” | 查看本地配置说明 |
| 未登录 | “尚未连接 Google Health” | 连接 |
| 已连接 / 等待同步 | 最近授权时间、实际 scope 摘要 | 重新授权、退出、断开 |
| 部分权限 | 缺少的功能类别与不会同步的说明 | 重新授权、断开 |
| 授权失效 | “需要重新连接” | 重新授权、断开 |
| callback 失败 | 安全的中文原因与重试入口 | 返回账户页 |

主页不从 URL、localStorage、请求 body 或 client component 接收用户身份。它只调用 `getCurrentUser()`；该函数在无 session 时给出未登录状态，在已登录时给出内部 UUID。演示模式仅当 OAuth 与数据库配置整体缺失时可用，并必须有明显标识。

## 8. 安全与隐私约束

- access token、refresh token、PKCE verifier 和明文 session token 均不得进入日志、响应体、React props、测试快照、错误页面或后续应用 URL。OAuth authorization code 只能出现在 Google 定向到已注册 callback 的单次 query request 中：app 必须立即消费它、删除 transaction、以无 query 的 303 redirect 返回 `/account`，并在 callback 响应设置 `Referrer-Policy: no-referrer`；不得记录、转发或保留该 code。
- token 加密使用 authenticated encryption；解密认证失败按连接失效处理，不尝试容错解析。
- 数据库连接、OAuth client secret、cookie 签名密钥、token 密钥只能存在于 `app` 容器环境，不能以 `NEXT_PUBLIC_` 开头。
- callback、断开、logout 失败消息仅提供用户可理解的类别；详细错误仅以脱敏错误码记录。
- 断开优先删除本地凭据与 session；Google 撤销请求失败不阻止本地断开，但 UI 要提示可到 Google 账户权限页继续撤销。
- 本切片不请求、读取、处理或传输任何真实健康数据给模型或浏览器。

## 9. 测试与验收

### 自动化测试

1. 配置：缺 client ID/secret、数据库 URL、两类密钥时 OAuth fail closed，且不生成外部授权 URL。
2. 加密：32-byte base64 key 校验、加/解密 round-trip、认证 tag 篡改失败、不同 key version 不误解密；将 envelope 交换到另一 `connection_id`、另一 `user_id` 或另一 token kind 时必须认证失败。
3. OAuth service：URL 包含全部只读 scope、offline、state 与 S256 PKCE；错误 state/过期 transaction 在 token 交换前失败。
4. 回调：identity 只由服务端 OAuth client 取得；连接 upsert 保留缺失的 refresh token；未登录的已知 identity 复用原 owner，未知 identity 才创建 owner，已登录 callback 不可更换 owner；不把 token 放进 session 或账户 view model。
5. 会话：cookie token 与库中 hash 匹配才解析为 user；cookie 有 `Path=/` 且不设 `Domain`；过期、伪造、已断开 session 失败关闭。
6. 路由：只接受授权 callback 的预期参数；状态变更 route 拒绝 GET、跨源 POST 和无 session 请求。
7. 数据隔离：两个用户只能读到自己的连接状态；无法用 URL 或 header 冒充另一个 `userId`。
8. UI：账户页展示每一种安全状态；主页不会在 OAuth 模式退回 `demo_user`。

### 手动验收（需要用户提供本地 Google Cloud 配置）

1. `docker compose up --build` 后访问 `http://localhost:3000/account`；
2. 在 Google Cloud 添加本地 callback、最小 scope 和测试用户；
3. 点击连接，选择自己的测试 Google 账号，核验 callback 回到“已连接，等待同步”；
4. 重启容器后仍保持登录；
5. 点击重新授权与断开，确认本地账户状态正确、token 不出现在浏览器网络响应或日志；
6. 在 Testing mode 记录 7 天 refresh token 到期限制，过期后页面提供重新授权。

## 10. 实现外部前置

- 用户在 Google Cloud 创建或选择项目，启用 Google Health API，建立 Web OAuth client，并把实际测试 Google 账号加入 Test users；
- 本地 callback URL 与 `APP_ORIGIN` 一致；如果 Google 不接受 `http://localhost` 的目标环境，改用用户拥有的 HTTPS 开发域名并同步修改配置；
- 用户自行生成 `.env.local` 密钥。实现代码只提供变量名、校验与安全的生成命令说明，绝不代填真实值；
- 完成此切片后才开始真实数据同步。同步切片还需 Fitbit Air 测试账号的字段验证、数据保存/删除策略与 Provider API 契约测试。
