# TRIMP 全天心肺负荷 v3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用公开 Banister HRR-TRIMP 变体替换首页 v2 Strain，持续计算实际全天负荷、恢复状态下的今日可用负荷，以及随完成量自然跟随的本周提升基线。

**Architecture:** v3 保持与 `whoop-style-v2` 分表、分版本存储。同步层把 75 秒 hold 后按分钟裁剪的派生 BPM 片段持久化；服务端在这些片段与动作/睡眠区间的真实交集上计算 TRIMP，所有日/周/容量结果可由持久化输入重放。Dashboard 仅接收聚合 v3 DTO，绝不返回 BPM 片段或原始 Google 数据。

**Tech Stack:** Next.js 16、TypeScript、Zod、Node test runner (`tsx --test`)、PostgreSQL 16、内存测试 store。

---

## Locked product rules

- 算法版本为 `cardio-load-trimp-v3`。不得将 v3 映射成 WHOOP 风格 0–21 分数，也不得覆盖 v2 行。
- `dailyLoad` 是实际发生的 TRIMP；Recovery 只能改变 `usableLoad` 和使用率，不能回写或缩减 `dailyLoad`。
- HRR 采用 `0.64 × hrr × exp(k × hrr)`；male `k=1.92`、female `k=1.67`；只累计 `hrr >= 0.30`。`HRmax_est <= RHR_base` 为可解释的 `invalid_hr_reserve`，不出分。
- 资格时长是 HR 覆盖、active `activity-level`/exercise、以及清醒时间三者的毫秒交集；少于 30 秒不累计，`HR_m` 只从交集内 BPM 片段加权得到。
- 周 `weeklyLoad` 仅在当地周 7 个完成日均为 `qualifiedDay` 时存在；部分周只显示 `weekToDateLoad`，绝不能进入 RM4/EWMA4。基线为连续四周的 `max(RM4, EWMA4)`，`EWMA4` 的 alpha 为 0.4。
- 恢复适配仅在严格早于目标日的 28 个高质量完成日都可用、且**目标日 v2 Recovery 数据质量为 `medium` 或 `high`**时计算；`provisional`、`unavailable` 或过期数据只能显示校准/未知，绝不套 P80/P90 或固定乘数。可靠但恢复**分数低**的目标日必须进入个人低恢复层；容量按该层条件分布计算，可能更低、相同或更高，绝不施加人为的单调折扣。同恢复层 P80 与全局 P90 的较小值为 `usableLoad`。
- v2 Recovery 是版本化、可重算输入。任何影响其输入或滚动基线的更新，须从最早受影响日向后重算至保留窗口末尾；不得错误截断在固定 28 个日历日。

## Task 1: 建立可重放的 v3 领域模型与纯计算

**Files:**
- Create: `src/domain/cardio-load-trimp.ts`
- Create: `tests/domain/cardio-load-trimp.test.ts`
- Modify: `src/domain/metric-types.ts`

- [ ] **Step 1: 写 TRIMP 与资格交集的失败测试**

  在 `tests/domain/cardio-load-trimp.test.ts` 定义最小派生 BPM 片段、active/exercise、sleep 测试夹具。断言：30 秒交集只贡献半分钟；29.999 秒不贡献；交集内的 BPM 而非整分钟平均值决定 HRR；睡眠仅由 exercise 覆盖时可累计；阈值 30% HRR、性别常数、非线性增长、`HRmax <= RHR` 均有确定结果。

- [ ] **Step 2: 运行失败测试**

  Run: `npm test -- tests/domain/cardio-load-trimp.test.ts`

  Expected: FAIL，因为 `cardio-load-trimp` 尚不存在。

