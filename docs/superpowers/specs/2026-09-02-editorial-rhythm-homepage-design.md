# 编辑式「节律」首页重设计

**状态：** 已实现并经已登录移动画布复核
**日期：** 2026-09-02
**视觉目标：** 本轮 ImageGen 的第二张已选首页概念（本机可复核原图：`/Users/shenyang/.codex/generated_images/01a023a6-a1aa-7193-8795-4c3ce87f776a/exec-6be6cb84-5373-4e97-975f-db9208824f92.png`）：温白阅读面、编辑式日期排版、恢复状态与全天负荷趋势并列、深绿主操作。它只定义视觉和信息层级，不复刻 WHOOP 或 Google Health 的私有界面或算法。

## 1. 目标与范围

重做已登录用户的 `/rhythm` 首页，让用户在数秒内得到三件事：

1. 今天恢复相对个人常态的状态；
2. 截至当前已观测到的全天心肺负荷；
3. 一个明确、非医疗性的下一步，以及记录餐食入口；
4. 在条件满足时，查看独立定义的“身体年龄”心肺参考等价值。

本次重做首页及其必要的服务端显示投影、投影来源标识、测试和共享样式。餐食工作流、OAuth、Google 写回及 AI Coach 契约均不改变。唯一新增指标是由独立规格 [`2026-09-02-body-age-v1-design.md`](2026-09-02-body-age-v1-design.md) 定义的 `body-age-v1`；其资料填写和日汇总存储属于该规格，首页只消费已净化的显示投影。为确保只显示与保存分数同一输入集的时间线，可以给既有 `daily_cardio` / `metric_results` 增加只读 provenance 与质量 flag 列；不改变既有 Strain/Recovery/Sleep 公式。现有首页的“全天心肺负荷”不是训练安全许可；新界面不得把它、Recovery 或身体年龄表达成“可以/不可以训练”。

手机是唯一的页面目标（390 × 844）。桌面浏览器同样呈现这一张居中的 426px 手机画布；不增加桌面网格、宽屏卡片或第二套信息层级。

## 2. 现状问题与设计结论

当前页面把 `全天心肺负荷` 放在首屏之后的解释性指标列表中；恢复与“数据临时”的说明重复出现；建议区域又包一层数据状态，造成卡片嵌套。结果是用户先读到系统的限制，后才看到当天的负荷。桌面最大宽度又被固定在 46rem，信息密度与可用空间不匹配。

新版的结论是：

- **负荷不是附录。** 恢复和当前全天负荷共同构成首屏主叙事，负荷有一条真实的日内观测时间线。
- **不确定性不消失，但后退一层。** 每项仍保留质量与证据；首页只用一处简短、可展开的说明，不能再用两张大卡重复“临时”。
- **建议是解释，不是主画面。** 它只保留一条保守、可执行的短句，避免用建议替代指标本身。
- **餐食是明确的日常动作。** `记录一餐` 是当屏唯一实心主 CTA，不提前同步、不改既有餐食流程。

## 3. 视觉与信息设计

### 3.1 设计语言

沿用现有节律 token：暖白画布 `#F7F6F1`、深墨字 `#172826`、浅鼠尾草 `#E8F0EC`、深绿 `#2F765E`、鼠尾草 `#8EACA2`。保留系统中文无衬线字体和 tabular numbers。

- 页面左右留白 20px；首屏区块间距 24–32px；正文不小于 15px。
- 使用排版、留白、浅表面和细分隔线区分层级；不出现卡片套卡片，也不为每项指标再包一张白卡。
- 深绿只承担关键状态和唯一实心 CTA；黄色/红色只表达真实注意/错误状态。
- 使用现有 `lucide-react` 图标；除建议卡右侧的一张项目内植物装饰图外，不增加照片、手写 SVG、emoji 或外部字体资源。

### 3.2 390px 首页布局

从上到下固定为以下阅读顺序：

