# Google Heart Rate 驱动的 WHOOP 风格指标设计

**状态：** 审阅后按真实账户快照修订，待实施；raw `heart-rate` / `motionContext` / 日区间仍未在本地验证
**日期：** 2026-08-31
**范围：** 一期的全天 Strain、Recovery、Sleep Performance，以及支撑它们的 Google Health 心率同步与数据质量机制。

## 1. 目标与边界

产品提供三个 **WHOOP 风格、透明自研** 指标：

- **全天 Strain（0–21）**：一天中可归因于身体活动的心肺负荷；不是卡路里，也不是 Google Cardio Load 的复刻。
- **Recovery（0–100）**：今天相对于个人近期常态的恢复状态；不是疾病、受伤或训练安全判断。
- **Sleep Performance（0–100）**：昨夜实际睡眠相对于当晚动态睡眠需求的完成度。

Google Health 未公开其 Readiness、Sleep Score 或 Cardio Load 的分数及算法，因此产品绝不将自研分数标为 Google 或 WHOOP 分数。WHOOP 也未公开其完整 Strain 公式；本设计只借用“恢复、睡眠、全天负荷”这一产品结构，所有输入、降级条件与计算版本均可查看和复现。

一期不做：肌肉负荷估算、受伤预测、疾病诊断、手动填写最大心率、以低置信度指标给出高强度训练指令。

## 2. Google Health 的权威心率口径

对同一用户、同一当地日期，以下内容必须来自同一套 Google 心率区间：

1. 首页心率图的分区线；
2. 低/中/高/峰值区间的时长；
3. 全天 Strain 的分段负荷；
4. AI Coach 对当日运动强度的解释。

### 2.1 数据类型

| Google Health 数据类型 | 一期用途 | 使用方式 |
| --- | --- | --- |
| `heart-rate` | 时间轴、尚未结束日期的临时聚合、活动/静止判断 | 读取逐点 `heartRate.sampleTime.physicalTime`、`beatsPerMinute`（JSON 为 string）与 `heartRate.metadata.motionContext`；通过 `reconcile` 消除不同来源的重复样本。filter 使用 snake_case：`heart_rate.sample_time.physical_time`。 |
| `daily-heart-rate-zones` | 当日个人化区间阈值 | 直接读取当天各区间的 `minBeatsPerMinute` / `maxBeatsPerMinute`；这是 Google 按 Karvonen 算法产生的日阈值。filter：`daily_heart_rate_zones.date`。 |
| `time-in-heart-rate-zone` | 全天区间时长展示与交叉校验 | **Interval 类型**，不是日汇总点。用 `dailyRollUp` 得到按日各区间总时长，或 reconcile 后按当地日把 interval 加总写入 `daily_time_in_zone`。**不直接用于 Strain**，因为它包含静止低区间。filter：`time_in_heart_rate_zone.interval.start_time`。 |
| `daily-heart-rate-variability` | Recovery 的 HRV 输入 | 读取日 RMSSD（毫秒）。 |
| `daily-resting-heart-rate` | Recovery 的 RHR 输入 | 读取每日静息心率。 |
| `sleep` | Sleep Performance、Recovery 的睡眠输入 | 主睡眠、实际睡眠、卧床、清醒片段及 civil time。 |
| `exercise` | Strain 来源解释与日内去重 | 标记有名称的锻炼会话；不是全天 Strain 的唯一来源。 |

`daily-heart-rate-zones` 是阈值的唯一首选来源；不得以「历史最高心率」作为最大心率，也不得写死截图中的任意 bpm 数字。只有四个有序区间 `light`、`moderate`、`vigorous`、`peak` 都存在、每段 `min ≤ max`，且相邻边界满足前一段 `max =` 后一段 `min` 时，才可为该日计算 Strain。归类固定为各段 `[min, max)`，只有 `peak` 为 `[min, max]`；因此相邻边界不会重复计入或被误判为重叠。Google 会按天调整阈值，因此历史日期必须保存并使用该日期的阈值，不能用今天的区间重算过去。