- [ ] **Step 3: 实现最小纯函数**

  在 `src/domain/cardio-load-trimp.ts` 实现并导出：

  - `CARDIO_LOAD_TRIMP_VERSION`；
  - `deriveQualifiedHeartRate`（片段与两个区间集合的精确交集，返回秒数和交集 BPM 均值）；
  - `computeDailyTrimp`（RHR/HRmax/sex/分钟资格/原因状态）；
  - `isQualifiedDay`（IANA、主睡眠边界、12 小时 HR 覆盖、清醒覆盖 ≥70%、最大缺口 ≤4 小时）；
  - `computeWeeklyBuildBaseline`（完整周、RM4、EWMA4、冻结/临时状态）；
  - `computeUsableLoad`（严格历史、nearest-rank 三分位、P80/P90、零除保护，以及目标日 Recovery 数据质量 `medium/high` 的显式准入；低分数仍进入 low tier）。

  每个结果必须带稳定、机器可读的 `status`/`reason`、输入数量及指标版本。使用内部区间 union/clip 辅助函数，禁止依赖 Next 或数据库。

- [ ] **Step 4: 运行领域测试**

  Run: `npm test -- tests/domain/cardio-load-trimp.test.ts`

  Expected: PASS。

- [ ] **Step 5: 扩充边界测试并提交**

  增加相同分位边界、样本少于 7、少于 28 历史、目标日为 provisional/unavailable/过期时不适配、可靠低恢复分数时进入 low tier、low tier P80 不低于其他层时不强制下调、低覆盖日、漏戴周、一次高周与持续高周用例；运行该测试后提交：

  ```bash
  git add src/domain/cardio-load-trimp.ts src/domain/metric-types.ts tests/domain/cardio-load-trimp.test.ts
  git commit -m "feat: add TRIMP cardio load domain model"
  ```

## Task 2: 增加 v3 专属存储与派生心率证据

**Files:**
- Create: `db/migrations/014_cardio_load_trimp_v3.sql`
- Modify: `src/domain/cardio-records.ts`
- Modify: `src/server/health/cardio-store.ts`
- Modify: `src/server/db/memory-store.ts`
- Modify: `src/server/db/postgres-store.ts`
- Create: `tests/server/cardio-load-store.test.ts`
- Modify: `tests/server/postgres-cardio-store.test.ts`

- [ ] **Step 1: 写 schema/store 失败测试**

  覆盖：v3 表能与 v2 `daily_cardio` / `metric_results` 并存；minute evidence 仅接受分钟内的有序 `{startOffsetMs,endOffsetMs,bpm}` 派生片段；v3 日负荷、周基线、容量按 `(user, date/week, version)` upsert；连接级 v3 bootstrap 能区分 `pending` / 可重试失败 / `completed` 且有输入版本和完成时间；删除用户清理全部 v3 表及 bootstrap；Postgres 查询始终带 user scope。

- [ ] **Step 2: 运行失败测试**

  Run: `npm test -- tests/server/cardio-load-store.test.ts tests/server/postgres-cardio-store.test.ts`

  Expected: FAIL，因为 v3 schema、类型与 store 方法不存在。

- [ ] **Step 3: 写迁移和验证类型**

  `014_cardio_load_trimp_v3.sql` 新建：

  - `heart_rate_minute_evidence`：`user_id/source_family/minute_start_utc` 主键和 JSONB 派生 BPM segments；
  - `daily_cardio_loads`：版本化 daily TRIMP、资格/未验证秒数、RHR 基线、观测 HRmax provenance、质量及 fingerprint；
  - `weekly_cardio_baselines`：版本化 RM4/EWMA4/基线、校准状态、输入 fingerprint；
  - `daily_load_capacities`：实际/可用负荷、使用率、恢复层、回退状态和 Recovery version/date/fingerprint；
  - `cardio_load_bootstraps`：以 `(connection_id, version)` 唯一的持久化 bootstrap 状态（`pending` / `failed` / `completed`）、尝试/完成时间、错误码与输入版本。

  在 `cardio-records.ts` 添加严格 Zod parsers/导出类型；禁止非有限数、越界片段、空 provenance 或非 v3 version。

