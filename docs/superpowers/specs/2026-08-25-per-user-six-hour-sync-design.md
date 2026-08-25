# 每用户六小时同步设计

**状态：** 已完成
**日期：** 2026-08-25  
**目标：** 已连接用户在首次授权后的初始同步之外，每 6 小时同步一次 Google Health 数据；失败按受限退避重试，同时保持现有快照与断开安全边界。

## 范围

- 仅调度 `active` 和 `partial` 的连接；`disconnected`、`expired` 连接绝不入队。
- 每次仍同步最近 14 天的睡眠、每日 HRV、每日静息心率和训练，并固定限定 `google-wearables` 数据源。
- 成功后，下次同步时间为成功时刻加 6 小时。
- 失败后依次在 30 分钟、1 小时、2 小时后重试；同一成功周期内最多三次重试。最后一次失败后，回到下一正常的 6 小时周期。
- 初次 OAuth 成功仍立即尝试同步；它与定时任务共用同一调度状态机。

本次不增加前端“立即同步”按钮、webhook、历史回填、营养写回或 AI Coach。

## 方案

Docker Compose 增加一个独立的 `sync` worker。它每分钟唤醒一次，查询到期连接并在数据库事务中原子认领；worker 可重启，且即使将来误启动多个实例也不会让同一用户并发同步。

不采用 Next.js 进程内 `setInterval`：该方案会受请求进程重启影响，且多实例会重复执行。不采用外部云 cron：当前项目是本地 Compose 部署，额外公网鉴权没有必要。

## 数据模型与状态机

在 `google_health_connections` 增加：

| 字段 | 含义 |
| --- | --- |
| `next_sync_at` | 下次允许同步的时间；连接成功时为当前时间，成功或最终失败后推进。 |
| `sync_retry_count` | 自上次成功以来的失败重试次数，范围 0–3。 |
| `sync_lease_until` | worker 认领任务的租约截止时间，防止并发重复执行。 |
| `last_sync_attempt_at` | 最近一次实际尝试时间，仅用于状态与排障。 |

认领 SQL 只选择 `status IN ('active', 'partial')`、`next_sync_at <= now` 且没有有效租约的行，并用行锁更新租约。同步完成后：

- 成功：更新现有 `last_successful_sync_at`，清零 `sync_retry_count`，写入 `next_sync_at = now + 6h`，清租约；
- 失败且次数小于 3：增加次数，`next_sync_at` 设为对应退避时间，清租约；
- 第三次重试仍失败：重置次数，`next_sync_at = now + 6h`，清租约；
- 用户在同步中断开：已有条件 token/快照写入会失败；收尾更新必须同样以连接仍有效为条件，不能复活连接或再次排队。

`last_error_code` 只保存安全分类（如 `sync_failed`、`rate_limited`），不保存 Google 原始响应、token 或健康记录。

## 运行与可观察性

`sync` worker 与 `app`、`db` 一同由 Compose 启动，使用内部网络调用受共享密钥保护的应用内部同步入口。该入口不暴露给浏览器，且只接受 worker 身份。worker 每分钟认领有限数量的到期连接并按顺序执行，避免请求峰值与 API 限流。

初始授权的同步也走相同的“结果收尾”逻辑：成功后排到 6 小时后，失败后进入 30 分钟重试。账户页后续可复用 `last_sync_attempt_at`、`last_successful_sync_at` 和安全错误码展示状态，但本设计不新增 UI。

## 验收与测试

1. 新授权用户立即同步成功后，直到 6 小时到期前不会再次被 worker 认领。
2. 到期用户只能被一个 worker 认领；仍在租约中的用户不重复执行。
3. 失败按 30 分钟、1 小时、2 小时重试；第三次重试失败后回到 6 小时周期。
4. 过期、断开、无 token 的连接永不被认领；同步中断开后不会留下有效租约或新的同步计划。
5. 快照与 token 的原子性、来源限制和 14 天范围保持原有回归测试通过。
6. Compose 中 worker 不对宿主机开放端口；内部同步入口缺少或错误凭证时拒绝。

## 验证记录

- `pnpm test`：82/82 通过，覆盖到期认领、租约排重、6 小时成功周期、30 分钟/1 小时/2 小时重试、断开围栏与内部 bearer 校验。
- `pnpm lint`：通过（`tsc --noEmit`）。
- `pnpm build`：通过，包含动态内部路由 `/api/internal/sync`。
- `docker compose --env-file .env.example config --quiet` 与 `git diff --check`：通过。
