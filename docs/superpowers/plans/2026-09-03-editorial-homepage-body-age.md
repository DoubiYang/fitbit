# 编辑式首页与身体年龄整合 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将已确认的「节律」编辑式首页落实为移动端优先的真实数据界面：恢复、全天心肺负荷、身体年龄、事实性提示与记录餐食在同一阅读流中，同时不向浏览器暴露原始健康测量值。

**Architecture:** `buildTodayView` 先从现有持久化指标、分钟聚合和睡眠快照创建只读、用户范围内的首页投影；日内观测强度只有在与保存 Strain 同一批输入可重放且 provenance 相符时才存在。客户端只消费该 allowlist 投影，不获取 Google 数据、不重算 Strain，也不拿到 BPM、HRV、RHR、区间阈值或证据数值。React 组件以编辑式排版组合恢复、负荷、身体年龄与单一行动，CSS 负责 390px 和宽屏网格。

**Tech Stack:** Next.js App Router、React、TypeScript、PostgreSQL 16、现有 whoop-style-v2 纯函数、lucide-react、node:test、JSDOM。

---

### Task 1: 建立首页专用的安全指标投影

**Files:**
- Modify: `src/server/dashboard/build-today.ts`
- Modify: `src/server/dashboard/today-response.ts`
- Modify: `tests/server/build-today.test.ts`
- Modify: `tests/server/today-response.test.ts`

- [x] **Step 1: 先为首页 JSON 写失败测试**

在 `tests/server/today-response.test.ts` 增加一个 OAuth 夹具，令内部 Strain 结果包含 `MetricEvidence.value`、心率区间与活动剂量；断言首页响应有 `homepage` allowlist，而 JSON 不含 `evidence`、`value`、`heartRateZones`、`timeInZone`、`dose`、BPM、token 或任何其他用户的指标。页面/RSC 的安全测试和实际接线留给 Task 3，在切换 `TodayDashboard` 的同一个可构建提交完成。

- [x] **Step 2: 运行该测试确认它因当前广泛 DTO 失败**

Run: `pnpm exec tsx --test tests/server/today-response.test.ts`

Expected: FAIL，因为当前 `TodayView` 会透传 evidence 与负荷的诊断字段。

- [x] **Step 3: 添加最小的 homepage DTO 映射**

在 `build-today.ts` 定义 `HomepageTodayView` 及单一 `toHomepageTodayView()`：只含当地日期、freshness、保守 action 文案、每个核心指标的 label/score/status 或 quality/detail，以及现有净化 `bodyAge` DTO。`buildTodayResponse` 调用该映射；Task 3 再以同一映射接通 `app/page.tsx` 与 `TodayDashboard`，避免本任务留下输入类型不兼容的半成品。无分数一律 `null`，不得转换为 0；内部宽 DTO 仅留在服务端计算与非首页诊断使用。

- [x] **Step 4: 重跑针对性服务端测试**

Run: `pnpm exec tsx --test tests/server/build-today.test.ts tests/server/today-response.test.ts`

Expected: PASS，且新增断言证明首页 DTO 没有原始测量或跨用户数据。

- [x] **Step 5: 提交安全投影切片**

```bash
git add src/server/dashboard/build-today.ts src/server/dashboard/today-response.ts tests/server/build-today.test.ts tests/server/today-response.test.ts
git commit -m "feat: add safe editorial homepage projection"
```

### Task 2: 以相同 Strain 输入构建可信的日内观测时间线

**Files:**
- Modify: `src/domain/cardio-records.ts`
- Modify: `src/domain/whoop-style-metrics.ts`
- Modify: `src/server/health/cardio-store.ts`
- Modify: `src/server/health/cardio-sync.ts`
- Modify: `src/server/db/memory-store.ts`
- Modify: `src/server/db/postgres-store.ts`
- Create: `db/migrations/013_homepage_strain_provenance.sql`
- Create: `src/server/dashboard/strain-timeline.ts`
- Modify: `src/server/dashboard/build-today.ts`
- Modify: `tests/domain/whoop-style-metrics.test.ts`
- Create: `tests/server/strain-timeline.test.ts`
- Modify: `tests/server/cardio-sync.test.ts`
- Modify: `tests/server/postgres-cardio-store.test.ts`

- [x] **Step 1: 写入 timeline/fingerprint 的失败测试**

在 `tests/server/strain-timeline.test.ts` 写入固定分钟、活动、exercise、sleep 与时区历史夹具；断言 15 分钟 bucket 按 UTC 排序、仅输出 `intensity` 和覆盖计数、exercise 覆盖睡眠的归因优先级与 whoop-style-v2 一致。完整且一致的春季/秋季 DST 夹具必须分别产生 92/100 bucket，重复本地小时的 label 携带 UTC offset，并验证 observed-through；另写缺少睡眠、future bucket、指标 fingerprint/context 不同会返回 `undefined` 的测试。