- [ ] **Step 4: 扩展 store 实现**

  将 evidence、三种 v3 结果和连接级 bootstrap 状态作为 `HealthMetricsStore` 的显式读写 API，实现 Postgres SQL mapping、内存 store clone/transaction/delete 路径。bootstrap 的成功写入必须能与相关 cursor/派生结果同一事务围栏；失败保留可重试信息。不得改动 v2 的表约束或用 v2 `metric_results` 承载 v3。

- [ ] **Step 5: 运行存储测试并提交**

  Run: `npm test -- tests/server/cardio-load-store.test.ts tests/server/postgres-cardio-store.test.ts`

  Expected: PASS。

  ```bash
  git add db/migrations/014_cardio_load_trimp_v3.sql src/domain/cardio-records.ts src/server/health/cardio-store.ts src/server/db/memory-store.ts src/server/db/postgres-store.ts tests/server/cardio-load-store.test.ts tests/server/postgres-cardio-store.test.ts
  git commit -m "feat: persist versioned TRIMP cardio load"
  ```

## Task 3: 由同步片段计算、回填与级联重算 v3

**Files:**
- Modify: `src/domain/whoop-style-metrics.ts`
- Modify: `src/server/health/cardio-map.ts`
- Modify: `src/server/health/cardio-sync.ts`
- Create: `src/server/health/cardio-load-recompute.ts`
- Modify: `src/server/health/cardio-reindex.ts`
- Modify: `src/server/health/strain-provenance.ts`
- Modify: `src/server/health/run-sync.ts`
- Modify: `src/server/health/google-health-provider.ts`
- Modify: `src/server/health/snapshot-store.ts`
- Modify: `tests/server/cardio-map.test.ts`
- Modify: `tests/server/cardio-sync.test.ts`
- Create: `tests/server/cardio-load-recompute.test.ts`
- Modify: `tests/server/health-provider.test.ts`

- [ ] **Step 1: 写同步/重算失败测试**

  覆盖：75 秒 hold 按分钟裁剪成派生 evidence；后到的 activity/sleep interval 能利用 evidence 重算，且不保存 API 原始 point；HRmax 候选**仅**来自 `google-wearables`、非睡眠、分钟覆盖 ≥30 秒、`sampleCount >= 1`、100–230 bpm 的历史峰值（不要求动作证据），并保存峰值 provenance；新高的合格 HRmax 触发所有保留 v3 日/周/容量重算；HRV/RHR/睡眠/sleep goal/Recovery 输入改变从最早影响日一路级联到当前窗口；初次 HR/activity 回填为至少 42 个当地日；已有 cursor 的连接也会因 v3 bootstrap 标记执行一次 42 日强制回拉，且 snapshot 保留同步提升到 42 日。

- [ ] **Step 2: 运行失败测试**

  Run: `npm test -- tests/server/cardio-map.test.ts tests/server/cardio-sync.test.ts tests/server/cardio-load-recompute.test.ts`

  Expected: FAIL，因为 evidence 写入与 v3 replayer 尚未接入同步。

- [ ] **Step 3: 从现有 75 秒 hold 产出派生 evidence**

  保持 `aggregateHeartRateMinutes` 的 v2 行为不变，同时从其已有 `coverageIntervals` 输出按分钟裁剪、归一化的 v3 evidence。`cardio-map.ts` 返回 minute aggregate 与 evidence 的成对结果；`cardio-sync.ts` 在同一事务/lease 围栏内写入两者。任何名为 raw sample 的公开 store API 均不得新增。