1. **紧凑页头：** `节律`、品牌短句、`今日 · 9月2日` 和一个带可访问名称的账户链接（`/rhythm/account`，与原型的头像入口一致）。同步新鲜度作为小文本标记，而非独立卡；真正的设置操作继续从数据质量或身体年龄的上下文链接进入。
2. **数据质量提示：** 当任一主指标为 provisional/incomplete/unavailable，或 `freshness === 'stale'` 时，只出现一次简短的 `数据仍在积累` / `数据待同步` 文字按钮。展开后才展示对应的质量、覆盖和来源；该入口不显示 raw BPM、心率阈值或 OAuth 信息。
3. **恢复状态：** 左侧环形进度或半环、整数分数及状态文字（例如“恢复中”）。它表示相对个人近期常态；无分数时显示 `—` 和已有的真实缺失原因，绝不造分。身体年龄在恢复文字下方作为紧凑行呈现，带 `?`；只有 `body-age-v1` 的净化投影可用时显示年龄和初步/稳定标签，否则显示真实的积累/资料/过期原因。问号打开来源、公式、输入覆盖与局限说明，具体约束以独立身体年龄规格为准；它不显示逐日 VO₂max，也不成为训练建议。
4. **全天心肺负荷：** 标题、截至当前的 `x.x / 21` 和 `当前负荷` 标签。下面是一条从早到晚的**已验证累计 Strain 轨迹**：只以实际已观测、可归因的聚合分钟重放既有 Strain 剂量；当前时刻后不画预测线。若中间缺少合格心率分钟且前后均有已观测分数，可用低对比虚线连接两个边界，并在图例和文本中明确标为“数据缺口，未计入负荷”；它不是测量值、预测或分数增量。该轨迹只有在重放结果与已保存 Strain 分数一致时才出现；不显示分钟 BPM，也不替代 Strain 计算。
5. **一句建议：** 只沿用 `TodayView.primaryAction` 的事实性文案。仅在 `freshness === 'fresh'` 且 Recovery 为 high/medium 时可说明“相对近期常态”；连接/数据为 stale、临时或缺失时，只说明该数据限制与可用的下一步，不能给高强度训练建议。
6. **记录一餐：** 现有 `/rhythm/meals/new` 链接，作为唯一的实心深绿色大按钮。
7. **底部导航：** 延续 今日 / 餐食 / 账户，安全区、触达面积和焦点行为保持现有 AppShell 约束。

睡眠表现不再与核心指标争夺首屏。当 Sleep Performance 不可用且可通过设置解决时，把“设置睡眠目标”放入展开的数据质量区；它不是第二个主 CTA。

### 3.3 电脑中的手机画布

`/rhythm` 在任意浏览器宽度都维持同一列、同一阅读顺序和同一底部导航：画布最大宽度为 26.625rem（426px），小屏时占满可用宽度，大屏时居中显示。恢复、全天负荷、身体年龄、提示和餐食 CTA 不得进入双栏；固定导航也与画布同宽，不能横跨桌面浏览器。

## 4. 数据投影与真实性约束

### 4.1 不变的指标语义

- `Recovery`、`全天心肺负荷（Strain 0–21）`、`Sleep Performance` 继续完全由现有 `whoop-style-v2` 计算、质量门槛和同步数据驱动。
- `complete`、`provisional`、`incomplete`、`timezone_ambiguous` 与 `unavailable` 的含义和分数可用性不改。未知绝不显示为零；无分数显示 `—`。
- 每小时同步中，心率与 `activity-level` 均以各自成功水位向前 24 小时的 UTC 物理窗口重新 reconcile；因此延迟到达的数据会在下一次同步自动回补、重算当天 Strain 和时间线。该策略只更新本地分钟聚合、活动 interval 与派生指标，不保留 raw 心率样本。
- 首页不得显示“偏低”“安全加练”“必须休息”等健康或训练许可结论。

### 4.2 新增只读时间线投影

现有 `TodayView` 只有日汇总，无法诚实地渲染选中概念中的日内曲线。为此，在 `buildTodayView` 中添加一个仅供显示的可选 `strainTimeline` 投影，不新增写回、路由或第三方 API 调用：

```ts
type StrainTimeline = {
  observedThrough: string | null; // UTC instant；展示时按当天 IANA 时区格式化
  buckets: Array<{
    start: string; // UTC instant，连续 15 分钟真实时段，不使用 localMinuteOfDay 定位
    end: string;
    label: string; // 当地标签；重复小时需要携带 UTC offset
    observedHeartRateMinutes: number; // 0–15；有合格分钟心率覆盖
    knownContextMinutes: number; // 0–15；有活动上下文的分钟
    attributedMinutes: number; // 0–15；真正进入 Strain 归因的分钟
    intensity: 0 | 1 | 2 | 3 | null; // null 表示该 bucket 无可呈现的归因强度
    cumulativeScore: number | null; // 重放到此 bucket 的累计 Strain；只有整日校验通过时可用
  }>;
};
```

它从当天已经保存的 `HeartRateMinuteAggregate`、当天 Google 心率区间、运动 interval 和当天的只读睡眠会话生成。OAuth 页面必须通过现有 `today-response` 的、用户范围内的持久化 health snapshot 取得 `sleepSessions`；不得为渲染页面调用 Google API，也不得在 snapshot 缺失、同步 stale 或没有覆盖目标日的睡眠会话数据时冒险渲染时间线。