- [x] **Step 2: 运行新测试确认失败**

Run: `pnpm exec tsx --test tests/server/strain-timeline.test.ts`

Expected: FAIL，因为生产代码尚未有 timeline 构造器或 provenance 数据。

- [x] **Step 3: 提取且复用 Strain 的归因纯函数**

将现有心率分钟、活动 interval、exercise 与 sleep 优先级的判定提取成无 I/O 纯函数；Strain 分数计算与 timeline 都调用它。测试同一夹具的归因分钟与强度分类一致；不更改 whoop-style-v2 分数公式。

- [x] **Step 4: 增加不可变 provenance 存储**

迁移为 `daily_cardio` 和 Strain `metric_results` 增加独立可空的 `provenance_version smallint`、`input_fingerprint`、`calculation_context`；绝不复用现有 `whoop-style-v2` metric version 区分新旧行。013 先以 `provenance_version IS NULL` 兼容既有 012 数据：历史行没有 provenance，timeline 读取一律 fail-closed。用 `CHECK (provenance_version IS NULL OR (provenance_version = 1 AND input_fingerprint IS NOT NULL AND input_fingerprint ~ '^sha256:[a-f0-9]{64}$' AND calculation_context IS NOT NULL AND jsonb_typeof(calculation_context) = 'object'))` 约束新的 Strain 双写，显式拒绝 `NULL`、空白和伪 fingerprint，而不是会阻断旧行的全表 `NOT NULL`。同时为 `metric_results` 增加 `quality_flags text[]`：`sleep_performance` 在重算时持久化 `sleep_history_incomplete`，Recovery 读取同一 flag 决定首页的 allowlisted 数据质量文案。`cardio-sync.ts` 的 `recomputeAffectedDays` 是唯一生产写入点：它在同一事务中给 `daily_cardio` 与 Strain `metric_results` 保存相同 canonical SHA-256、完整不可变 `calculation_context`（`as_of_utc`、is-current-day、当地日长度、时区明确性、完整时区历史 fingerprint 与 metric version）、`provenance_version: 1`；同时传入 DST 当地日长度。store 接口只允许 lease/用户范围内的原子写入。

- [x] **Step 5: 实现 fail-closed 的只读 timeline 投影**

`strain-timeline.ts` 只在 Strain 有分、sync fresh、minute/zones/sleep 输入足够，且 `daily_cardio` 与 Strain 都为 `provenance_version: 1`、两处保存 fingerprint 完全相等、两处保存的 context deep-equal，并以**保存的** `as_of_utc`、当地日长度与时区历史重放出相同 fingerprint/context 时，返回 `StrainTimeline`。测试 current-day cutoff、时区历史、任何 context 字段和 fingerprint 的单独变化均必须省略时间线。未来段、未知段与不可归因段保持为 `null`/无强度，不画预测，不传 BPM 或原始采样点。

- [x] **Step 6: 跑领域、timeline、store 与 migration 测试**

Run: `pnpm exec tsx --test tests/domain/whoop-style-metrics.test.ts tests/server/strain-timeline.test.ts tests/server/cardio-sync.test.ts tests/server/build-today.test.ts tests/server/postgres-cardio-store.test.ts`

Expected: PASS；DST、fingerprint/context 不一致、缺睡眠与未来数据均 fail closed；`sleep_history_incomplete` 只经质量 flag 影响首页文案；空或伪 fingerprint 被数据库拒绝。

- [x] **Step 7: 提交 provenance 与 timeline 切片**

```bash
git add src/domain/cardio-records.ts src/domain/whoop-style-metrics.ts src/server/health/cardio-store.ts src/server/health/cardio-sync.ts src/server/db/memory-store.ts src/server/db/postgres-store.ts db/migrations/013_homepage_strain_provenance.sql src/server/dashboard/strain-timeline.ts src/server/dashboard/build-today.ts tests/domain/whoop-style-metrics.test.ts tests/server/strain-timeline.test.ts tests/server/cardio-sync.test.ts tests/server/postgres-cardio-store.test.ts
git commit -m "feat: add verified strain timeline projection"
```

### Task 3: 实现编辑式首页与身体年龄的首屏位置

**Files:**
- Create: `src/ui/dashboard/editorial-homepage.tsx`
- Create: `src/ui/dashboard/strain-timeline.tsx`
- Modify: `src/ui/dashboard/body-age-card.tsx`
- Modify: `src/ui/dashboard/today-dashboard.tsx`
- Modify: `app/page.tsx`
- Modify: `app/globals.css`
- Modify: `tests/ui/today-dashboard.test.ts`
- Modify: `tests/ui/body-age-card.test.tsx`

- [x] **Step 1: 为首页结构写失败测试**

