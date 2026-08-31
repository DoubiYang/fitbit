# Google Heart Rate 驱动的 WHOOP 风格指标设计

**状态：** 已确认并通过规格审阅，待实施
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
| `heart-rate` | 时间轴、尚未结束日期的临时聚合、活动/静止判断 | 读取逐点 `sampleTime`、`beatsPerMinute` 与 `motionContext`；通过 `reconcile` 消除不同来源的重复样本。 |
| `daily-heart-rate-zones` | 当日个人化区间阈值 | 直接读取当天各区间的 `minBeatsPerMinute` / `maxBeatsPerMinute`；这是 Google 按 Karvonen 算法产生的日阈值。 |
| `time-in-heart-rate-zone` | 全天区间时长展示与原始数据交叉校验 | 读取按日汇总结果，展示用户在各区间的全天时长；**不直接用于 Strain**，因为它包含静止低区间。 |
| `daily-heart-rate-variability` | Recovery 的 HRV 输入 | 读取日 RMSSD（毫秒）。 |
| `daily-resting-heart-rate` | Recovery 的 RHR 输入 | 读取每日静息心率。 |
| `sleep` | Sleep Performance、Recovery 的睡眠输入 | 主睡眠、实际睡眠、卧床、清醒片段及 civil time。 |
| `exercise` | Strain 来源解释与日内去重 | 标记有名称的锻炼会话；不是全天 Strain 的唯一来源。 |

`daily-heart-rate-zones` 是阈值的唯一首选来源；不得以「历史最高心率」作为最大心率，也不得写死截图中的任意 bpm 数字。只有四个有序区间 `light`、`moderate`、`vigorous`、`peak` 都存在、每段 `min ≤ max`，且相邻边界满足前一段 `max =` 后一段 `min` 时，才可为该日计算 Strain。归类固定为各段 `[min, max)`，只有 `peak` 为 `[min, max]`；因此相邻边界不会重复计入或被误判为重叠。Google 会按天调整阈值，因此历史日期必须保存并使用该日期的阈值，不能用今天的区间重算过去。

原始逐点心率是采样数据而不是「每分钟必有一个点」。每日 Google 数据类型的 `date` 是该日阈值和日汇总的权威当地日期。原始点按其 API 返回的 `physicalTime` 时区/offset 分到当地分钟；持久化时保存 `civil_date`、UTC minute instant、当时 UTC offset 和可用的 IANA time zone。没有可用时区/offset 的原始点不得用于 Strain 完整日判定。旅行或夏令时切换只影响新点的当地日期；历史 `civil_date`、offset 和计算结果永不按当前设备时区重写。DST 的 23/25 小时日仍按当地墙上时间处理。

### 2.2 降级规则

1. 有 Google 当日区间和 `time-in-heart-rate-zone` 汇总：展示完整日的全天区间时长；它不是 Strain 输入。
2. Strain 只接受“可归因活动”的原始心率分钟（`motionContext=ACTIVE`）或与已知 `exercise` 会话重叠的心率分钟。缺少这两者时，即使有全天区间汇总，也不出全天 Strain。
3. 当日区间缺失：不伪造个人化区间、不用历史最高心率替代；全天 Strain 显示“心率区间未提供”，只展示原始心率或已知锻炼。
4. 不完整当前日可以显示“截至现在”的 provisional Strain，必须明确标识不可与完整日直接比较。

## 3. 同步、留存与完整性

### 3.1 同步策略

- 用户首次授权后，回填最近 **35 个当地日**。35 天只是拉取缓冲和稳定基线目标，不是指标显示门槛。
- 每个已连接用户每 **1 小时**同步一次。
- 原始心率、区间时长和锻炼使用各自上次成功水位减 2 小时的重叠窗口，幂等 upsert；睡眠、HRV、RHR 与每日阈值使用各自最近 48 小时重叠窗口，吸收设备迟到修订。
- 每一种数据类型有独立水位。一个窗口内的数据 upsert、相应日的指标重算、该数据类型水位推进必须在同一数据库事务中完成。429、网络故障、令牌错误均不得把失败窗口标为已同步；采用带抖动的退避重试，并在用户可见状态中标记同步失败。
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
| `daily_cardio` | `(user_id, civil_date)` | 活动归因后的分区分钟数、覆盖率、完成状态、全天/进行中 Strain 及来源。 |
| `health_sync_cursors` | `(connection_id, data_type)` | 每种数据类型的成功水位、最后错误和重试状态。 |
| `metric_results` | `(user_id, civil_date, metric_name, metric_version)` | 指标输入摘要、分数、质量和计算时间；同版本同日以最新成功重算为准，新版本新增行。 |
| `user_sleep_goal_history` | `(user_id, effective_civil_date)` | 用户手动确认的基础睡眠目标（分钟）及其生效日；不以之后的设置重写历史指标。 |

