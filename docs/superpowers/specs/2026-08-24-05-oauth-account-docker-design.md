# Google OAuth、账户管理与 Docker 本地部署设计

**状态：** 已实现 OAuth、账户管理与首次 14 天热同步；其余一期能力仍待实现
**日期：** 2026-08-24
**对应工作项：** 在本机以 Google OAuth 登录，安全持久化 Google Health 授权，并提供本地账户管理
**取代：** 本文的首次授权 scope 集合取代 [Google Health API 验证设计](2026-08-23-02-google-health-api-validation-design.md) 中“首次只请求三个只读 scope、营养权限增量申请”的决定。应用内写回开关、模型传输同意仍按原文，不因 Google 已授 write scope 就自动写回。

## 1. 目标与范围

本切片让用户可在本项目启动的 Web 应用中：

1. 通过 Google OAuth 登录，并一次性授予 Google Health **全部现行只读数据 scope** 以及一期写回所需的 `nutrition.writeonly`；
2. 在 PostgreSQL 中安全保存属于自己的授权连接与会话；
3. 在账户页查看连接状态、重新授权、退出和断开；
4. 为下一切片的真实 Health 数据同步提供服务端 refresh token、`healthUserId` 与实际授予的 scope。

当前实现会在授权成功后，仅为刚授权的用户尝试同步最近 14 天的睡眠、每日 HRV、每日静息心率与训练，成功后写入本地快照；首页只读取该快照，打开页面不会请求 Google。同步失败不覆盖旧快照，也不推进成功时间。当前仍**不**包含历史回填、webhook、拍照记餐、`nutrition-log` 写回或 AI Coach；即使已获营养写入授权，代码也不会调用写接口。

## 2. 关键决定

1. **本地运行形态：Compose 内同时跑 Next.js 与 PostgreSQL。** 内存 OAuth 无法跨重启保存 refresh token；把 token 放进 cookie 会暴露给浏览器。当前仅有授权后、当前用户的 14 天热同步；没有全用户 cron、历史回填或 webhook。
2. **首次授权一次要齐可读数据 + 营养写回。** 后续加 Google scope 必须让用户再走同意页，测试模式 refresh token 又只有 7 天，因此不把数据 scope 拆到以后。产品不会写入睡眠、运动、档案等，故**不**申请对应 writeonly（writeonly 也不增加读权限，且违反 Google“只申请实际使用的写权限”）。应用内仍须用户打开写回开关后才真正写 `nutrition-log`。
3. **健康身份主键是 `healthUserId`，断开不断号。** 连接行软删除：撤权、清空密文、删全部 session，但保留 `health_user_id` / `legacy_user_id` 与同一个 `users.id`。重连必须回到原 owner，不能新建用户。
4. **首次连接没有 refresh token 则失败，不落库。** 重授权若未带回新 refresh token，才解密旧 envelope 并保留。
5. **开始授权一律 POST，有 session 就必须绑定 `initiating_user_id`。** 禁止已登录用户被当成未登录 callback，从而切到另一个 Google 账号。
6. **禁止 `include_granted_scopes=true`。** 同一 client 若曾授过旧 `fitness.*`，并入新 token 后 identity 可能可读、数据面会 403。
7. **Session cookie 是高熵不透明 token，库中只存 SHA-256。** 不再另设 `SESSION_COOKIE_SECRET`。OAuth 短 cookie 只存不可猜测的 transaction id。
8. **演示模式仅在全部安全配置都缺失时可用。** 任一相关变量出现但集合不完整 → 未配置、OAuth fail closed、首页不得回退 `demo_user`。
9. **自动化测试不依赖 Docker/Postgres。** 加密、OAuth URL、callback 所有者规则用纯函数与内存仓储。Compose 供 `docker compose up --build` 与手动验收。
10. **线上与其他服务共用主机，用 `/rhythm` 做路径隔离。** Google 同意屏的首页/隐私/条款必须是公网 HTTPS，不能填 localhost。授权网域只填主机名；本机与线上的 cookie `Path`、Next.js `basePath` 与 OAuth redirect 都带 `/rhythm`，避免线上会话泄漏到同一主机上的其他应用，并与已登记的 redirect URI 一致。

## 3. 选定方案与替代方案

选定方案是项目内 Docker Compose：Next.js `app` 与 PostgreSQL `db` 各跑在容器里。数据目录 `./.data/postgres` 挂到项目下且不进 Git；token 入库前由应用层 AES-256-GCM 加密。

未选方案：

