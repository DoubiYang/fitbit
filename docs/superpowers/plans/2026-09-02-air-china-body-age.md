# Air 中国成人参照身体年龄实施计划

> **执行约束：** 实现时依次使用 `test-driven-development`、`systematic-debugging`（如测试失败）与 `verification-before-completion`；不得将生日、逐日 VO₂、RHR、HRmax 或 Google 原始数据序列化到浏览器。

**目标：** 用唯一的 Fitbit Air→Google Health 数据生成可解释的“身体年龄”估算：优先采用 Air `daily-vo2-max`，缺失时采用 Air 自接入以来的观察峰值心率与 7 日静息心率中位数；结果映射 Wang 2022 中国社区成人功率车 CPET P50，并显示为非医疗、非校准的心肺年龄估算。

**架构：** 将中国参考表和计算逻辑放入纯领域模块，迁移只保留每用户最新资料、每日 Air VO₂ 与最新结果。同步层每小时拉取 `daily-vo2-max`，同时单调更新自接入以来的有效观察峰值；同步后在服务器内计算并持久化最新结果。首页只获取已脱敏的结果视图；设置页获取并保存出生日期与参考表选择；`?` 用可访问的说明层解释路线、状态和研究限制。

**技术栈：** Next.js App Router、TypeScript、PostgreSQL、既有 Docker Compose、Node test runner（`tsx --test`）。

---

## 1. 固化公开中国参考表与纯算法

**文件：**
- 新增：`data/reference/chinese-community-cycle-vo2peak-p50-v1.json`
- 新增：`src/domain/body-age.ts`
- 新增：`tests/domain/body-age.test.ts`

1. 写失败测试，覆盖参考表 JSON schema、Wang 2022 DOI/测试方式/12 个 P50 值、SHA-256、六个年龄锚点、男女表选择、分段线性反推、整岁舍入、`≤25`/`≥75` 边界。
2. 在 Git 管理的 JSON 中写明参考队列、功率车 CPET、P50、访问日期和限制；测试内根据 canonical JSON 校验 SHA-256，避免无审查改值。
3. 在 `src/domain/body-age.ts` 实现纯函数：
   - 筛选当前本地日及此前 27 天的有限正 Air 日 VO₂（同一日期至多一个值）；
   - 中位数、最新日期、7/21 日覆盖和 7 天陈旧判定；
   - `15.3 × HRpeak_observed / median(最近 7 个有效 RHR)` 的 Uth 启发式观察峰值 proxy；
   - 历史观察峰值有效性规则（`sampleCount > 0`、`coverageSeconds >= 30`、`100–230 bpm`），并在结果内保留“非实测 HRmax”的状态；
   - 不混合路线、资料待补充/待积累/初步/稳定/过期状态、无原始输入的脱敏结果 DTO。
4. 先运行失败的 `pnpm exec tsx --test tests/domain/body-age.test.ts`，仅补充使该测试通过的领域实现。

## 2. 增加最小持久化模型与存储接口

**文件：**
- 新增：`db/migrations/012_body_age_air_cn_v1.sql`
- 修改：`src/server/health/cardio-store.ts`
- 修改：`src/server/db/memory-store.ts`
- 修改：`src/domain/cardio-records.ts`（仅当共享记录类型确有归属）
- 新增：`tests/server/postgres-body-age-store.test.ts`

1. 写失败存储测试，断言迁移和 PostgreSQL store 能：创建/更新 body-age profile、按 `(user_id, civil_date)` upsert Air 日 VO₂、删除刷新窗口中已消失的日期、读取 28 日窗口、单调更新自接入以来的有效观察峰值、替换而非累计每用户最新结果。
2. 在同一迁移中安全替换 `health_sync_cursors` 的既有 data-type `CHECK`，保留全部旧类型并加入 `daily-vo2-max`；先验证现有约束名与迁移顺序，不能通过重建表或丢弃 cursor 完成这一步。
3. 添加三张表：
   - `user_body_age_profiles`：用户资料、自接入以来的历史有效观察峰值与时间、`profile_revision`；允许资料未完成，以便心率同步可安全建立记录；
   - `air_daily_vo2`：仅日期、VO₂、estimated 标记与接收时间，唯一键 `(user_id, civil_date)`；
   - `body_age_results`：每用户/算法版本的最新脱敏结果、覆盖、路线、状态、版本、fingerprint、计算时间；不保存逐日 RHR、生日副本、HRmax 或原始 Google payload。