- [ ] **Step 4: 实现 v3 replayer**

  在 `cardio-load-recompute.ts`：

  - 从持久化 minute evidence、activity、exercise、sleep、每日 RHR、profile sex 与已保存 v2 Recovery 读取输入；
  - 计算用户当前合格历史观测 HRmax（只接受 `google-wearables`、非睡眠、分钟覆盖 ≥30 秒、`sampleCount >= 1`、100–230 bpm；**不**把动作证据作为候选条件）和每个日期严格过去的 RHR 基线，并保存触发峰值的来源、分钟、值和计算 fingerprint；
  - 从最早影响日重放到保留窗口末尾 daily loads，再写 capacities，最后写 weekly baselines；
  - 在缺失、时区歧义、未完成日及无合格动作时写入文档规定的 `—`/0/校准状态；
  - 保存 deterministic fingerprint 和计算上下文，且不在 Dashboard request 路径访问 Google API。

  复用 `recomputeAffectedDays` 的 v2 重算顺序；v3 仅在 v2 Recovery 已更新后读取它。将 `metricsAffectedByStrainRecompute` 扩为能返回 v3 失效起点的显式 helper，而不是使用 `+28 calendar days` 猜测范围。

- [ ] **Step 5: 扩展回填、bootstrap 和时区重索引**

  初次同步把 HR/activity 起点扩至 ≥42 当地日的足够 UTC 包络，并把 `HEALTH_SNAPSHOT_RETAIN_CIVIL_DAYS` 提升至 42。为每个已连接用户增加可持久化、一次性的 `cardio-load-trimp-v3` bootstrap 状态：即使已有成功 cursor，也强制回拉 42 日所需的 HR/activity/sleep/RHR/HRV；启动前写 `pending`，失败写 `failed` 并保留错误码以便重试，只有全部核心查询、snapshot 持久化及 replayer 在同一 lease/事务围栏成功后写 `completed`。失败不能推进成功 watermark 或清空旧 snapshot。时区修改、sleep/recovery revision 和 HRmax 更新都调用 v3 replayer。更新已有 35 日断言、原始数据不持久化断言，使其允许派生 evidence、仍禁止 Google response/point metadata。

- [ ] **Step 6: 运行同步测试并提交**

  Run: `npm test -- tests/server/cardio-map.test.ts tests/server/cardio-sync.test.ts tests/server/cardio-load-recompute.test.ts`

  Expected: PASS。

  ```bash
  git add src/domain/whoop-style-metrics.ts src/server/health/cardio-map.ts src/server/health/cardio-sync.ts src/server/health/cardio-load-recompute.ts src/server/health/cardio-reindex.ts src/server/health/strain-provenance.ts src/server/health/run-sync.ts src/server/health/google-health-provider.ts src/server/health/snapshot-store.ts tests/server/cardio-map.test.ts tests/server/cardio-sync.test.ts tests/server/cardio-load-recompute.test.ts tests/server/health-provider.test.ts
  git commit -m "feat: recompute TRIMP load from synced evidence"
  ```

## Task 4: 暴露安全 v3 Dashboard DTO 与移动首页

**Files:**
- Create: `src/server/dashboard/cardio-load-timeline.ts`
- Modify: `src/server/dashboard/build-today.ts`
- Modify: `src/server/dashboard/today-response.ts`
- Modify: `src/ui/dashboard/editorial-homepage.tsx`
- Modify: `app/globals.css`
- Modify: `tests/server/build-today.test.ts`
- Modify: `tests/server/today-response.test.ts`
- Modify: `tests/ui/today-dashboard.test.ts`

- [ ] **Step 1: 写 Dashboard 失败测试**

  测试 OAuth 首页仅返回 v3 聚合字段（TRIMP、可用负荷、使用率、周基线、当周进度、数据质量、观测截至）；不返回 evidence BPM、OAuth 或原始 Health payload。测试状态文案：缺输入是 `—` 而非零；当天为进行中；周不完整冻结；目标日 Recovery 数据质量为 `medium/high` 时容量可随 recovery tier 变化、但实际 TRIMP 不变，provisional/unavailable/过期时不适配。锁定图表三态：未观测、未验证升高心率、已验证负荷必须显式可分；仅完整闭合日确认无合格活动才是 `0.0 TRIMP`。