首次 35 日回填的 `heart-rate` 必须按当地日分段并分页处理：每一页先转为分钟聚合批量 upsert，再释放该页原始点；不得把 35 天高频样本或完整 API JSON 一次性装入内存。删除连接/账户时，上述以用户或连接为外键的数据在同一删除事务中级联清除。

不保存单个未聚合原始心率样本，不将 token、完整 API 原始 JSON 或分钟数据传给 AI Coach。用户删除连接或账户时，连接令牌和对应健康聚合数据必须按账户删除流程一并清除。

### 3.3 覆盖率与完整日

每个 `daily_cardio` 记录至少包含：当地日期、区间阈值版本、活动归因后的各区间分钟数、原始心率覆盖分钟数、活动覆盖分钟数、来源、日是否完成、最后同步时间。

分钟覆盖采用固定规则：一个原始样本从其 `sampleTime` 延伸至下一样本，但最长只延伸 75 秒；跨度按本地分钟边界拆分。单分钟累积至少 30 秒有效覆盖才成为可用分钟。一个分钟有多个 context 时，取覆盖秒数最多者；相同覆盖秒数时优先 `ACTIVE`、再 `SEDENTARY`、最后未知。`motionContext` 缺失或未识别时就是 `unknown`，既不代表静止也不代表活动。

只有主导 context 为 `ACTIVE` 或与已确认 `exercise` 会话重叠至少 30 秒的分钟可计入 Strain；未分区或低于最低 Google 区间的活动分钟不产生剂量。完整日与进行中日的“心率覆盖”只累计主导 context 已知为 `ACTIVE` 或 `SEDENTARY` 的分钟；`unknown` 覆盖不会证明用户未活动，也不能补足完整性门槛。

- 已过去的日期：当天 Google 阈值存在、已知 context 的原始心率覆盖至少 480 分钟、当天最后一个已知-context 样本距当地日结束不超过 180 分钟，且当地 `06:00–12:00`、`12:00–18:00`、`18:00–24:00` 三个时段各至少有 90 分钟已知-context 覆盖、任一时段内无超过 240 分钟的连续已知-context 覆盖缺口，才可标记为完整；否则是 `incomplete`，不输出完整日 Strain。DST 日按真实当地时间计算各时段。
- 当天：永远是进行中；Google 阈值存在、已累计至少 120 分钟已知-context 覆盖且最新已知-context 样本距当前时刻不超过 90 分钟时，才显示截至当前的 `provisional` Strain。
- 只有满足完整日资格、且不存在活动归因分钟（含 exercise 覆盖的未知-context 分钟）时，才输出 0.0 Strain；不具备完整日资格时未知不是零。
- 数据缺口、Google 未给区间阈值、或时间段无法可信归因时：不把它当作零负荷，也不输出“偏低”结论。

## 4. 全天 Strain（0–21）

### 4.1 含义

Strain 代表全天可观测的**心肺**负荷，包含命名锻炼和日常活动；不能声称覆盖力量训练的肌肉负荷。页面必须同时展示“全天心肺负荷”的限定语和数据来源构成，避免把通勤、散步与正式训练混为同一个锻炼列表。

### 4.2 计算层次

1. **阈值层：** 取当天 `daily-heart-rate-zones` 的 Google 个性化边界。
2. **分钟层：** 以逐分钟聚合心率按同日阈值归入 `light`、`moderate`、`vigorous`、`peak`；全天 `time-in-heart-rate-zone` 只做展示与交叉校验，不能替代此层。
3. **活动归因层：** 只保留 `motionContext=ACTIVE` 或已知 `exercise` 会话内的分钟。静止低区间时间只用于展示心率，不按“一分钟一次训练”计入负荷。这避免“全天 14 小时低区间”被误计为高 Strain。
4. **剂量层：** 对活动分钟按由低到峰的固定系数 `0.5 / 1 / 2 / 3` 累积：`dose = 0.5 × light + 1 × moderate + 2 × vigorous + 3 × peak`。该做法借鉴 Edwards TRIMP 的区间递增原则；轻区间系数特意更低，以适配全天而非单次训练的统计范围。
5. **展示层：** `strain = roundToOneDecimal(21 × (1 − exp(−dose / 140)))`，结果限制为 `[0, 21]`。这个固定的递减收益映射使额外负荷在高端需要更大的剂量；它不是 Google/WHOOP 的私有公式，也不使用用户历史最高心率。

`strain-v2` 的上述系数、分母、四舍五入和数据质量规则全部冻结。后续若要调整，新增版本并保留旧结果，绝不静默改写趋势。离线回放必须验证分数随剂量单调、静止低心率不会增加剂量，并与已知锻炼区间时长方向一致。