4. 为外键、日期窗口、唯一键及数据删除级联建立约束和索引；检查 migration 不修改已有 OAuth scopes 或既有指标表。
5. 扩展生产 store 和 memory store，并使 transaction 覆盖新表，保持既有读取路径不变。
6. 运行失败测试后实现，接着运行 `pnpm exec tsx --test tests/server/postgres-body-age-store.test.ts`。

## 3. 让同步读取 Air 日 VO₂、更新观察峰值并重算结果

**文件：**
- 修改：`src/server/health/map-records.ts`
- 修改：`src/server/health/filters.ts`
- 修改：`src/server/health/cardio-sync.ts`
- 修改：`src/server/health/cardio-store.ts`
- 修改：`src/server/health/run-sync.ts`（仅在编排点需要显式传递 RHR/时区时）
- 新增：`src/server/health/body-age-recompute.ts`
- 修改：`tests/server/cardio-sync.test.ts`
- 新增：`tests/server/body-age-recompute.test.ts`

1. 先增加失败测试：`daily-vo2-max` 使用现有的 `google-wearables` family，首次读最近 28 个 civil day，随后小时同步只刷新 48 小时，光标与 403/空数据/重试不影响其它数据类型。
2. 扩展 Google DataPoint 映射，仅读取有限正 `vo2Max` 与可选 `estimated`；忽略 `cardioFitnessLevel`、covariance、设备身份与原始 payload。`google-wearables` 只按用户声明的单一 Air 连接使用，不写成设备型号验证。
3. 将 `daily-vo2-max` 加入每小时 cardio 同步类型；首次读取 28 个 Google civil day，后续在 48 小时 authoritative 刷新窗口按 Google civil date 原样 upsert 返回日期并删除该窗口不再返回的旧日期。旅行/DST 不迁移历史日；窗口外的迟到修订仅在有意的后续全量回填时生效，v1 不承诺自动捕捉。
4. 在已持久化原始分钟心率后筛选本轮有效点，并仅以 `GREATEST(已有, 本轮最大)` 更新 profile 的自接入以来 `observedHrPeak`；不得人工输入、不得称其为生理 HRmax，也不得用年龄公式补值。
5. 写 `body-age-recompute.ts`：在同一同步轮拿到的、仅服务器内的每日 RHR 与 store 中 Air 日 VO₂/profile/observedHrPeak 计算；使用当前用户时区确定 `asOf`，写最新结果与 fingerprint。重新计算失败必须隔离，不令睡眠、Recovery 或 Strain 同步失败。
6. 回归测试以下边界：6/7/21 天、daily VO₂ 优先且不混合、同日修订、空 refresh 删除、预计值可用、7 RHR 中位数、自接入后首轮心率回看范围、过期输入、profile/reference/fingerprint 变化后旧结果不可展示。
7. 运行 `pnpm exec tsx --test tests/server/cardio-sync.test.ts tests/server/body-age-recompute.test.ts`。

## 4. 建立资料设置与严格脱敏的 API 视图

**文件：**
- 新增：`src/server/settings/body-age-profile.ts`
- 新增：`app/api/settings/body-age-profile/route.ts`
- 修改：`src/server/dashboard/build-today.ts`
- 修改：`src/server/dashboard/today-response.ts`
- 修改：`tests/server/build-today.test.ts`
- 新增：`tests/server/body-age-profile.test.ts`

1. 写失败测试，确保出生日期须是合法非未来 ISO 日期，参考表只能由用户显式选 `male` 或 `female`，保存资料递增 `profile_revision`，并触发服务器侧重新计算或标记待更新。
2. 只在服务端持有生日；资料 API 的 GET 仅向已登录本人返回可编辑资料，dashboard API 永不返回生日、原始 VO₂、逐日 RHR、HRmax、来源键、OAuth scope 或 Google DataPoint。
3. 为 `TodayView.metrics` 增加 `bodyAge` 脱敏 view：年龄或边界、状态、路线标签、覆盖、最新输入日期、版本、能否显示实际年龄差的安全布尔/已算差值。每次读取前验证 fingerprint 与 profile revision；失配则返回“数据待更新”而不是旧数字。
4. 在无 healthMetrics 的 demo/fallback 路径返回资料待补充的安全默认值，保持现有 demo 渲染稳定。
5. 运行 `pnpm exec tsx --test tests/server/body-age-profile.test.ts tests/server/build-today.test.ts`。

## 5. 在设置页收集资料且不制造医疗暗示