仅把满足**当前 Strain 函数**归因资格的分钟映射为低/中/高/峰强度。现有逻辑的 exercise overlap 优先级高于 sleep overlap；本次时间线必须完整复用这一优先级，不能以视觉层擅自把 exercise+sleep 重叠分钟排除，也不能改变 `whoop-style-v2`。`observedHeartRateMinutes > knownContextMinutes` 表示有心率但未知上下文，`knownContextMinutes > attributedMinutes` 表示已知但未归因，`attributedMinutes > knownContextMinutes` 在 exercise 归因中允许出现；这些状态以连续 15 分钟位置分别呈现。每个 bucket 均以 UTC instant 排序；23/25 小时 DST 日分别产生 92/100 个 bucket，重复本地小时在 label 中带 offset，绝不压缩、合并或按固定 `0–1440` 分钟重排。未来 bucket 不渲染强度。

时间线应标注“已观测至 HH:MM”，并且只在 Strain 分数非空、数据新鲜、区间/睡眠/分钟输入均齐全且 provenance 一致时显示。为此，Strain 重算必须把输入分钟、区间、活动 interval、exercise interval、睡眠 interval、IANA 时区和 metric version 的确定性 SHA-256 canonical fingerprint 同时写入 `daily_cardio` 和 Strain `metric_results` 的新增 `input_fingerprint` 字段。

这个 fingerprint 还必须纳入一份随分数持久化的、不可变的 `calculation_context`：`as_of_utc`（当日实际采用的 cutoff）、`is_current_day`、由完整时区历史解析出的 `time_zone_unambiguous`、该 civil day 的 `local_day_length_minutes`、时区历史的 canonical fingerprint，以及 metric version。它们是现有 Strain 计算的输入，不能在读首页时重新以“现在”的时间或当下时区历史推断。重算时将相同的 context 和 fingerprint 写入两张表；读取页必须以保存的 `as_of_utc` 过滤并 canonicalize 同一批只读输入，再验证「保存于 daily_cardio 的 fingerprint = 保存于 Strain metric result 的 fingerprint = 读取结果的 fingerprint」且两份 `calculation_context` 相同。读取端再按完全相同的分钟剂量规则重放每一个 bucket 的 `cumulativeScore`；终值必须等于已保存 Strain 分数。不能复现、context 缺失、任一值不同、无分数或过期时一律省略 timeline。它因此是一条与 `x.x / 21` 同一输入集、同一算法、已验证终值的逐点累计轨迹，而非预测或第二种负荷算法。

当时区不明确、没有区间、没有分钟数据、快照睡眠数据不可用、provenance 不一致或上述一致性前提不成立时，整个时间线省略，指标的既有 unavailable/incomplete 文案仍然生效。

这个 projection 不得重新计算或覆盖 `daily_cardio`、`metric_results` 或 Strain 分数。为了避免显示和算法口径分叉，归因资格与区间分类应提取/复用现有计算的纯函数；同一份分钟输入必须在测试中得到相同的归因结果。前端只接收 bucket 强度、时间位置、三类覆盖计数和观察截止时间，绝不接收逐分钟 BPM、采样点、token 或完整 Google 原始响应；该投影也不进入 AI Coach 上下文。

首页不再直接复用 `MetricEvidence`、`EvidenceList` 或 `ZoneBreakdown` 渲染质量 disclosure，因为它们可能包含静息心率数值或心率阈值。`buildTodayView` 必须先从内部完整 metric result 映射出新的 `HomepageTodayView`，`buildTodayResponse` 也只能 serialize 此模型；不再把完整 evidence、各区间 BPM、dose、zone minutes、source payload 或其他未经 allowlist 的字段送至浏览器。允许的字段仅为：分数/缺分状态、状态文字、数据种类名称、民用日期、质量、覆盖分钟、是否同步新鲜、sleep-history 完整性 flag、timeline bucket 与设置/餐食链接。原始 evidence 和完整区间阈值仍留在不属于本次首页的诊断层。

为支持最后一项，给既有 `metric_results` 增加 `quality_flags text[]`；sleep 重算把 `sleep_history_incomplete` 持久化为 sleep performance flag，Recovery 可读取同一 flag 以决定首页 disclosure 的真实文案。它只是一项质量元数据，不能携带 sleep 时长、HRV/RHR 或其他原始测量值。

## 5. 组件边界

| 单元 | 职责 | 依赖 |
| --- | --- | --- |
| `build-today` | 读取内部日指标、分钟聚合和 user-scoped snapshot 睡眠会话；做 provenance 校验后构造 sanitized `HomepageTodayView` 和可选时间线投影 | `HealthMetricsStore`、只读 snapshot、既有指标/归因纯函数 |
| `strain-timeline`（新 UI 组件） | 以语义化 label 和非原始 bucket 强度渲染日内图；缺数据时不渲染 | `StrainTimeline` |
| `today-dashboard` | 按选中结构组合页头、质量 disclosure、恢复、负荷、建议与 CTA | `TodayView`、展示组件 |
| `metric-card` / `data-state` | 保留给非首页或明确的缺失态；首页改用非原始字段 allowlist 的 disclosure，移除重复大卡职责 | 现有 metric view |
| `globals.css` / AppShell 样式 | token、响应式网格、焦点、reduced motion 与底部安全区 | 现有壳层 |