原始逐点心率是采样数据而不是「每分钟必有一个点」。每日 Google 数据类型的 `date` 是该日阈值和日汇总的权威当地日期。原始点按其 API 返回的 `physicalTime` 时区/offset 分到当地分钟；持久化时保存 `civil_date`、UTC minute instant、当时 UTC offset 和可用的 IANA time zone。没有可用时区/offset 的原始点不得用于 Strain 完整日判定。旅行或夏令时切换只影响新点的当地日期；历史 `civil_date`、offset 和计算结果永不按当前设备时区重写。DST 的 23/25 小时日仍按当地墙上时间处理。

### 2.2 降级规则

1. 有 Google 当日区间和 `time-in-heart-rate-zone` 的按日合计：展示完整日的全天区间时长；它不是 Strain 输入。交叉校验只记录差异，不因此改写剂量。
2. Strain 只接受“可归因活动”的原始心率分钟（主导 `motionContext=ACTIVE`）或与已知 `exercise` 会话重叠至少 30 秒的心率分钟。缺少这两者时，即使有全天区间合计，也不出全天 Strain。
3. 当日区间缺失：不伪造个人化区间、不用历史最高心率替代；全天 Strain 显示“心率区间未提供”，只展示原始心率或已知锻炼。
4. 当前未结束日，以及**已过去但不完整、却有可归因活动分钟**的日期，可以显示带 `provisional` 标签的 Strain，必须标明不可与完整日直接比较。过去日不得把覆盖不足算成 0.0。
5. `motionContext` 尚未在本账户的 raw `heart-rate` 上验证。探针确认缺失或几乎全是 `MOTION_CONTEXT_UNSPECIFIED` 时：不得把 unknown 当作静止来出 0.0；完整日门槛改走不可用，Strain 只从 `exercise` 重叠分钟给出 `provisional`，并显示“活动上下文未提供”。

## 3. 同步、留存与完整性

### 3.1 同步策略

- 用户首次授权后，回填最近 **35 个当地日**。35 天只是拉取缓冲和稳定基线目标，不是指标显示门槛。
- 每个已连接用户每 **1 小时**同步一次。
- 原始心率和锻炼使用各自上次成功水位减 2 小时的重叠窗口，幂等 upsert。`time-in-heart-rate-zone` 按日 rollup / 当地日加总，使用与每日阈值相同的 48 小时重叠窗口，不要按 raw HR 的 2 小时 cursor 去拉 interval 流。睡眠、HRV、RHR 与每日阈值使用各自最近 48 小时重叠窗口，吸收设备迟到修订。
- 每一种数据类型有独立的成功水位、最后错误、retry count 与 `next_attempt_at`。原始心率的各页可先幂等 upsert，但**只有该窗口所有页成功处理、所有受影响日重算完成后**才推进成功水位；任何晚页失败时成功水位保持不变，下一次从原窗口重叠区重新读取。429、网络故障、令牌错误均不得把失败窗口标为已同步。
- 单一数据类型失败时，只写它自己的错误和带抖动退避（30/60/120 分钟，之后一小时）；其他数据类型仍可成功写入并推进各自水位。connection 的 `next_sync_at` 必须取所有数据类型 `next_attempt_at` 的最早值，确保 A 类型 429 不会被 B 类型的“一小时后再同步”掩盖。用户可见同步状态显示每类失败，但不得泄露 API 响应或 token。
- Webhook 可作为未来加速路径；一期以每小时轮询为正确性基线，不依赖 webhook 才能获得数据。

### 3.2 本地留存与隐私

为支持全天指标，原始心率点仅在一次同步计算期间保留在内存。数据库只保存：

- 每分钟的聚合心率（分钟、平均/最小/最大 bpm、样本数、motion context、覆盖秒数）；
- 每日 Google 区间阈值及各区间时长；
- 每日指标结果、计算版本、质量、输入来源及解释证据；
- 同步水位、完整性与失败状态。

新增持久化模型如下；所有 Google 数据只接受已配置的 `google-wearables` source family，绝不将不同 source family 的样本混合成同一分钟或同一天。