**文件：**
- 修改：`app/settings/page.tsx`
- 新增：`src/ui/settings/body-age-settings.tsx`
- 修改：`src/ui/settings/sleep-goal-settings.tsx`（仅当复用布局与 action feedback 有利）
- 修改：`app/globals.css`
- 新增：`tests/ui/body-age-settings.test.tsx`

1. 先写失败 UI/API 测试：未填生日或未选参考表的清晰状态、中文日期输入、用户主动选择的“男性参考表/女性参考表”、保存提示、无从资料推断性别的行为。
2. 在现有设置页加一个独立“身体年龄估算”区块，解释该信息只用于中国成人参考映射、Air 日心肺值与功率车 CPET 并不等价；不显示或要求身高、体重、疾病、设备型号或手动最大心率。
3. 手机优先实现，使用现有 sage-green/warm-white token、44px+ 触控区、系统焦点样式与 reduced-motion；不更改餐食流或既有睡眠目标含义。
4. 测试保存失败时可恢复且不乐观更新为已保存，运行 `pnpm exec tsx --test tests/ui/body-age-settings.test.tsx`。

## 6. 将身体年龄作为首页的可解释指标

**文件：**
- 修改：`src/ui/dashboard/today-dashboard.tsx`
- 新增：`src/ui/dashboard/body-age-card.tsx`
- 新增：`src/ui/dashboard/body-age-info-sheet.tsx`
- 修改：`app/globals.css`
- 新增：`tests/ui/body-age-card.test.tsx`
- 修改：`tests/ui/today-dashboard.test.ts`

1. 写失败组件测试，覆盖可用/边界/资料待补充/待积累/过期/指纹待更新，且断言 DOM 中没有出生日期、VO₂、RHR、HRmax 或 Google 原始字段。
2. 在恢复与全天心肺负荷之后、建议之前插入 `身体年龄` 卡：仅展示估算年龄或边界、Air 路线、状态、日期数及已算好的年龄差；在资料不全/数据不足时精确显示缺口，不作“偏低”判断。
3. 用 `?` 启动受控 modal（桌面）/bottom sheet（移动端）：包含定义、本次路线、覆盖/最新日期、算法版本、Wang 2022、路线适用时的 Uth 2004、INTERLIVE 链接及“Air 日值不是 CPET、观察峰值不是 HRmax”的非医疗限制。实现 `aria-labelledby`、描述、ESC、关闭键、焦点进出恢复和 reduced-motion。
4. 沿用当前的绿色编辑风格，确保在 390px、768px、1440px 下不挤压恢复、全天负荷或“记录餐食” CTA。
5. 运行 `pnpm exec tsx --test tests/ui/body-age-card.test.tsx tests/ui/today-dashboard.test.ts`。

## 7. 全量验证、Docker 真实连接安全检查与交付

**文件：**
- 如验证发现必要问题，仅修改上述实现/测试文件；不扩大 scope。

1. 运行 `pnpm test`、`pnpm run lint`、`pnpm run build`；若失败，依照 `systematic-debugging` 先复现、定位根因、添加回归测试再修复。
2. 使用 `docker compose up --build -d` 重建本地服务，确认 migration 已应用、同步 worker 正常、每日 VO₂ 新 cursor 出现、结果表只有每用户最新记录。
3. 在真实连接上仅检查非敏感状态（是否可用、路线、覆盖和时间戳），不在终端输出生日、心率、VO₂、token 或原始 payload；检查 dashboard 网络响应未泄露原始输入。
4. 用浏览器在 390px、768px、1440px 截图检查首页卡片与 `?`；验证键盘焦点与设置保存路径。
5. 运行 `git diff --check`、`git status --short`，总结验证证据和仍然成立的估算限制；只有用户要求时再 commit/push。

## 交付验收

- Fitbit Air 是用户声明的唯一数据输入；没有设备验证/校验门槛阻止用户出结果，也不将 `google-wearables` 误称为型号证明。
- 当前 28 天有至少 7 条 Air 日 VO₂ 即有“初步”结果，21 条即“稳定”；不足时可用 7 日 RHR + 自接入以来的 Air 观察峰值的“心率比 proxy”初步估算。
- 对应中国成人参考表、路线、状态、覆盖、研究限制均可从 `?` 看懂。
- 浏览器和 AI Coach 均拿不到生日、原始心率/RHR/VO₂ 或 Google payload。
- 同步、设置、持久化、脱敏 API、移动端 UI 及 Docker 都有自动化验证。