不在客户端拉取健康数据、不增加 React 客户端状态持久化；页面维持服务端渲染和现有路由行为。

## 6. 交互、错误与可访问性

- 数据质量使用原生 `<details>` 或语义等价、键盘可操作的 disclosure；触发器明确表述状态与“查看依据”，展开内容只列 allowlist 内的质量、覆盖、来源种类和同步新鲜度。颜色不是唯一表达，也不在首页输出 `MetricEvidence.value` 或区间 BPM。
- 所有链接、CTA 和 nav 项最少 44×44px，有 `:focus-visible`；屏幕阅读器能读出当前页、数值名称、分母 `/21`、时间线是“已观测强度，非预测”。
- 时间线通过文本文字替代（例如“已观测至 14:00；后续暂无数据”），不是只能看颜色或柱形；DST 重复小时的替代文字与可见 label 均带 UTC offset。
- `prefers-reduced-motion` 下不做图形增长动画；任何装饰性动画都不传递状态。
- `freshness: stale`、无 `strainTimeline`、无 Recovery、睡眠目标缺失、时区不明等状态保留现有可操作原因与真实设置链接。不能让漂亮的空白图被误解为零负荷。

## 7. 验收与验证

1. `/rhythm` 的 390px 首屏能在不向下滚动指标列表的情况下看到恢复、全天心肺负荷、数据状态入口和记录餐食动作；在桌面浏览器也保持同一 426px 居中手机画布与单列顺序，固定导航不得比画布更宽，无横向溢出或内容被底栏遮挡。
2. `strainTimeline` 只在所需数据及 SHA-256 input fingerprint 三方一致（`daily_cardio`、Strain metric result、以保存的 `as_of_utc` 和不可变 `calculation_context` 重放的当前只读输入）时出现；测试覆盖当前日 cutoff 变化、未来样本、时区历史变化及 23/25 小时 DST 日，任一项使 context 或 fingerprint 不一致就必须省略。已观测空档、无归因分钟、未知覆盖、exercise-without-context 和未来时段视觉上可区分；只有被两端已观测段夹住的空档才可显示带“数据缺口”含义的虚线，未来时段不画虚线。没有一段被当作预测或 0 Strain。没有读到相应睡眠快照时，时间线必须省略。
3. bucket 的强度/归因与现有 Strain pure calculation 对同一夹具一致，特别断言 exercise priority over sleep；投影不能改写保存的指标结果或让任何分数从 `null` 变成数字。fingerprint 不同、缺失或输入不同步时，projection 为 undefined。为 23 小时春季切换日与 25 小时秋季切换日分别测试 UTC 顺序、bucket 数、重复小时 label/offset 与截至时间。
4. 暂时、完整、缺失、时区不明和同步过期的页面均只显示一次显著数据质量入口；同步过期时 `primaryAction` 为数据状态而非相对常态建议；sleep-history-incomplete 有持久化的 allowlisted 质量 flag；不存在首页大卡嵌套或重复的质量段落，首页不显示 raw evidence/BPM。添加 API serialization 测试，断言 JSON 没有 `MetricEvidence.value`、区间阈值、dose、zone minutes 或其他未 allowlist 字段。
5. 保留 `/rhythm/meals/new`、设置、底部三个导航路径；首页改版不产生 Google 写回或健康数据写入。
6. 为 projection、Dashboard 静态结构、质量 disclosure、无分数与响应式 class 添加/更新单测；运行 `pnpm test`、`pnpm run lint`、`pnpm run build`。
7. 在同一 390×844 视口实际截图，和已选概念原图并列视觉 QA；再在桌面浏览器确认只是这张 426px 手机画布的居中预览。390px 必须依次出现编辑式日期、恢复摘要、全天负荷数值/时间线、身体年龄、单条建议和一个深绿全宽餐食 CTA；重点检查中文排版、日期、分母、timeline 空档、按钮高度、固定导航与安全区。原图路径记录在本文档顶部，若本机资产被清理，必须由用户重新提供视觉源后再宣布视觉 QA 通过。

## 8. 非目标

- 不新增除独立定义的 `body-age-v1` 以外的 WHOOP/Google Health 指标、历史图表页、训练记录页或新的导航项。
- 不将 Health Connect/Google 计算的 Readiness、Sleep 或 Cardio Load 当作可用 API 字段。
- 不修改数据保留政策、不保存 raw health payload，也不把分钟聚合、BPM 或凭证发送给 AI。
- 不以该首页替代医疗、训练教练或营养建议。