| 表 | 唯一键 | 责任 |
| --- | --- | --- |
| `heart_rate_minute_aggregates` | `(user_id, source_family, minute_start_utc)` | 单分钟的平均/最小/最大 bpm、覆盖秒数、样本数、主导 motion context、历史 civil date 与 UTC offset；不保存原始点。 |
| `daily_heart_rate_zones` | `(user_id, source_family, civil_date)` | 当天 Google 阈值及从 API 接收时刻；后续修订覆盖该日最新阈值。 |
| `daily_time_in_zone` | `(user_id, source_family, civil_date)` | Google 全天区间时长，专用于展示和交叉校验。 |
| `exercise_intervals` | `(user_id, source_family, source_record_id)` | 已确认锻炼的起止 UTC 时间、当时 offset 和 civil date；用于将未知-context 的心率分钟可靠归因活动。 |
| `daily_cardio` | `(user_id, civil_date)` | 活动归因后的分区分钟数、覆盖率、完成状态、全天/进行中 Strain 及来源。 |
| `health_sync_cursors` | `(connection_id, data_type)` | 每种数据类型的成功水位、最后错误和重试状态。 |
| `metric_results` | `(user_id, civil_date, metric_name, metric_version)` | 指标输入摘要、分数、质量和计算时间；同版本同日以最新成功重算为准，新版本新增行。 |
| `user_sleep_goal_history` | `(user_id, effective_civil_date)` | 用户手动确认的基础睡眠目标（分钟）及其生效日；不以之后的设置重写历史指标。 |
| `user_health_time_zone_history` | `(user_id, effective_at)` | 来自用户已登录设备的 IANA 时区及其生效时间；首条可标记为历史回填锚点，用于 DST 的墙上时间分段和设置生效日。 |

首次回填尚未知道用户的健康时区时，原始心率按 `now − 37 × 24h` 至 `now` 的 UTC 物理时间读取；每日记录请求 UTC 当前日期前 36 日至当前日期后 1 日的宽窗口，再以 API 返回的 `date` / sample offset 确定实际当地日。这比固定 `Asia/Shanghai` 更宽，能够覆盖任何合法 UTC offset 下最近 35 个当地日。之后只用各数据类型的 UTC cursor 拉取，再以记录自身 offset 归日。

原始样本的 offset/civil time 足以归属当地日期，但不足以可靠判定 DST 的 23/25 小时长度。已登录客户端必须把 `Intl.DateTimeFormat().resolvedOptions().timeZone` 作为 IANA 时区历史写入 `user_health_time_zone_history`；每个样本日使用当时最新、且 offset 匹配的时区记录进行墙上时间分段和 DST 判断。没有匹配 IANA 时区、或时区与样本 offset 冲突时，仍保存聚合/展示数据，但该日必须标记 `timezone_ambiguous`、不满足 Strain 完整日条件。旅行时客户端写入新时区历史；未知旅行不能被假定为原时区。

首次成功写入 IANA 时区后，服务端必须在**同一数据库事务**中对本地已保存的历史分钟聚合执行一次本地重索引，不等待下一轮 API 拉取：若该用户此前没有时区历史，首条记录以最早已保存分钟的 UTC instant（没有分钟则以写入时刻）作为 `effective_at`，并标记为“历史回填锚点”。它可覆盖已有历史窗口；逐分钟用该 IANA 时区在该 UTC instant 的实际 offset 与存储的 `utc_offset` 比较，只有一致的分钟才写入 IANA 时区、按该区间重建当地日期/墙上时间覆盖，并重算受影响的 `daily_cardio` 和 `whoop-style-v2` 结果。后续时区记录以客户端上报时刻为 `effective_at`，只重索引其 `effective_at` 至下一条时区记录的范围，且不得跨越已有时区边界。offset 不一致的分钟仍保持 `timezone_ambiguous`，不猜测、不重新下载原始点。这样 OAuth 回调先完成 35 日同步、浏览器随后才上报时区时，匹配的历史日也能立即取得完整日资格；旅行中的不匹配日期仍安全地不可出完整 Strain。