- 临时内存 OAuth：重启丢失授权；
- 不落库的 cookie token：向浏览器暴露 refresh token；
- 只把 Postgres 放进 Docker、app 仍 `pnpm dev`：本切片按已同意的方案 A，两边都容器化；热重载不是本切片目标；
- 本切片同时做同步、webhook、生产验证：超出“先登录并管理账户”。

Google Health 使用 Google OAuth 2.0。须在 Google Cloud 启用 Google Health API、注册 **Web application** client、配置 Authorized JavaScript origin = `APP_ORIGIN`、redirect URI = `{APP_ORIGIN}/api/auth/google/callback`、OAuth consent 为 External + Testing，并把实际授权者加入 Test users。测试模式 refresh token 最长 7 天；UI 必须显示授权可能到期，不得承诺永久连接。[Google Health OAuth 配置](https://developers.google.com/health/setup)

## 4. 授权范围

Google Health writeonly **不包含**读权限。要读营养日志必须同时要 `nutrition.readonly`；要写回还要 `nutrition.writeonly`。

### 4.1 首次连接固定请求的集合

每次 start 都请求下面这一份完整集合，顺序固定，便于测试断言。该 10-scope 集合是产品已确认的首次授权契约，目的是覆盖后续完整仪表盘、AI Coach 与经用户确认的餐食写回；它不是“当前热同步的最小集合”。URL 使用完整 scope URI。

| Scope | 用途 |
| --- | --- |
| `https://www.googleapis.com/auth/googlehealth.sleep.readonly` | 睡眠会话与阶段（仪表盘核心） |
| `https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly` | HRV、RHR、心率及其他生命体征（仪表盘核心） |
| `https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly` | 训练、步数、活动与心率区间（仪表盘核心） |
| `https://www.googleapis.com/auth/googlehealth.nutrition.readonly` | 读取本产品写回的 `nutrition-log` 与用户侧营养记录 |
| `https://www.googleapis.com/auth/googlehealth.nutrition.writeonly` | 一期确认餐食后的创建/删除；本切片不调用写接口 |
| `https://www.googleapis.com/auth/googlehealth.profile.readonly` | 档案类字段（年龄、会员起始等），供后续解释，本切片不展示 |
| `https://www.googleapis.com/auth/googlehealth.settings.readonly` | 时区与单位，后续 civil time 规范化需要 |
| `https://www.googleapis.com/auth/googlehealth.location.readonly` | 运动过程 GPS |
| `https://www.googleapis.com/auth/googlehealth.ecg.readonly` | ECG |
| `https://www.googleapis.com/auth/googlehealth.irn.readonly` | 心律不齐通知 |

`users.getIdentity` 在上述任一 Health readonly（含三个核心 scope）下即可调用，不必再为 identity 单独要 `profile.readonly`；`profile.readonly` 是为档案数据本身。

### 4.2 明确不申请的 scope

不申请任何尚未被产品使用的 writeonly，包括：

`activity_and_fitness.writeonly`、`health_metrics_and_measurements.writeonly`、`sleep.writeonly`、`profile.writeonly`、`settings.writeonly`、`logged_symptoms.writeonly`、`mindfulness.writeonly`、`reproductive_health.writeonly`。

这些不会带来额外可读数据。若将来产品真的要写其中某一类，再增量授权，并在同意页说明对应功能。

### 4.3 部分同意与账户状态

Google 要求对部分同意做降级，应用不得因用户少勾一项就整体失败。[scope 指引](https://developers.google.com/health/scopes)

- 连接保存 **实际授予** 的 `granted_scopes`，不是请求集合。
- 缺任意已请求 scope → 账户页「权限不完整」，列出缺失类别。
- 三个仪表盘核心 scope 都在 → 当前 14 天热同步仍可尝试；缺核心 scope 时额外说明仪表盘数据将不完整。
- 仅缺 `nutrition.writeonly` → 连接仍标记为部分授权，但当前仪表盘热同步不受该项影响；未来写回功能不可用，直到重新授权补齐。
- 用户在 Google 同意页点取消（`error=access_denied`）→ 不建连接，账户页安全错误。

### 4.4 授权 URL 硬约束

- `response_type=code`、`access_type=offline`、PKCE `S256`、高熵 `state`（≥32 字节）。
- **不得**出现 `include_granted_scopes=true`（参数缺省即视为未开启；测试断言 query 中无此键，或值为 `false`）。
- `redirect_uri` 必须等于 `{APP_ORIGIN}/api/auth/google/callback`，不得接受用户输入。
- `prompt=consent` 仅在需要新 refresh token 或要补齐缺失 scope 时附加：首次连接、连接 `expired` / 无 refresh token、`granted_scopes` 不是请求集合的超集。普通已登录重访且 token 仍有效时不带 `prompt`。

## 5. 身份模型

健康身份主键是服务端调用

`GET https://health.googleapis.com/v4/users/me/identity`

得到的 `healthUserId`。不得把浏览器提供的 ID、email、OAuth `id_token`、callback 参数或 Google 账号邮箱当作健康数据归属。[Data Access and Authorization](https://developers.google.com/health/migration/data-access)

同时保存 `legacyUserId`（可空）。官方建议两个都存，便于以后对照；一期不同步旧 Fitbit API。

规则：

- `users.id`（内部 UUID）是本系统所有权边界。
- `google_health_connections.health_user_id` 全局唯一，且在断开后仍然保留。
- 未登录 callback：已知 `healthUserId`（含 `disconnected` 行）→ 复用该行的 `users.id`，把连接从断开恢复为有 token 的状态，并新建 session。未知 identity → 新建 `users` + `google_health_connections`。
- 已登录 callback（transaction 带 `initiating_user_id`）：identity 必须属于该用户自己的连接。属于另一用户 → 拒绝、不写 token、不改 cookie。该用户尚无连接行（不应在本模型出现，因为登录必有连接）→ 拒绝。
- 已登录用户不得通过 `POST /start` 绑定另一个人的 Health 账号。

断开是撤权，不是销户：不清 `users` 行，不丢 `health_user_id`。

## 6. 容器与本地配置

### 6.1 Compose 服务

```text
浏览器 → http://localhost:3000 → app (Next.js, output: standalone)
                                      │
                                      └─ docker 网络 → db (postgres:16)
                                                       └─ ./.data/postgres
```

- `app`：多阶段 Dockerfile，运行期再读环境变量；构建参数不得包含 secret；镜像内不得 `COPY .env.local`。公开 `3000`。
- `db`：`postgres:16`。只出现在 compose 网络，**不**映射宿主机端口。`healthcheck` 使用 `pg_isready`。
- `app` `depends_on: db` 且 `condition: service_healthy`。进程启动后先跑 `db/migrations/*.sql`（表 `schema_migrations`），再听 HTTP。
- `.data/postgres`：项目目录数据卷，`.gitignore` 排除。
- `.env.local`：仅作为 Compose `env_file` 注入 `app`（及 `db` 需要的口令）；不提交。容器不依赖 Next 自动读宿主机 `.env.local`。
- 应用启动时**不得**生成或替换密钥。

开发者本机用 `http://localhost:3000/rhythm`，不要用 `http://127.0.0.1:3000`：Google redirect URI、cookie host 与 `APP_ORIGIN`+`APP_BASE_PATH` 必须精确匹配。

### 6.2 环境变量

```dotenv
# 口令由开发者本地生成，不得使用文档中的示例值提交或分享
POSTGRES_USER=rhythm
POSTGRES_PASSWORD=
POSTGRES_DB=rhythm
DATABASE_URL=postgresql://rhythm:PASSWORD@db:5432/rhythm

GOOGLE_HEALTH_CLIENT_ID=
GOOGLE_HEALTH_CLIENT_SECRET=

# 仅 scheme + host + 可选 port，禁止带 path
APP_ORIGIN=http://localhost:3000
# 本机与线上都是 /rhythm（无尾斜杠），与 Google redirect URI 一致
APP_BASE_PATH=/rhythm

# openssl rand -base64 32
# 必须恰好解码为 32 字节
TOKEN_ENCRYPTION_KEY=
# 可选。轮换时把旧 key 放这里，仅用于解密旧 envelope
TOKEN_ENCRYPTION_KEY_PREVIOUS=
```

公开 URL 一律为 `{APP_ORIGIN}{APP_BASE_PATH}{path}`。OAuth redirect URI **不**单独配置，始终为 `{APP_ORIGIN}{APP_BASE_PATH}/api/auth/google/callback`。

`Origin` 请求头不含 path，CSRF 比较仍用 `APP_ORIGIN`。Cookie `Path` 等于 `APP_BASE_PATH`（本机与线上均为 `/rhythm`）。Next 设置 `basePath: '/rhythm'`。

Google Cloud 须同时登记：

- Authorized JavaScript origins：本机 `http://localhost:3000` 与线上 `https://doubiyang.com`（无 path）
- Authorized redirect URIs：本机 `http://localhost:3000/rhythm/api/auth/google/callback` 与线上 `https://doubiyang.com/rhythm/api/auth/google/callback`

### 6.2.1 Google 同意屏三个网域 URL

同意屏「应用网域」不能用 localhost，必须是线上 HTTPS。主机与其他服务共用，三个链接固定走 `/rhythm`：

| 表单项 | 填入值 |
| --- | --- |
| 应用首页 | `https://doubiyang.com/rhythm` |
| 应用隐私权政策链接 | `https://doubiyang.com/rhythm/privacy` |
| 应用服务条款链接 | `https://doubiyang.com/rhythm/terms` |

「授权网域」只加 `doubiyang.com`，不要加 `https://`，不要加 `/rhythm`。

本切片在应用内提供这三个路径的静态说明页（隐私与条款为最小中文文本，首页可跳到账户/今日入口）。未部署前 Google Testing 模式有时仍能保存 URL；发布或验证前这三个地址必须能公开打开。

`TOKEN_ENCRYPTION_KEY_PREVIOUS` 若存在，必须与当前 key 不同，且同样是 32 字节。新写入永远用当前 key（`encryption_key_version = 1`）。当前 key 丢失且没有 previous → 已有连接无法解密，必须重新授权；这一点要写进 README。

生成命令只出现在 README / `.env.example` 注释，实现代码不代填真实值。

### 6.3 配置矩阵

判定「安全配置完整」：`DATABASE_URL`、`GOOGLE_HEALTH_CLIENT_ID`、`GOOGLE_HEALTH_CLIENT_SECRET`、`TOKEN_ENCRYPTION_KEY`、`APP_ORIGIN` 全部非空，且 key 能解码为 32 字节，且 `APP_ORIGIN` 为绝对 origin（scheme + host + 可选 port，无 path）。`APP_BASE_PATH` 固定为 `/rhythm`（无尾斜杠）。`APP_ORIGIN` 可有文档默认值 `http://localhost:3000`，单独存在不把环境打成「未配置」。演示 vs OAuth 只看 DB / Google / 加密密钥是否齐全。

| 状态 | 行为 |
| --- | --- |
| 上述变量**全部**缺失或空 | 演示模式。`getCurrentUser()` 返回 `{ mode: 'demo', id: 'demo_user' }`。首页与 `/api/today` 仍用 `DemoHealthProvider`。必须有明显「演示」标识。OAuth 路由仍 fail closed（不生成授权 URL）。 |
| 至少一个变量出现，但集合不完整或 key 非法 | **未配置**。OAuth fail closed。账户页「本地授权尚未配置」。首页与 `/api/today` **不得**使用 `demo_user` 或演示健康数据。 |
| 集合完整 | **OAuth 模式**。无 session → 未登录。有 session → 内部 UUID。首页不得回退 `demo_user`。授权后只展示最近一次成功保存的本地快照；尚无成功快照时显示数据不足。 |

## 7. 数据库模型

迁移为版本化 SQL，放在 `db/migrations/`。类型按下面执行，尤其 token 相关列必须能放下 Google access token（文档上限 2048 字节）的密文。

### `users`

| 字段 | 类型 | 用途 |
| --- | --- | --- |
| `id` | UUID PK | 内部用户边界 |
| `created_at`, `updated_at` | TIMESTAMPTZ | 审计 |

### `google_health_connections`

| 字段 | 类型 | 用途 |
| --- | --- | --- |
| `id` | UUID PK | 首次插入时生成，此后不可变；token AAD 使用它。断开后**复用同一行**，不得换 id |
| `user_id` | UUID UNIQUE NOT NULL FK → users | 本地所有者 |
| `health_user_id` | TEXT UNIQUE NOT NULL | Google Health identity；断开后仍保留 |
| `legacy_user_id` | TEXT UNIQUE NULL | Fitbit legacy id；无则空 |
| `token_envelope_ciphertext` | BYTEA NULL | 明文 `{ accessToken, refreshToken }` 的 AES-GCM 密文；断开后为 NULL |
| `token_envelope_iv` | BYTEA NULL | 12 字节 nonce |
| `token_envelope_auth_tag` | BYTEA NULL | 16 字节 GCM tag |
| `encryption_key_version` | INTEGER NULL | 当前写入为 1 |
| `access_token_expires_at` | TIMESTAMPTZ NULL | 后续同步按需刷新 |
| `refresh_token_expires_at` | TIMESTAMPTZ NULL | 有 `refresh_token_expires_in` 则写入；测试模式按 7 天可估算。到期则 `expired` |
| `granted_scopes` | TEXT[] NOT NULL DEFAULT '{}' | 实际同意的完整 URI |
| `status` | TEXT NOT NULL | 见下枚举 |
| `last_error_code` | TEXT NULL | 脱敏错误码 |
| `connected_at`, `updated_at` | TIMESTAMPTZ | 账户页时间 |

`status` 仅允许：

- `disconnected`：本地已撤权，无密文，identity 仍在；
- `active`：有 refresh token，请求集合均已授予；
- `partial`：有 refresh token，但缺少至少一个请求 scope；
- `expired`：refresh 到期、解密失败、或 Google 侧视为失效（本切片主要靠 `refresh_token_expires_at` 与解密失败）。

断开：同一事务内把密文/IV/tag/key_version/过期时间置 NULL，`granted_scopes='{}'`，`status='disconnected'`，`last_error_code` 清空或记 `disconnected`，删除该用户全部 `sessions`。不删除 `users` 与连接行。

### `sessions`

| 字段 | 类型 | 用途 |
| --- | --- | --- |
| `id` | UUID PK | 服务端 session 行 id |
| `user_id` | UUID NOT NULL FK → users ON DELETE CASCADE | 已登录用户 |
| `token_hash` | BYTEA UNIQUE NOT NULL | SHA-256(cookie 明文 token)，32 字节 |
| `expires_at`, `created_at`, `last_seen_at` | TIMESTAMPTZ | 到期与清理 |

Session 固定 14 天，不滑动续期。未登录成功 callback 才新建 session；已登录重授权**保持**当前 session，只更新连接。每次读取若已过期：删行、清 cookie、视为未登录。

### `oauth_transactions`

| 字段 | 类型 | 用途 |
| --- | --- | --- |
| `id` | UUID PK | 写入短 cookie 的值；≥128 bit 不可猜测 |
| `state_hash` | BYTEA NOT NULL | SHA-256(state) |
| `pkce_verifier_ciphertext` / `iv` / `auth_tag` | BYTEA | verifier 的 AES-GCM |
| `pkce_key_version` | INTEGER NOT NULL | 与 token 相同的当前 key |
| `initiating_user_id` | UUID NULL FK → users | 发起时若已登录则必填 |
| `expires_at` | TIMESTAMPTZ NOT NULL | 创建 + 10 分钟 |

成功、失败或读到过期行时删除。start 时顺带删除所有已过期行（惰性清理，本切片不做 cron）。

## 8. 加密

算法：AES-256-GCM。`TOKEN_ENCRYPTION_KEY` 先 base64 decode，**必须恰好 32 字节**；不得把 base64 字符串直接当 key。

- IV：每次加密 `crypto.getRandomValues` 12 字节，禁止复用。
- AAD（token envelope）：`{connectionId}|{userId}|token-v1|{keyVersion}`（字面分隔符 `|`）。
- AAD（PKCE verifier）：`{transactionId}|pkce-v1|{keyVersion}`。
- 把 envelope 换到另一 `connection_id`、另一 `user_id`、另一 kind（`token-v1` vs `pkce-v1`）或另一 key version，认证必须失败。
- 解密认证失败：该连接视为 `expired`，不尝试容错解析。
- 明文只在服务端内存短暂存在。

重授权未返回新 refresh token：先用当前 key（失败再用 previous）解密旧 envelope，保留 `refreshToken`，与新 `accessToken` 一起重新加密写入。**首次连接**没有旧 envelope：响应里没有 refresh token → 不插入连接、尽力 `revoke` 刚拿到的 access token、账户页 `missing_refresh_token`。

## 9. 路由、会话与 OAuth 流程

### 9.1 路由

| 方法 / 路径 | 行为 |
| --- | --- |
| `GET /account` | 按配置矩阵与 session 渲染。无身份信息不展示 email / token / `healthUserId` |
| `POST /api/auth/google/start` | 校验配置与 CSRF；创建 transaction 与短 cookie；**303** 到 Google 授权 URL。有 session 时写入 `initiating_user_id` |
| `GET /api/auth/google/start` | **405** |
| `GET /api/auth/google/callback` | 见下。只接受 `code`、`state`、`error`（忽略多余参数）。**303** 到 `/account` 或 `/account?auth_error=CODE`，去掉 OAuth query。`Cache-Control: no-store`，`Referrer-Policy: no-referrer` |
| `POST /api/account/reauthorize` | 必须已登录；内部走同一套 start，强制带 `initiating_user_id`。缺 scope 或 `expired` 时附加 `prompt=consent` |
| `POST /api/account/logout` | 删除**当前** session，清 session cookie。连接保留 |
| `POST /api/account/disconnect` | 必须已登录。先清空本地密文并删该用户全部 session（事务提交），再尽力 POST `https://oauth2.googleapis.com/revoke`。撤销失败不回滚本地断开，UI 提示去 [Google 第三方应用权限](https://myaccount.google.com/permissions) |

账户页「连接 Google Health」是 POST form，不是 `<a href="/api/auth/google/start">`，避免预取创建 transaction。

所有变更账户状态的 POST：

- `Origin` 必须**精确等于** `APP_ORIGIN`；
- 生产环境（`APP_ORIGIN` 为 `https:`）若缺 `Origin` 则拒绝；
- 不把 `Referer` 当作唯一 CSRF 依据；
- 已登录接口缺 session → 401。

Callback 是从 Google 来的顶层 GET，**不**要求 `Origin`。

账户页与全局响应加 `Content-Security-Policy: frame-ancestors 'none'`。

### 9.2 Cookie

| Cookie | 内容 | 寿命 | 属性 |
| --- | --- | --- | --- |
| `rhythm_session` | ≥32 字节 CSPRNG 明文 token | 14 天 | host-only（不设 `Domain`）、`Path` 为 `/` 或 `/rhythm`（见 `APP_BASE_PATH`）、`HttpOnly`、`SameSite=Lax`；`APP_ORIGIN` 为 https 时 `Secure`；localhost http 允许不设 `Secure` |
| `rhythm_oauth_tx` | `oauth_transactions.id` | 10 分钟 | 同上 |

Cookie 名在 localhost 与 https 上保持一致，不使用 `__Host-` 前缀（localhost http 无法满足其 Secure 要求）。

### 9.3 授权顺序

1. 用户打开 `/account`，POST「连接 Google Health」。
2. 若未配置则 303 回账户页 `auth_error=not_configured`。否则生成 `state`、PKCE verifier/challenge、transaction；有 session 则绑定 `initiating_user_id`。设置 `rhythm_oauth_tx` 后 303 到 Google。
3. Google 顶层跳回 callback。校验：短 cookie 能取到未过期 transaction、`SHA-256(query.state)` 与 `state_hash` 常量时间相等。失败则不换 token。`error=access_denied` 等在换 token 之前结束。
4. 用 Google 官方 Node 库 [`google-auth-library`](https://developers.google.com/identity/protocols/oauth2#libraries) 换 token（带 PKCE verifier）。然后服务端调用 `users.getIdentity`。`healthUserId` 为空或调用失败：尽力 revoke，不落库，`identity_unavailable`。
5. 按 §5 决定 owner。用**一个**数据库事务写入/恢复连接、加密 envelope、（若未登录）插入 session。然后删除 transaction、清 OAuth cookie。
6. 303 `/account`，并在运行时仅为该内部用户异步尝试最近 14 天热同步。已登录用户的 `/` 用内部 UUID + 最近一次成功快照；未登录用户的 `/` 不再出现演示数据。

当前热同步会按需刷新 access token；刷新响应若带回新的 `refresh_token`，会写回加密 envelope。禁止对全部用户做批量 cron；后续日常刷新须采用已登录用户显式动作或独立、可观察的每用户作业。[何时刷新](https://developers.google.com/health/setup)

### 9.4 `getCurrentUser` 与首页

```ts
export type CurrentUser =
  | { mode: 'demo'; id: 'demo_user' }
  | { mode: 'unconfigured' }
  | { mode: 'unauthenticated' }
  | { mode: 'oauth'; id: string };
```

身份只来自服务端配置 + session cookie，不来自 URL、localStorage、请求 body、header 或 client component。

| `mode` | `/` | `GET /api/today` |
| --- | --- | --- |
| `demo` | 现有 `DemoHealthProvider` 仪表盘，带演示标识 | 200，`userId=demo_user` |
| `unconfigured` | 配置说明 + 链到 `/account`，无演示健康数据 | 503，body 不含 `demo_user` 记录 |
| `unauthenticated` | 引导去 `/account` 连接，无演示健康数据 | 401 |
| `oauth` | 最近一次成功保存的本地快照；无快照时显示数据不足。**禁止** `DemoHealthProvider` | 200，`userId` 为内部 UUID，无原始健康记录 |

`HealthProvider.capabilities.mode` 扩展为 `'demo' | 'unavailable' | 'oauth'`。当前 `GoogleHealthProvider` 可在授权后的单用户热同步中读取四类核心数据；仪表盘路径仍只读快照，不能因页面访问触发 Google 请求。

现有断言 `body.userId === 'demo_user'` 的测试只在演示配置下成立；OAuth 模式必须有对测覆盖「不回退 demo_user」。

## 10. UI 状态

账户页不显示 email、Google token、Google 原始错误正文、`healthUserId`、`legacyUserId`。

| 状态 | 可见内容 | 动作 |
| --- | --- | --- |
| 未配置 | 需要本地 Google Health 配置；README 变量名与生成命令 | 查看说明 |
| 未登录 | 尚未连接 Google Health | 连接（POST start） |
| 已连接 | 最近授权时间、scope 摘要（类别名，不是原始 URI 列表刷屏）、连接后尝试同步最近 14 天、测试模式可能 7 天到期 | 重新授权、退出、断开 |
| 部分权限 | 缺失类别、对仪表盘/写回的影响 | 重新授权、断开 |
| 授权失效 | 需要重新连接（refresh 到期或解密失败） | 重新授权、断开 |
| callback 失败 | 安全中文原因 + 重试 | 回账户页 |

`auth_error` 仅允许下列码：`not_configured`、`access_denied`、`invalid_state`、`transaction_expired`、`missing_refresh_token`、`identity_mismatch`、`identity_unavailable`、`token_exchange_failed`、`origin_rejected`、`unauthorized`。未知码按通用失败展示。Google `error_description` 不得进入页面或完整日志。

PWA：本切片在**普通浏览器标签**完成 OAuth。独立窗口（`display-mode: standalone`）里 cookie 容易落到系统浏览器而回不来。账户页用一句话说明：请在浏览器中完成本次连接。不在本切片做自定义 scheme 或 postMessage 桥。

## 11. 安全与隐私约束

- access token、refresh token、PKCE verifier、authorization code、明文 session token 不得进入日志、响应体、React props、测试快照、错误页或后续应用 URL。code 只出现在 Google 打到已注册 callback 的那一次 query；立即消费、删 transaction、303 去掉 query。
- 生产 cookie 设 `Secure`。数据库 URL、client secret、token 密钥只在 `app` 容器环境，名称不得以 `NEXT_PUBLIC_` 开头。
- 断开：本地事务成功即对用户完成；Google revoke 失败只提示去权限页。
- 当前实现除 `users.getIdentity` 外，会为授权完成的单个用户读取四类核心数据并保存本地快照；不写入 Google Health，不把原始健康数据送给模型或浏览器。
- 丢失 `TOKEN_ENCRYPTION_KEY`（且无 previous）= 所有连接作废，必须重新授权。
- 大陆网络访问 `accounts.google.com`、`oauth2.googleapis.com`、`health.googleapis.com` 可能失败，列为外部前置，不在应用内做代理。

## 12. 测试与验收

### 自动化测试（默认 `pnpm test`，无 Postgres）

1. **配置矩阵：** 全空 → demo；缺任一必填或 key 不是 32 字节 → fail closed 且不生成授权 URL；完整 → 可生成 URL。
2. **加密：** 32-byte key 校验；round-trip；tag 篡改失败；换 `connection_id` / `user_id` / kind / key version 失败；previous key 能解旧信封、新写入用当前 key。
3. **OAuth URL：** 含 §4.1 全部 10 个 scope、`access_type=offline`、`state`、`code_challenge_method=S256`；**不含** `include_granted_scopes=true`；`redirect_uri` 等于 `{APP_ORIGIN}/api/auth/google/callback`；首次与 expired 带 `prompt=consent`，有效重访不带。
4. **Transaction：** 错误 state、过期、缺失短 cookie 在 token 交换前失败；GET start 为 405。
5. **回调所有者：** identity 只来自服务端 getIdentity mock；首次无 refresh token 不插入连接；重授权无新 refresh 则保留旧值；未登录已知 identity（含 disconnected）复用 owner 与 **同一个 connection id**；未知 identity 才建 owner；已登录 identity 属于别人则拒绝；token 不进 session 或账户 view model。
6. **会话：** 仅 hash 匹配且未过期才解析为 user；cookie `Path=/` 且无 `Domain`；过期、伪造、断开后的 cookie fail closed。
7. **路由：** callback 忽略意外参数；POST 拒绝错误 Origin、生产缺 Origin、无 session 的已登录接口；disconnect 在 revoke mock 失败后仍清除本地密文与 session。
8. **隔离：** 两用户只能读到自己的连接状态；URL / header 不能冒充 `userId`。
9. **UI / 首页：** 账户页覆盖未配置、未登录、active、partial、expired、callback 失败；OAuth 模式首页与 `/api/today` 不出现 `demo_user` 或演示记录，只读取成功保存的本地快照。

### 手动验收（需要用户的本地 Google Cloud 与可达的 Google 网络）

1. `docker compose up --build` 后只用 `http://localhost:3000/account`；
2. Cloud Console 登记全部 §4.1 scope、Test user、origin 与 callback；
3. 连接测试账号，回到「已连接」并核对只尝试该用户最近 14 天的热同步；重启容器后仍登录；
4. 重新授权、退出、断开后再连接：仍是同一本地账户（不断号），浏览器网络与日志无 token；
5. 测试模式注明 7 天 refresh 限制；把 `refresh_token_expires_at` 视为已过期时页面提供重新授权；
6. 同意页取消部分敏感项时进入「权限不完整」而非 500。

## 13. 实现外部前置

- Google Cloud 项目、启用 Health API、Web OAuth client、External + Testing、Test users、Data Access 中加入 §4.1 的 10 个 scope；
- Authorized JavaScript origins = 各环境的 `APP_ORIGIN`（无 path）。redirect URI 本机与线上都带 `/rhythm`。同意屏三个网域 URL 用 §6.2.1；授权网域只加 `doubiyang.com`。若 Google 环境不接受 `http://localhost` 作为 redirect，本机改用 HTTPS 开发域名，但同意屏品牌链接仍用线上 `/rhythm` 三地址；
- 开发者自己生成 `.env.local` 口令与 `TOKEN_ENCRYPTION_KEY`；
- 本机能访问 Google 的授权、换 token 与 `health.googleapis.com`；
- ECG / IRN / location 等为受限或敏感 scope。Testing + Test users 足够本切片；正式对外前需要 OAuth 验证，可能含安全评估。本切片不提交生产验证。
- 完成此切片后才开始真实数据同步。同步切片仍需 Fitbit Air 字段验证、存删策略、Provider 契约测试，以及按需 refresh（含旋转后的新 refresh token 写回）。

## 14. 风险

| 风险 | 应对 |
| --- | --- |
| 同意页过长，用户去掉 ECG/IRN/位置 | 部分同意降级；核心三项仍可尝试热同步；账户页列出缺失项并提供重新授权 |
| 申请较多敏感 scope，将来生产验证更重 | 本切片保持 Testing；验证材料按实际使用的数据类别准备，不在本切片提交 |
| 旧 `fitness.*` 混入 token 导致数据面 403 | 禁止 `include_granted_scopes`；只请求 `googlehealth.*` |
| 测试模式 7 天 refresh | 存 `refresh_token_expires_at`；到期显示重新授权；不假装长期有效 |
| 首次 Google 不返回 refresh token | 不落库，要求带 `prompt=consent` 重试 |
| 断开后若删连接行会变成新用户 | 软删除，唯一 `health_user_id` 留在原行 |
| 已登录 GET start 变成切账号 | 取消 GET start；POST start 绑定 session |
| PWA 独立窗口丢 cookie | 本切片要求浏览器标签完成授权 |
| `localhost` vs `127.0.0.1` | 文档与 UI 只宣传 `APP_ORIGIN` |
| 密钥丢失 | 无法解密；必须重授权；README 写明 |
| 大陆访问 Google 失败 | 外部前置；失败走 `token_exchange_failed` / `identity_unavailable`，不内置代理 |
| write scope 已授但产品尚未做写回 | 本切片与后续切片在未打开应用内写回开关前不得调用写接口 |

## 15. PR 切分

每个 PR 须可独立测试、不把真实密钥写入仓库。

1. **配置校验与 fail closed**  
   环境解析、配置矩阵、`getCurrentUser` 联合类型、无密钥不生成授权 URL。依赖：无。

2. **加密模块**  
   AES-GCM、AAD、key 校验、previous key。依赖：无。

3. **SQL 迁移与内存仓储假件**  
   四张表的 schema 与 repository 接口；测试用内存实现。依赖：无。

4. **OAuth start/callback 领域逻辑**  
   PKCE、state、scope 列表、`include_granted_scopes` 断言、所有者规则、无 refresh 失败、软删除重连。Google HTTP 全部 mock。依赖：1–3。

5. **HTTP 路由、cookie、账户页**  
   POST start 405 GET、Origin 检查、303 callback、账户 UI 六态、CSP `frame-ancestors`。依赖：4。

6. **首页与 `/api/today` 退出演示回退**  
   OAuth/未配置/未登录路径禁用 `DemoHealthProvider`；更新旧 `demo_user` 测试的适用条件。依赖：5。

7. **Dockerfile + Compose + README**  
   postgres:16、standalone、`.data/` gitignore、`.env.example`、启动时迁移。依赖：5–6。真实 Google 手动验收在本 PR 之后由开发者本地完成。