在 `tests/ui/today-dashboard.test.ts` 以 `HomepageTodayView` 断言 390px 主阅读顺序为：编辑式日期页头、单一可展开的数据质量入口、恢复摘要、全天心肺负荷与可选 timeline、身体年龄、单条事实性文案、全宽 `记录一餐` CTA、现有底部导航。断言 body age 在 action 前、不会和旧 `MetricCard` 网格重复出现，且 HTML/RSC 不含 evidence/BPM/zone 字段；将 `app/page.tsx` 改为新 homepage builder 后，这个服务端渲染测试必须仍通过。

- [x] **Step 2: 运行 UI 测试确认失败**

Run: `pnpm exec tsx --test tests/ui/today-dashboard.test.ts tests/ui/body-age-card.test.tsx`

Expected: FAIL，因为当前页面仍为「今日三项」和后置独立身体年龄卡。

- [x] **Step 3: 写最小的编辑式 UI 组件**

新增 `EditorialHomepage`，用首页安全 DTO 渲染：紧凑品牌/日期/设置；原生 `<details>` 数据质量入口；恢复摘要；负荷主区；`BodyAgeCard` 的紧凑 inline 变体（仍保留 `?` dialog）；短 action；唯一全宽深绿 `记录一餐` 链接。`StrainTimeline` 只在已验证投影存在时渲染可读的 SVG-free bucket 列表/进度条和文字替代；不存在时显示真实指标 detail，不用空白图暗示 0。

- [x] **Step 4: 落实响应式与可访问样式**

更新 CSS：390px 为 20px 边距的单列编辑式阅读流；>=768px 用约 4/8 栏恢复/负荷网格并放宽总宽度至 68rem。确保 44px 触达、`focus-visible`、safe-area 底部空间、`prefers-reduced-motion`、无水平溢出。使用已有 lucide 图标与现有 token；不新增图片、渐变、手写 SVG 或伪造数据图。

- [x] **Step 5: 重跑 UI 测试确认通过**

Run: `pnpm exec tsx --test tests/ui/today-dashboard.test.ts tests/ui/body-age-card.test.tsx`

Expected: PASS，含已估算、资料未完成、积累中、更新中和过期的身体年龄状态。

- [x] **Step 6: 提交首页界面切片**

```bash
git add src/ui/dashboard/editorial-homepage.tsx src/ui/dashboard/strain-timeline.tsx src/ui/dashboard/body-age-card.tsx src/ui/dashboard/today-dashboard.tsx app/page.tsx app/globals.css tests/ui/today-dashboard.test.ts tests/ui/body-age-card.test.tsx
git commit -m "feat: redesign editorial homepage with body age"
```

### Task 4: 容器迁移、视觉 QA 与回归验证

**Files:**
- Modify: `docs/superpowers/specs/2026-09-02-editorial-rhythm-homepage-design.md`
- Create: `design-qa.md`

- [x] **Step 1: 增加 migration 对真实 PostgreSQL 的失败/成功覆盖**

扩展 opt-in PostgreSQL integration test：先运行至 012、插入旧版 `daily_cardio`/`metric_results` 行，再运行 013，断言升级成功、旧行没有 provenance 且 timeline fail-closed；验证 013 的失败迁移会回滚、重跑成功，且新版 Strain 行不能写 `NULL`/空/伪 fingerprint、`NULL` 或非对象 context。全程只使用 scratch database 与合成 UUID，不读取或打印真实用户健康数据。

- [x] **Step 2: 完整重建本地容器**

Run: `docker compose up --build --force-recreate --remove-orphans -d && docker compose ps`

Expected: `app` 与 `db` healthy，迁移完成，sync worker 可启动。

- [x] **Step 3: 用 320、390×844、768 与 1440px 捕获本地首页**

将已选的编辑式参考图与 390×844 的本地 `/rhythm` 截图并排检查；再在 320、768 与 1440px 检查无横向溢出、底部安全区和网格切换。实际登录状态只读；不更改个人资料、不提交表单。若浏览器无法附着，`design-qa.md` 明确写 `final result: blocked`，不宣称视觉 QA 通过。

- [ ] **Step 4: 修复 P0/P1/P2 并重复捕获**

重点检查：中文字重与留白、身体年龄位于首屏、无 nested cards、无横向溢出、CTA/导航触达面积、timeline 的未知/未来状态和无数字状态。

- [x] **Step 5: 运行完整验证**

Run: `pnpm test && pnpm run lint && pnpm run build && git diff --check`

Expected: 0 failures，TypeScript 无错误，生产构建成功且 diff 无空白错误。

- [ ] **Step 6: 提交文档与 QA 记录**

```bash
git add docs/superpowers/specs/2026-09-02-editorial-rhythm-homepage-design.md design-qa.md tests/integration/postgres-homepage-provenance.test.ts
git commit -m "docs: verify editorial homepage rollout"
```