首次 35 日回填的 `heart-rate` 必须按当地日分段并分页处理。`reconcile` 的 `pageSize` 用 10000（API 上限），禁止沿用睡眠/训练的 25。每一页转为分钟聚合前，必须保留上一页最后一个样本作为 lookahead，才能计算“延伸到下一样本、最长 75 秒”；页末样本在看到下一页首点（或窗口结束）之前不得 flush 该分钟。同一 UTC 分钟的覆盖按时间并段合并，禁止把两页的覆盖秒数直接相加。flush 后才能释放该页原始点；不得把 35 天高频样本或完整 API JSON 一次性装入内存。`exercise` 同步也必须 upsert `exercise_intervals`，然后重算其覆盖的每个当地日期；原始心率和 exercise 无论谁先到达，都必须得到同一日归因结果。任一当地日的 Strain 重算成功后，必须级联重算下一当地日的 Sleep Performance 和 Recovery（它们依赖 `Strain(D−1)`）。

用户在账户设置中断开 Google Health 连接时，即使 `users` 和断开状态的 connection 行仍保留，也必须在同一事务中显式删除该用户的 `heart_rate_minute_aggregates`、每日区间/时长、`exercise_intervals`、`daily_cardio`、`metric_results`、sync cursors、睡眠目标/时区历史和既有 `health_snapshots`，并清除连接凭证。账户删除则同时通过外键级联完成同样清理。

不保存单个未聚合原始心率样本，不将 token、完整 API 原始 JSON 或分钟数据传给 AI Coach。用户删除连接或账户时，连接令牌和对应健康聚合数据必须按账户删除流程一并清除。

### 3.3 覆盖率与完整日

每个 `daily_cardio` 记录至少包含：当地日期、区间阈值版本、活动归因后的各区间分钟数、原始心率覆盖分钟数、活动覆盖分钟数、来源、日是否完成、最后同步时间。

分钟覆盖采用固定规则：一个原始样本从其 `sampleTime` 延伸至下一样本，但最长只延伸 75 秒；跨度按本地分钟边界拆分。单分钟累积至少 30 秒有效覆盖才成为可用分钟。一个分钟有多个 context 时，取覆盖秒数最多者；相同覆盖秒数时优先 `ACTIVE`、再 `SEDENTARY`、最后未知。`motionContext` 缺失、`MOTION_CONTEXT_UNSPECIFIED` 或未识别时就是 `unknown`，既不代表静止也不代表活动。JSON 路径是 `heartRate.metadata.motionContext`，不在 `heartRate` 根上。

只有主导 context 为 `ACTIVE` 或与已确认 `exercise` 会话重叠至少 30 秒的分钟可计入 Strain；未分区或低于最低 Google 区间的活动分钟不产生剂量。完整日与进行中日的“心率覆盖”只累计主导 context 已知为 `ACTIVE` 或 `SEDENTARY` 的分钟；`unknown` 覆盖不会证明用户未活动，也不能补足完整性门槛。

- 已过去的日期：当天 Google 阈值存在、该日 IANA 时区明确、已知 context 的原始心率覆盖至少 480 分钟、当天最后一个已知-context 样本距当地日结束不超过 180 分钟，且当地 `06:00–12:00`、`12:00–18:00`、`18:00–24:00` 三个时段各至少有 90 分钟已知-context 覆盖、任一时段内无超过 240 分钟的连续已知-context 覆盖缺口，才可标记为完整，输出完整日 Strain。DST 日按真实当地时间计算各时段。否则是 `incomplete`：若仍有可归因活动分钟，输出带标签的 `provisional` Strain；若没有可归因活动分钟，不出分（未知不是零）。
- 当天：永远是进行中；Google 阈值存在、已累计至少 120 分钟已知-context 覆盖且最新已知-context 样本距当前时刻不超过 90 分钟时，才显示截至当前的 `provisional` Strain。已知-context 不足但已有 exercise 重叠分钟时，仍可显示 `provisional`，并说明覆盖不足。
- 只有满足完整日资格、且不存在活动归因分钟（含 exercise 覆盖的未知-context 分钟）时，才输出 0.0 Strain；不具备完整日资格时未知不是零。
- 数据缺口、Google 未给区间阈值、或时间段无法可信归因时：不把它当作零负荷，也不输出“偏低”结论。
- Strain 的完成状态（`complete` / `provisional` / `incomplete` / `timezone_ambiguous` / `unavailable`）与 Recovery 的质量（`unavailable` / `provisional` / `medium` / `high`）是两条轴，不要塞进同一个枚举。

## 4. 全天 Strain（0–21）

### 4.1 含义

