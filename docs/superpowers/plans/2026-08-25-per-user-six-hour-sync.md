# 每用户六小时同步 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为每个有效 Google Health 连接提供可靠的 6 小时定时同步和 30 分钟、1 小时、2 小时的失败重试。

**Architecture:** PostgreSQL 在连接行保存下次同步、重试数与短租约。独立 Compose worker 每分钟调用仅限 Docker 内网、bearer secret 保护的内部入口；入口原子认领到期连接并调用现有 14 天同步。收尾只更新仍有效且仍持有租约的连接，因此断开和并发同步不能重排队或复活凭证。

**Tech Stack:** Next.js 16、TypeScript、Node 25 `fetch`、PostgreSQL 16、Docker Compose、Node test runner。

---

### Task 1: 调度状态和原子认领仓储

**Files:**
- Create: `db/migrations/004_connection_sync_schedule.sql`
- Modify: `src/server/auth/types.ts`
- Modify: `src/server/db/postgres-store.ts`
- Modify: `src/server/db/memory-store.ts`
- Create: `tests/server/sync-schedule-store.test.ts`

- [x] **Step 1: 写失败测试：到期的有效连接被认领一次，未到期、断开与有效租约连接不会被认领**

```ts
const first = await store.connections.claimDueSyncs({ now, leaseUntil, limit: 10 });
const second = await store.connections.claimDueSyncs({ now, leaseUntil, limit: 10 });
assert.deepEqual(first.map((row) => row.userId), ['due-user']);
assert.deepEqual(second, []);
```

- [x] **Step 2: 运行 `pnpm test -- tests/server/sync-schedule-store.test.ts`，确认因接口不存在而失败**
- [x] **Step 3: 增加迁移字段与 `ConnectionRow` 字段：`nextSyncAt`、`syncRetryCount`、`syncLeaseUntil`、`lastSyncAttemptAt`；首次迁移把已有有效连接设为可立即同步**
- [x] **Step 4: 在 Postgres 用 `FOR UPDATE SKIP LOCKED` CTE 原子认领，在内存仓储镜像相同语义；实现安全的成功/失败收尾条件更新**
- [x] **Step 5: 重跑针对性测试并勾选**

### Task 2: 调度状态机与授权后的初始同步

**Files:**
- Create: `src/server/health/scheduled-sync.ts`
- Modify: `src/server/health/run-sync.ts`
- Modify: `src/server/auth/oauth-service.ts`
- Modify: `src/server/auth/runtime.ts`
- Modify: `tests/server/run-sync.test.ts`
- Create: `tests/server/scheduled-sync.test.ts`

- [x] **Step 1: 写失败测试：成功后排至 6 小时；连续失败依次排至 30 分钟、1 小时、2 小时；第三次重试失败后回到 6 小时周期**

```ts
await runClaimedSync({ connection, now, syncOne: fail });
assert.equal((await store.connections.findByUserId('u1'))?.nextSyncAt?.toISOString(), '2026-08-24T12:30:00.000Z');
```

- [x] **Step 2: 写失败测试：授权后仅认领该用户的立即同步；断开中的任务不会恢复租约或重新排队**
- [x] **Step 3: 运行上述测试，确认调度器不存在而失败**
- [x] **Step 4: 实现 `runDueSyncs` / `runDueSyncForUser`，复用 `syncUserConnection` 的 14 天范围；只存安全的 `rate_limited` 或 `sync_failed` 错误码**
- [x] **Step 5: 让 OAuth 保存/重授权把该用户设为立即到期，并让 callback 使用单用户调度器代替直接同步**
- [x] **Step 6: 重跑调度与现有同步/OAuth 回归测试并勾选**

### Task 3: 内部入口与 Compose worker

**Files:**
- Create: `src/server/health/sync-auth.ts`
- Create: `app/api/internal/sync/route.ts`
- Create: `worker/sync-loop.mjs`
- Modify: `src/server/config/env.ts`
- Modify: `.env.example`
- Modify: `Dockerfile`
- Modify: `docker-compose.yml`
- Create: `tests/server/sync-auth.test.ts`

- [x] **Step 1: 写失败测试：内部入口缺失 bearer secret 或 secret 不匹配时拒绝；匹配时允许执行**
- [x] **Step 2: 运行 `pnpm test -- tests/server/sync-auth.test.ts`，确认认证模块不存在而失败**
- [x] **Step 3: 将 `SYNC_SECRET` 作为 OAuth 完整配置的必填高熵 secret；用常量时间比较实现内部 bearer 验证**
- [x] **Step 4: 新增内部 POST 路由，返回仅含认领/成功/失败计数的 JSON；不得返回 user ID、token、原始健康数据或错误正文**
- [x] **Step 5: 新增 worker，每分钟用内部 Compose DNS 调用入口；Docker runner 复制 worker，Compose 增加无端口的 `sync` 服务并等待 `app` 健康检查**
- [x] **Step 6: 重跑认证测试并运行 `docker compose --env-file .env.example config --quiet`，勾选**

### Task 4: 文档、完整验证与提交

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-08-25-per-user-six-hour-sync-design.md`
- Modify: `docs/superpowers/plans/2026-08-25-per-user-six-hour-sync.md`

- [x] **Step 1: 更新 README：首次授权立即同步、之后每用户 6 小时、受限重试与无手动刷新按钮；列出 `SYNC_SECRET` 生成方式**
- [x] **Step 2: 更新设计状态与实际验证结果，逐项勾选计划**
- [x] **Step 3: 依次运行 `pnpm test`、`pnpm lint`、`pnpm build`、`docker compose --env-file .env.example config --quiet` 和 `git diff --check`（全部通过）**
- [x] **Step 4: 检查 staged diff，无凭证或原始健康数据后提交**
