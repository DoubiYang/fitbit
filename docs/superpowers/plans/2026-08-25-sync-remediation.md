# 真实数据同步整改 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Google Health 的 Fitbit Air 同步在失败、断开和缺失数据时不产生虚假或越权的健康结论。

**Architecture:** 保持快照读取模型，但把一次同步定义为原子完整版本：查询或持久化失败时保留旧版本。OAuth callback 传递内部用户 ID 并只做该用户 14 天热同步；快照写入在数据库端检查连接仍有效，以防断开后的在飞行同步写回。

**Tech Stack:** Next.js 16、TypeScript、Node test runner、PostgreSQL 16、Docker Compose、Google Health API v4。

---

### Task 1: 建立整改记录与同步验收测试

**Files:**
- Create: `docs/superpowers/specs/2026-08-25-sync-remediation-design.md`
- Modify: `tests/server/health-provider.test.ts`
- Modify: `tests/server/run-sync.test.ts`

- [x] **Step 1: 记录整改范围与验收标准**
- [x] **Step 2: 写入失败请求不得推进成功时间或调用快照保存的失败测试**
- [x] **Step 3: 运行该测试，确认现有实现失败**
- [x] **Step 4: 实现最小原子同步修复**
- [x] **Step 5: 运行针对性测试并勾选**

### Task 2: 仅同步当前授权用户

**Files:**
- Modify: `src/server/auth/types.ts`
- Modify: `src/server/auth/oauth-service.ts`
- Modify: `src/server/auth/http.ts`
- Modify: `src/server/auth/runtime.ts`
- Modify: `src/server/health/run-sync.ts`
- Delete: `app/api/internal/sync/route.ts`
- Modify: `docker-compose.yml`
- Modify: `tests/server/auth-http.test.ts`
- Modify: `tests/server/run-sync.test.ts`

- [x] **Step 1: 写入 callback 只触发返回 userId 的失败测试**
- [x] **Step 2: 运行测试，确认现有实现会调用全量同步**
- [x] **Step 3: 提供按 userId 查询和 14 天热同步函数，移除全量 cron 调用**
- [x] **Step 4: 运行针对性测试并勾选**

### Task 3: 数据源、错误语义与断开删除围栏

**Files:**
- Modify: `src/server/health/health-api.ts`
- Modify: `src/server/health/access-token.ts`
- Modify: `src/server/health/snapshot-store.ts`
- Modify: `src/server/auth/types.ts`
- Modify: `src/server/db/postgres-store.ts`
- Modify: `src/server/db/memory-store.ts`
- Modify: `src/server/auth/oauth-service.ts`
- Modify: `tests/server/health-provider.test.ts`
- Create: `tests/server/access-token.test.ts`
- Modify: `tests/server/oauth-service.test.ts`

- [x] **Step 1: 写入 wearable 数据源族与 reconcile 不应吞认证/暂态错误的失败测试**
- [x] **Step 2: 写入断开会删除快照、断开连接不允许保存快照，以及刷新 token 期间断开不得复活凭证的失败测试**
- [x] **Step 3: 运行测试，确认现有实现失败**
- [x] **Step 4: 最小实现来源参数、条件快照/token 写入与事务删除**
- [x] **Step 5: 运行针对性测试并勾选**

### Task 4: 保守睡眠与训练完整日映射

**Files:**
- Modify: `src/server/health/map-records.ts`
- Modify: `src/server/health/google-health-provider.ts`
- Modify: `tests/server/map-records.test.ts`
- Modify: `tests/server/health-provider.test.ts`

- [x] **Step 1: 写入缺少实际睡眠分钟、nap、未处理 sleep 的失败测试**
- [x] **Step 2: 写入成功查询区间的零负荷与未知训练日失败测试**
- [x] **Step 3: 运行测试，确认现有实现失败**
- [x] **Step 4: 最小实现保守映射与日期覆盖传递**
- [x] **Step 5: 运行针对性测试并勾选**

### Task 5: 10-scope 授权契约与文档收口

**Files:**
- Modify: `tests/server/oauth-url.test.ts`
- Modify: `README.md`
- Modify: `src/ui/account/account-panel.tsx`
- Modify: `docs/superpowers/specs/2026-08-24-05-oauth-account-docker-design.md`
- Modify: `docs/superpowers/specs/2026-08-23-02-google-health-api-validation-design.md`
- Modify: `docs/implementation/p1-foundation.md`

- [x] **Step 1: 将 OAuth URL 测试改为显式固定的 10-scope 列表，防止未来无意收缩或漂移**
- [x] **Step 2: 记录用户决定：10 个 scope 为首次授权契约，不将其改为三项最小读取集**
- [x] **Step 3: 更新账户文案、配置与设计文档，明确当前只做单用户 14 天热同步，营养写回与 AI Coach 未实现**
- [x] **Step 4: 运行 OAuth 与账户页针对性回归测试并通过**

### Task 6: 全量验收与提交

**Files:**
- Modify: `docs/superpowers/specs/2026-08-25-sync-remediation-design.md`
- Modify: `docs/superpowers/plans/2026-08-25-sync-remediation.md`

- [x] **Step 1: 运行 `pnpm test`（76/76 通过）**
- [x] **Step 2: 运行 `pnpm lint`、`pnpm build` 和 `docker compose --env-file .env.example config --quiet`（全部通过）**
- [x] **Step 3: 逐项记录实际命令和结果，完成设计与计划中的复选框**
- [x] **Step 4: 检查 diff 后提交本次整改（`5af3db0`）**