Strain 代表全天可观测的**心肺**负荷，包含命名锻炼和日常活动；不能声称覆盖力量训练的肌肉负荷。页面必须同时展示“全天心肺负荷”的限定语和数据来源构成，避免把通勤、散步与正式训练混为同一个锻炼列表。

### 4.2 计算层次

1. **阈值层：** 取当天 `daily-heart-rate-zones` 的 Google 个性化边界。
2. **分钟层：** 以逐分钟聚合心率按同日阈值归入 `light`、`moderate`、`vigorous`、`peak`；全天 `time-in-heart-rate-zone` 只做展示与交叉校验，不能替代此层。
3. **活动归因层：** 只保留 `motionContext=ACTIVE` 或已知 `exercise` 会话内的分钟。静止低区间时间只用于展示心率，不按“一分钟一次训练”计入负荷。这避免“全天 14 小时低区间”被误计为高 Strain。
4. **剂量层：** 对活动分钟按由低到峰的固定系数 `0.5 / 1 / 2 / 3` 累积：`dose = 0.5 × light + 1 × moderate + 2 × vigorous + 3 × peak`。该做法借鉴 Edwards TRIMP 的区间递增原则；轻区间系数特意更低，以适配全天而非单次训练的统计范围。
5. **展示层：** `strain = roundHalfAwayFromZeroToOneDecimal(min(21, 21 × (1 − exp(−dose / 140))))`。`roundHalfAwayFromZeroToOneDecimal` 即 `Math.round(x * 10) / 10`。低于当天 `light.min` 或高于 `peak.max` 的活动分钟不产生剂量。这个固定的递减收益映射使额外负荷在高端需要更大的剂量；它不是 Google/WHOOP 的私有公式，也不使用用户历史最高心率。

`whoop-style-v2` 的上述系数、分母、四舍五入和数据质量规则全部冻结。后续若要调整，新增版本并保留旧结果，绝不静默改写趋势。离线回放必须验证分数随剂量单调、静止低心率不会增加剂量，并与已知锻炼区间时长方向一致。ACTIVE 全天低强度步行会把分数顶到高端，必须以真实 Fitbit Air 的 ACTIVE 密度标定后再冻结展示文案，不得在标定前把 18+ 说成“极高训练日”。

### 4.3 显示与数据量

- 第一日有足够的活动心率/区间数据，即可显示全天 Strain；不要求 7 天或 35 天基线。
- 没有 Google 区间或覆盖不足时，不出伪精确的 0–21 分数，改为数据缺失说明。
- 7–27 天的历史可显示“初始个人范围”，28 天以上显示“个人范围较稳定”；这影响解释和趋势基线，不阻塞日 Strain。
- 详情页显示：当前数值、完成/进行中、各区间活动时长、数据来源、覆盖情况及 `metricVersion`。

## 5. Sleep Performance（0–100）

### 5.1 睡眠需求

用户必须在首次计算前确认自己的基础睡眠目标。它保存为 `user_sleep_goal_history` 的正整数分钟值（300–900 分钟）。**没有确认目标时不出 Sleep Performance**；Recovery 仍可用 HRV 与 RHR 出分（见第 6 节），不得继续用代码里写死的 480 分钟冒充目标。设置在用户当地日 `T` 发生时，以 `effective_civil_date = T + 1` 写入，作用于下一次主睡眠结束日期及之后的日期；编辑目标不会改写 `effective_civil_date` 之前已保存的结果。同一 `effective_civil_date` 的重复 PUT 返回冲突，不静默改历史。`GET/PUT /api/settings/sleep-goal` 只读取/新增该用户自己的设置，服务端验证范围与生效日期，前端显示为用户偏好而非医学处方。`T` 必须通过已保存的 IANA 时区历史计算；不存在时客户端先写入时区设置，不能回退到服务器或固定中国时区。

主睡眠定义（本文件自洽，不暗引旧文档）：睡眠日期固定为 `sleep.interval.civilEndTime` 的本地日历日。候选为结束于该日、`metadata.nap != true` 且 `summary.minutesAsleep ≥ 180` 的 `sleep` 会话。多个候选时先取实际睡眠分钟最多者，再取 `metadata.processed=true`、开始时间最早、`dataPoint.name` 字典序。午睡永不进入主睡眠或睡眠债。