- [ ] **Step 2: 运行失败测试**

  Run: `npm test -- tests/server/build-today.test.ts tests/server/today-response.test.ts tests/ui/today-dashboard.test.ts`

  Expected: FAIL，因为 v3 DTO 和 UI 尚不存在。

- [ ] **Step 3: 构建服务端投影和 timeline**

  `build-today.ts` 优先读取 `cardio-load-trimp-v3` 结果并新增 `cardioLoad` DTO；旧 `strain` 只作为未迁移帐户的兼容内部数据，不与 v3 混在同一数值字段。`cardio-load-timeline.ts` 从日 TRIMP 的聚合 buckets 形成已观测阶梯/缺口信息，绝不返回 BPM。`today-response.ts` 只 allowlist 新 DTO。

- [ ] **Step 4: 更新移动首页**

  保持已选绿色移动单画布视觉语言，首页把 `/21` 与 v2 Strain 文案替换为：

  - `全天心肺负荷 · X.X TRIMP`；
  - `今日可用负荷` 与恢复已纳入标记/使用率；
  - `本周提升基线` 与 `weekToDateLoad`；
  - 无数据/校准/不完整周的事实性说明。

  禁止“安全”“过度训练”“可以加练”等医疗/许可表述。现有 Recovery/身体年龄组件继续工作；不新增桌面布局。

- [ ] **Step 5: 运行 Dashboard 测试并提交**

  Run: `npm test -- tests/server/build-today.test.ts tests/server/today-response.test.ts tests/ui/today-dashboard.test.ts`

  Expected: PASS。

  ```bash
  git add src/server/dashboard/cardio-load-timeline.ts src/server/dashboard/build-today.ts src/server/dashboard/today-response.ts src/ui/dashboard/editorial-homepage.tsx app/globals.css tests/server/build-today.test.ts tests/server/today-response.test.ts tests/ui/today-dashboard.test.ts
  git commit -m "feat: show TRIMP cardio load on dashboard"
  ```

## Task 5: 迁移验证、完整回归与上线准备

**Files:**
- Modify: `tests/integration/postgres-homepage-provenance.test.ts`
- Modify: `tests/server/postgres-scheduled-sync-fencing.test.ts`
- Modify: `docs/superpowers/specs/2026-09-04-trimp-cardio-load-build-target-design.md`
- Modify: `README.md`（仅在已有运行说明中补充需要的回填/指标说明；若不存在相关段落则不创建无关文档）

- [ ] **Step 1: 写迁移安全失败测试**

  断言 migration 014 不修改 v2 check/主键、可对已有用户建表、断开连接级联清理 v3 数据；调度同步在小时运行中不访问 UI、正常回补最近窗口、且输入变化按 v3 规则重算。

- [ ] **Step 2: 运行失败测试**

  Run: `npm test -- tests/integration/postgres-homepage-provenance.test.ts tests/server/postgres-scheduled-sync-fencing.test.ts`

  Expected: FAIL，直到迁移/清理/调度断言完成。

- [ ] **Step 3: 完成文档与测试**

  将设计文档状态更新为“已实施”，如实现中发现公开资料无法支撑某一参数，移除该行为并记录限制，不能私自补公式。更新已有运行说明中的 42 天首同步回填和稳定基线要求。

- [ ] **Step 4: 全量验证**

  Run:

  ```bash
  npm test
  npm run lint
  npm run build
  ```

  Expected: tests 0 failed；TypeScript 0 errors；Next production build succeeds。若配置了 `POSTGRES_INTEGRATION_BASE_URL`，另运行 PostgreSQL 集成测试；未配置时明确报告其跳过，不把跳过说成通过。

- [ ] **Step 5: 审阅并提交**

  提交前执行 `git diff --check`、请求独立代码审阅并修复 P0/P1。随后只暂存 v3 相关文件：

  ```bash
  git add db/migrations/014_cardio_load_trimp_v3.sql src tests docs README.md
  git commit -m "feat: implement TRIMP cardio load v3"
  ```