### 4.3 显示与数据量

- 第一日有足够的活动心率/区间数据，即可显示全天 Strain；不要求 7 天或 35 天基线。
- 没有 Google 区间或覆盖不足时，不出伪精确的 0–21 分数，改为数据缺失说明。
- 7–27 天的历史可显示“初始个人范围”，28 天以上显示“个人范围较稳定”；这影响解释和趋势基线，不阻塞日 Strain。
- 详情页显示：当前数值、完成/进行中、各区间活动时长、数据来源、覆盖情况及 `metricVersion`。

## 5. Sleep Performance（0–100）

### 5.1 睡眠需求

用户必须在首次计算前确认自己的基础睡眠目标。它保存为 `user_sleep_goal_history` 的正整数分钟值（300–900 分钟）；没有目标时不出 Sleep Performance 或 Recovery。设置在用户当地日 `T` 发生时，以 `effective_civil_date = T + 1` 写入，作用于下一次主睡眠结束日期及之后的日期；编辑目标不会改写 `effective_civil_date` 之前已保存的结果。`GET/PUT /api/settings/sleep-goal` 只读取/新增该用户自己的设置，服务端验证范围与生效日期，前端显示为用户偏好而非医学处方。

对睡眠日期 `D`，系统选取 `effective_civil_date ≤ D` 的最新目标，计算动态睡眠需求：

`动态需求(D) = 基础目标 + min(60, 0.5 × 睡眠债(D)) + min(30, 5 × max(0, Strain(D−1) − 10))`

- `睡眠债(D)` 为 `D` 之前连续 7 个当地日期的 `Σ max(0, 基础目标 − 实际主睡眠分钟)`；始终以基础目标计债，避免动态目标递归放大。
- 只有前 7 个日历日全部有主睡眠时才计算睡眠债；否则债务补偿为 0，动态需求质量标记 `sleep_history_incomplete`，不得静默跳过未佩戴日期。Sleep Performance 仍可使用基础目标和可用的前日 Strain 输出，但不能取得 `high` Recovery 质量。
- 前一日 Strain 仅在该日是完整日时参与；缺失或未完整时该补偿为 0，并显示原因。
- 一期不把午睡自动等额抵扣主睡眠债，午睡单独展示。
- 动态需求的总额外补偿天然限制为 90 分钟；这不是医学处方，详情页必须分别展示两种补偿。

### 5.2 分数和解释

`Sleep Performance = roundToInteger(min(100, 100 × 实际主睡眠分钟 / 动态睡眠需求分钟))`。

效率、夜间清醒和作息规律性不是隐藏进这一分数的任意权重，而是与该分数并列的解释卡：

- 睡眠效率：实际睡眠 / 卧床时间；
- 连续性：夜间清醒分钟与片段；
- 规律性：入睡和起床时间相对于过去 14 个主睡眠日的中位时间。

这使“睡够了但中断多”与“睡得连续但时长不足”都能被清楚解释。没有主睡眠或没有基础目标时不出分；少于 14 个睡眠历史日仍可出分，但规律性显示校准中。

## 6. Recovery（0–100）

### 6.1 输入与基线

Recovery 日期固定为主睡眠的本地 `civilEndDate` `D`；它使用同为 `D` 的 Google daily HRV、daily RHR 和该主睡眠的 Sleep Performance。HRV（高于个人常态通常更好）和 RHR（低于个人常态通常更好）分别以 `D` 之前的有效同字段日为窗口，使用中位数与 MAD（median absolute deviation）生成稳健个人基线，避免一两个异常夜晚决定常态。

有效历史日的规则：

- 某个生理子信号在有 **7 个**严格早于 `D` 的有效同字段日时可用；它自己的 7–27 日窗口为“临时基线”，28 日及以上为“稳定基线”。窗口取最近 `min(28, 有效历史日数)` 个值。
- HRV、RHR、睡眠各自独立统计有效日；缺失数据不补零。因此有 7 日 HRV 基线的用户可用 HRV + Sleep Performance 获得 Recovery，即使 RHR 尚无足够基线。

### 6.2 合成与安全显示

三个子信号的默认比例为 HRV 40%、RHR 30%、Sleep Performance 30%。对有足够历史的 HRV/RHR 子信号，令 `m = median(window)`、`s = max(1.4826 × MAD(window), floor)`，其中 HRV 的 `floor = 5 ms`、RHR 的 `floor = 3 bpm`：

- `HRV_subscore = clamp(50 + 15 × (HRV(D) − m) / s, 0, 100)`；
- `RHR_subscore = clamp(50 − 15 × (RHR(D) − m) / s, 0, 100)`；
- `Sleep_subscore = Sleep Performance(D)`。