对睡眠日期 `D`，系统选取 `effective_civil_date ≤ D` 的最新目标，计算动态睡眠需求：

`动态需求(D) = roundHalfAwayFromZero(基础目标 + min(60, 0.5 × 睡眠债(D)) + min(30, 5 × max(0, Strain(D−1) − 10)))`

- `睡眠债(D)` 覆盖 `D` 之前连续 7 个当地日历日（`D−7` 至 `D−1`）。每一天取该日最长的**非午睡**会话 `minutesAsleep`（即使不足 180 分钟）；没有非午睡会话的日历日按 0 分钟计入，不得从窗口里删掉该日再平均。`当天债 = max(0, 基础目标 − 该日非午睡分钟)`。始终以基础目标计债，避免动态目标递归放大。Sleep Performance 仍只接受 ≥180 的主睡眠；债不走同一条 180 分钟门槛，避免 179/180 断崖。
- 7 日中任一日历日没有非午睡会话时，动态需求质量标记 `sleep_history_incomplete`；债仍按上款求和，不清零。这样失眠或摘表会抬高次日需求，而不是把补偿打成 0。
- Sleep Performance 在有主睡眠和基础目标时仍可输出；`sleep_history_incomplete` 只阻止 Recovery 达到 `high`。
- 前一日 Strain 仅在该日是**完整日**时参与；缺失、provisional 或 incomplete 时该补偿为 0，并显示原因。
- 一期不把午睡自动等额抵扣主睡眠债，午睡单独展示。
- 动态需求的总额外补偿天然限制为 90 分钟；这不是医学处方，详情页必须分别展示两种补偿。
- 任意一天 Strain 重算后，必须重算下一当地日的动态需求和 Recovery。

### 5.2 分数和解释

`Sleep Performance = roundHalfAwayFromZeroToInteger(min(100, 100 × 实际主睡眠分钟 / 动态睡眠需求分钟))`。没有主睡眠或没有基础目标时不出分。

效率、夜间清醒和作息规律性不是隐藏进这一分数的任意权重，而是与该分数并列的解释卡：

- 睡眠效率：实际睡眠 / 卧床时间；
- 连续性：夜间清醒分钟与片段；
- 规律性：入睡和起床时间相对于过去 14 个主睡眠日的中位时间。

这使“睡够了但中断多”与“睡得连续但时长不足”都能被清楚解释。没有主睡眠或没有基础目标时不出分；少于 14 个睡眠历史日仍可出分，但规律性显示校准中。

## 6. Recovery（0–100）

### 6.1 输入与基线

Recovery 日期 `D` 优先取主睡眠的本地 `civilEndDate`；没有主睡眠时取该用户健康时区下的当地日历日，以便无睡眠目标时仍能用当日 HRV/RHR 出分。它使用同为 `D` 的 Google daily HRV、daily RHR，以及（若存在）该主睡眠的 Sleep Performance。HRV（高于个人常态通常更好）和 RHR（低于个人常态通常更好）分别以 `D` 之前的有效同字段日为窗口，使用中位数与 MAD（median absolute deviation）生成稳健个人基线，避免一两个异常夜晚决定常态。

有效历史日的规则：

- 某个生理子信号在有 **7 个**严格早于 `D` 的有效同字段日时可用；它自己的 7–27 日窗口为“临时基线”，28 日及以上为“稳定基线”。窗口取最近 `min(28, 有效历史日数)` 个值。
- HRV、RHR、睡眠各自独立统计有效日；缺失数据不补零。因此有 7 日 HRV 基线的用户可用 HRV + Sleep Performance 获得 Recovery，即使 RHR 尚无足够基线；也可以在没有睡眠目标时用 HRV + RHR 出分。

### 6.2 合成与安全显示

三个子信号的默认比例为 HRV 40%、RHR 30%、Sleep Performance 30%。HRV 有效值为 5–250 ms，RHR 有效值为 25–130 bpm，超出范围的日值不进入窗口、也不作为当日输入。对有足够历史的 HRV/RHR 子信号，令 `m` 为窗口中位数（偶数个点取两个中位值的算术平均）、`MAD` 为 `|x − m|` 的中位数、`s = max(1.4826 × MAD(window), floor)`，其中 HRV 的 `floor = 2 ms`、RHR 的 `floor = 3 bpm`。

- `HRV_subscore = clamp(50 + 15 × (HRV(D) − m) / s, 0, 100)`；
- `RHR_subscore = clamp(50 − 15 × (RHR(D) − m) / s, 0, 100)`；
- `Sleep_subscore = Sleep Performance(D)`。

子分保持未四舍五入的浮点，Recovery 是可用子信号按默认权重重新归一化后的加权平均，最后 `roundHalfAwayFromZeroToInteger`。当天至少要有两个核心子信号才出分。没有睡眠目标或没有主睡眠时，Sleep 子信号缺席，HRV+RHR 仍可出分。`clamp` 把数值限制在 0–100。

质量规则按以下顺序判定：

1. 少于两个核心子信号，或参与的睡眠/生理记录未通过值域校验：`unavailable`，不出分；
2. 计算时刻距离这些输入最近一次成功同步超过 36 小时：最多 `provisional`（记录仍在则仍出分，不因 6 小时或 1 小时同步间隙变成 unavailable）；
3. 任一参与的 HRV/RHR 子信号只有 7–27 日基线，或 Sleep Performance 标记 `sleep_history_incomplete`：`provisional`；
4. 三项齐全，且 HRV、RHR 都有至少 28 日基线、动态睡眠需求完整、同步未过期：`high`；
5. 其余可出分组合（例如稳定 HRV + Sleep、或稳定 HRV + 稳定 RHR 但缺 Sleep）：`medium`。

`unavailable` 只显示“数据不足/同步待完成”，不显示“恢复偏低”。

Recovery 的文字仅表示相对个人近期常态，不能推导为“安全加练”“必须休息”或任何诊断。首页、历史页和 AI Coach 统一禁止把任何 Recovery 分数转换为训练安全许可；`provisional` 或数据不足时，Coach 只能给出保守的记录/主观感受建议。现有“可按原计划安排训练”一类首页文案必须移除或改为不带许可含义的事实描述。

## 7. AI Coach 数据契约

AI 只读取服务端构建的短生命周期 `coach_context`：当前三个指标、过去 28 日聚合趋势、质量、同步状态、最多十条可追溯证据及用户目标。它不读取逐点/分钟心率、OAuth 凭证、完整 Health API 响应或餐食照片。

每条建议必须返回可校验的行动、指标证据（值、日期和质量）、不确定性和非医疗提示。后端校验证据确实存在于本次上下文；不通过时退化为确定性的“数据状态说明”。产品的任何其他页面也不得把分数解释为训练安全许可。

## 8. 验证与验收

上线前必须完成以下验证：

1. **API 映射：** 用真实授权账户验证原始心率、每日区间与区间时长是否可用，特别验证 Fitbit Air 样本是否足以提供 `motionContext`；记录实际返回形态，不把 API 文档假设写成数据事实。
2. **数据一致性：** 同日图表、区间时长、Strain 和 Coach 引用使用同一份当天 Google 区间阈值和 `google-wearables` source family；旅行/DST 后不会用今天的时区重写旧日。缺可信 IANA 时区时，该日只能展示、不能成为完整日；首个匹配 IANA 时区写入后，已保存的匹配历史分钟必须本地重索引并使符合其他规则的历史日可出完整 Strain，offset 不匹配的日期仍保持 `timezone_ambiguous`。
3. **去重与迟到数据：** 重叠窗口重复同步不会重复增加分钟或时长；睡眠/日指标修订会更新相应日期。原始心率第二页失败时成功水位不变、重试后不缺失/不重复；单类型失败保留其错误和退避，其他类型可成功推进。
4. **全天低区间保护：** 静止的低区间时长只展示、不进入 Strain 剂量；无可归因活动分钟时完整日 Strain 为 0，覆盖不足时为未知而非 0；过去不完整日若有活动分钟可出 `provisional`，不可出 0.0。
5. **基线门槛：** 每个生理字段在 7 个历史有效日后可参与 provisional Recovery；HRV + Sleep 可在 RHR 基线不足时出分；HRV + RHR 可在没有睡眠目标时出分；28 日后升为稳定；Strain 不受该门槛阻塞。
6. **覆盖不足：** 对 30/75 秒分钟规则、跨页 lookahead、缺失 `motionContext`、480/120 分钟已知-context 覆盖阈值、三段各 90 分钟及 240 分钟最大缺口、180/90 分钟最新样本阈值、DST 23/25 小时日写单元测试；缺区间、缺心率或同步失败时不输出“偏低”、不把未知算作零。
7. **睡眠目标与睡眠债：** 无目标不出 Sleep Performance，但仍可出 HRV+RHR Recovery；300、900 边界值可保存；设置在当地日 `T` 后只从 `T+1` 的主睡眠生效。睡眠债覆盖 7 个日历日，取最长非午睡分钟（可低于 180）；没有非午睡日按 0 计债并标记 `sleep_history_incomplete`，不得整段清零。Strain(D) 变化必须重算 Sleep/Recovery(D+1)。
8. **可重放：** 对固定输入断言精确的 dose、0.1 Strain、取整后的动态睡眠需求和整数 Recovery；偶数窗口的 median 取中位平均；同一份聚合输入、相同 `metricVersion: whoop-style-v2` 得到完全相同的结果，算法调整只产生新版本。
9. **安全：** Coach 和首页都不把 Recovery 当成高强度训练许可；低质量数据不生成个性化高强度建议，不诊断或承诺训练安全。