Recovery 是所有可用子信号按其默认权重重新归一化后的 `roundToInteger` 加权平均；当天至少要有两个核心子信号才出分。`clamp` 把数值限制在 0–100，MAD 为 0 时由上述 `floor` 保证计算稳定。

质量规则按以下顺序判定：

1. 少于两个核心子信号、相关同步超过 150 分钟、或参与的睡眠记录/生理记录不可信：`unavailable`，不出分；
2. 任一参与的 HRV/RHR 子信号只有 7–27 日基线，或 Sleep Performance 标记 `sleep_history_incomplete`：`provisional`；
3. 三项齐全，且 HRV、RHR 都有至少 28 日基线、动态睡眠需求完整：`high`；
4. 其余可出分组合（例如稳定 HRV + Sleep、或稳定 HRV + 稳定 RHR 但缺 Sleep）：`medium`。

`unavailable` 只显示“数据不足/同步待完成”，不显示“恢复偏低”。

Recovery 的文字仅表示相对个人近期常态，不能推导为“安全加练”“必须休息”或任何诊断。首页、历史页和 AI Coach 统一禁止把任何 Recovery 分数转换为训练安全许可；`provisional` 或数据不足时，Coach 只能给出保守的记录/主观感受建议。现有“可按原计划安排训练”一类首页文案必须移除或改为不带许可含义的事实描述。

## 7. AI Coach 数据契约

AI 只读取服务端构建的短生命周期 `coach_context`：当前三个指标、过去 28 日聚合趋势、质量、同步状态、最多十条可追溯证据及用户目标。它不读取逐点/分钟心率、OAuth 凭证、完整 Health API 响应或餐食照片。

每条建议必须返回可校验的行动、指标证据（值、日期和质量）、不确定性和非医疗提示。后端校验证据确实存在于本次上下文；不通过时退化为确定性的“数据状态说明”。产品的任何其他页面也不得把分数解释为训练安全许可。

## 8. 验证与验收

上线前必须完成以下验证：

1. **API 映射：** 用真实授权账户验证原始心率、每日区间与区间时长是否可用，特别验证 Fitbit Air 样本是否足以提供 `motionContext`；记录实际返回形态，不把 API 文档假设写成数据事实。
2. **数据一致性：** 同日图表、区间时长、Strain 和 Coach 引用使用同一份当天 Google 区间阈值和 `google-wearables` source family；旅行/DST 后不会用今天的时区重写旧日。
3. **去重与迟到数据：** 重叠窗口重复同步不会重复增加分钟或时长；睡眠/日指标修订会更新相应日期，水位和写入在同一事务中推进。
4. **全天低区间保护：** 静止的低区间时长只展示、不进入 Strain 剂量；无可归因活动分钟时完整日 Strain 为 0，覆盖不足时为未知而非 0。
5. **基线门槛：** 每个生理字段在 7 个历史有效日后可参与 provisional Recovery；HRV + Sleep 可在 RHR 基线不足时出分；28 日后升为稳定；Strain 不受该门槛阻塞。
6. **覆盖不足：** 对 30/75 秒分钟规则、缺失 `motionContext`、480/120 分钟已知-context 覆盖阈值、三段各 90 分钟及 240 分钟最大缺口、180/90 分钟最新样本阈值、DST 23/25 小时日写单元测试；缺区间、缺心率或同步失败时不输出“偏低”、不把未知算作零。
7. **睡眠目标：** 无目标不出 Sleep Performance；300、900 边界值可保存；设置在当地日 `T` 后只从 `T+1` 的主睡眠生效，更新目标不会改变此前日期的结果。
8. **可重放：** 对固定输入断言精确的 dose、0.1 Strain、动态睡眠需求和整数 Recovery；同一份聚合输入、相同 `metricVersion` 得到完全相同的结果，算法调整只产生新版本。
9. **安全：** Coach 和首页都不把 Recovery 当成高强度训练许可；低质量数据不生成个性化高强度建议，不诊断或承诺训练安全。

## 9. 参考

- Google Health：[`heart-rate`、HRV 与 RHR 数据类型](https://developers.google.com/health/data-types/vitals)
- Google Health：[全部数据类型及支持的读取/汇总方式](https://developers.google.com/health/data-types)
- Google Health：[数据点与 `DailyHeartRateZones`、`TimeInHeartRateZone` 字段](https://developers.google.com/health/reference/rest/v4/users.dataTypes.dataPoints)
- Google Health：[`reconcile` 去重连续数据流](https://developers.google.com/health/reference/rest/v4/users.dataTypes.dataPoints/reconcile)
- WHOOP：[Recovery 的公开输入说明](https://developer.whoop.com/docs/whoop-101/)
- WHOOP：[Strain 的连续心率与非线性范围说明](https://www.whoop.com/us/en/thelocker/how-does-whoop-strain-work-101/)