## 9. 当前账户已观察事实（2026-08-31）

本地 `health_snapshots` 最近一次成功同步只包含睡眠、每日 HRV、每日 RHR 和按日训练负荷，**没有** raw `heart-rate`、`daily-heart-rate-zones` 或 `time-in-heart-rate-zone`。现场探针因 refresh token 过期失败，因此下列心率能力仍未验证，实施前必须先重授权并跑 Task 0。

已观察、并已写进算法的事实：

- 睡眠/HRV/RHR 记录的 `utcOffsetMinutes` 全部为 `+480`；首条 IANA 时区只要与 +08:00 匹配，即可本地重索引现有历史。
- 快照窗口内有连续多个主睡眠日，主睡眠均远高于 180 分钟；另有明确午睡。主睡眠门槛对当前账户不是问题，但缺日/短睡眠规则仍按第 5 节实现，避免以后断崖。
- 日 RMSSD 的日间波动远小于旧 5 ms floor，因此 HRV floor 改为 2 ms。
- 现有调度是每 6 小时成功一次。若 Recovery 用 150 分钟同步过期直接 `unavailable`，两次同步之间 Recovery 会空白。过期阈值改为 36 小时，且只降质量、不删分。
- 无锻炼日目前被快照标成 `complete` + `load=0`。这是旧训练负荷口径，**不能**搬到 Strain：没有已知-context 覆盖的休息日是未知，不是 0.0。
- 当前代码用写死的 480 分钟睡眠目标出分。v2 必须在用户确认目标之前停止输出 Sleep Performance。

未观察、保持失败关闭：

- Fitbit Air 的 `heartRate.metadata.motionContext` 是否在清醒/睡眠/锻炼中出现 `ACTIVE` / `SEDENTARY`；
- 四个日区间是否相邻且 `max = 下一段 min`；
- `time-in-heart-rate-zone` 用 dailyRollUp 还是 interval 加总更稳。

## 10. 参考

- Google Health：[`heart-rate`、HRV 与 RHR 数据类型](https://developers.google.com/health/data-types/vitals)
- Google Health：[全部数据类型及支持的读取/汇总方式](https://developers.google.com/health/data-types)
- Google Health：[数据点与 `DailyHeartRateZones`、`TimeInHeartRateZone` 字段](https://developers.google.com/health/reference/rest/v4/users.dataTypes.dataPoints)
- Google Health：[`reconcile` 去重连续数据流](https://developers.google.com/health/reference/rest/v4/users.dataTypes.dataPoints/reconcile)
- WHOOP：[Recovery 的公开输入说明](https://developer.whoop.com/docs/whoop-101/)
- WHOOP：[Strain 的连续心率与非线性范围说明](https://www.whoop.com/us/en/thelocker/how-does-whoop-strain-work-101/)
