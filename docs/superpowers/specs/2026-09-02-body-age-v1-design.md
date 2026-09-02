# 身体年龄 v1：可追溯的心肺年龄等价值

**状态：** 用户已确认方向，待独立规格审阅与实现计划  
**日期：** 2026-09-02  
**界面名称：** `身体年龄`

## 1. 决策与边界

第一版的 `身体年龄` 不会把睡眠、HRV、静息心率、步数或 Strain 任意加权成“综合年龄”。它只回答一个更窄、可复核的问题：**一项可审计、且有来源可比性证据的 VO₂max 测量，与公开的年龄/参考性别心肺适能常模相比，最接近哪一个年龄。**

标题仍显示“身体年龄”，但 `?` 必须把它定义为“心肺年龄等价值（cardiorespiratory age-equivalent）”。它不是完整生物学年龄、疾病风险、寿命预测、诊断或训练许可。资料、来源或证据条件不满足就显示精确原因，绝不造出年龄。

研究后更严格的决定是：**不能用 Google Health 的 `daily-vo2-max` 自动出身体年龄。** 该日汇总没有 measurement method；所以即使 `estimated` 为 false，也无法排除它已由年龄/参考性别等人口学资料导出。把这种数值再映射为年龄会有循环推断风险。v1 只接受带 measurement method、并符合来源证据政策的 `vo2-max` 数据点。

截至本规格日期，未找到 Fitbit Air 相对于 CPX 的同行评审、设备型号级验证。因此 `FITBIT_RUN` 从 Fitbit Air 的记录可以被同步并提示“来源待验证”，但**不能**解锁身体年龄数字。一个已有的 Fitbit Charge 2 独立验证研究不能被擅自外推到 Fitbit Air。`METABOLIC_CART` 也不能仅凭方法枚举自动通过：Google Health 未提供跑台/自行车、最大努力或测试协议，无法确认它对应 FRIEND 的跑台最大 CPX 常模。Fitbit Air 或直接测量都必须等到其确切来源、协议与参考表的匹配关系被收入经审阅的来源政策后才可显示数字。

这也意味着 v1 不复刻 WHOOP Healthspan 或 Garmin Fitness Age 的私有公式；用户能检查输入类型、论文表、来源政策与版本。

## 2. 研究基础与适用限制

### 2.1 为什么选择心肺适能

- 美国心脏协会（AHA）的科学声明将心肺适能（CRF）视为具有独立健康关联的重要指标，并主张在临床实践中常规评估；这支持选择 VO₂max/VO₂peak 作为一个单一的体能维度，但**不**使本产品成为医疗工具。[Ross et al., 2016](https://pubmed.ncbi.nlm.nih.gov/27881567/)
- FRIEND Registry 的同行评审研究以 8 个美国实验室、7,783 名无已知心血管病的 20–79 岁受试者的最大跑台 CPX 测试，给出按年龄十年段及性别分层的直接测得 VO₂max 常模和百分位。[Kaminsky et al., 2015](https://pubmed.ncbi.nlm.nih.gov/26455884/)
- 本项目采用该研究的 P50（中位数）参考点。下表可由公开转载表逐格核查；其来源仍是 FRIEND 跑台 CPX 数据，不是厂商算法或其它运动方式。[PLOS ONE 转载表](https://journals.plos.org/plosone/article/file?id=10.1371/journal.pone.0209897&type=printable)

| 参考年龄锚点（岁） | 25 | 35 | 45 | 55 | 65 | 75 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 男性参考表 P50 VO₂max（mL·kg⁻¹·min⁻¹） | 48.0 | 42.4 | 37.8 | 32.6 | 28.2 | 24.4 |
| 女性参考表 P50 VO₂max（mL·kg⁻¹·min⁻¹） | 37.6 | 30.2 | 26.7 | 23.4 | 20.0 | 18.3 |

### 2.2 设备输入的限制

FRIEND 是美国、无已知心血管病、跑台 CPX 的常模，不等同于中国一般人群、自行车测试或任意可穿戴设备。

对设备 VO₂max，系统综述/荟萃分析发现：基于运动的设备估计在群体平均层面的系统误差较小，但个体层面误差仍然很大；它明确不适合被包装成单个用户的临床/运动结论。[INTERLIVE systematic review and meta-analysis](https://pmc.ncbi.nlm.nih.gov/articles/PMC9213394/)

独立研究曾验证 Fitbit Charge 2 的“合格户外跑”CRF 与实验室 VO₂max 在 18–45 岁、健康且能跑步的受试者中有可接受的一致性，MAPE 小于 10%；该结论仅覆盖该设备、该人群和该使用条件，并不覆盖 Fitbit Air。[Klepin et al., 2019](https://pubmed.ncbi.nlm.nih.gov/31107835/)

因此，算法使用分层来源政策，而不是“只要是 Fitbit 或 Google 数字就可用”。每个新设备/来源必须拥有与目标使用条件相符的、可复核的比较证据；否则只能显示为来源待验证。即使来源合格，结果仍是参考匹配，不是经外部验证的生物学年龄。

## 3. 计算定义（`body-age-v1`）

### 3.1 用户资料和合格来源

1. 用户主动填写出生日期，用于显示与实际年龄的差值；**出生日期不参与 VO₂max 到参考年龄的反推。**
2. 用户主动选择“男性参考表”或“女性参考表”。这是为匹配论文仅提供的二元参考队列；不从姓名、照片、设备或其它资料推断。没有选择时不出结果。
3. Google Health 的 `vo2-max` 数据点。它由现有的 `activity_and_fitness.readonly` OAuth 权限覆盖，无需新增授权；其 `measurementMethod` 可区分 Fitbit 跑步、代谢车、Cooper、心率比和 Google 人口学等来源。[Google Health scope 与数据类型](https://developers.google.com/health/filters)；[VO₂max 字段和方法枚举](https://developers.google.com/health/reference/rest/v4/users.dataTypes.dataPoints)

合格来源由受版本控制的 `data/reference/body-age-source-policy-v1.json` 明确列出。每个条目必须同时给出：measurement method、已验证的设备/提供者 identity、记录方法、适用人群、独立比较研究、测试模式/协议，以及与 FRIEND 跑台 CPX 表匹配或替代参考表的理由。政策只允许下列未来可审核的类别：

- `METABOLIC_CART`：仅当可信来源同时证明跑台最大 CPX 协议与参考表匹配时才可登记；方法枚举本身不充分；
- 已在该政策文件逐项登记的 `FITBIT_RUN`：必须匹配证据所覆盖的设备/型号、资料来源、使用条件和人群边界；记录不匹配或来源元数据不足则拒绝；
- 未来新增的方法：必须有独立、可访问的参考标准比较研究，且评审明确记录适用设备、方法、人群、误差与限制后才可登记。

`GOOGLE_DEMOGRAPHIC`、`HEART_RATE_RATIO`、`PREDICTION_NON_EXERCISE`、`MEASUREMENT_METHOD_UNSPECIFIED`、`OTHER` 以及所有未登记方法一律不参与计算。`COOPER_TEST`、`MULTISTAGE_FITNESS_TEST`、`ROCKPORT_FITNESS_TEST`、`MAX_EXERCISE`、`PREDICTION_SUB_MAX_EXERCISE` 在有来源/人群匹配的独立验证前同样不参与。`daily-vo2-max` 和其 `estimated`/covariance/cardio fitness level 不进入 v1，也不能成为任何兜底。

初版来源政策是**空白 allowlist**：它有意不把 Fitbit Air 或没有协议 metadata 的 `METABOLIC_CART` 写成已验证来源。这样初版先提供资料/来源状态和科学解释，但不会给目前无法严谨比较的数据伪造结果。以后可添加不同版本的来源政策文件，但要引入新的算法/政策版本和完整审阅记录，不能静默改变历史结果；发布新 policy 还必须按 §4.2 受控重放近 365 天，不得只修改 hash 后把旧结果长期留在“数据待更新”。

### 3.2 质量状态

所有窗口以用户 Health 时区的 civil date 计算，未来样本绝不参与。

- **资料待补充：** 缺出生日期或参考表选择，显示精确资料入口。
- **来源待验证：** 同步到了 `FITBIT_RUN` 或其它 VO₂max，但未匹配当前来源政策。显示数据来源为何不能用；不显示年龄。
- **初步（只适用于未来获批准的可穿戴来源）：** 90 天窗口内至少 3 个不同 civil date 的合格读数、首末读数相隔至少 28 天、最新读数不超过 30 天。
- **稳定（只适用于未来获批准的可穿戴来源）：** 当前 90 civil-day 窗口内至少 6 个不同 civil date 的合格读数、首末读数相隔至少 89 天（窗口所能达到的最大跨度）、最新读数不超过 30 天。
- **直接测量（只适用于未来获批准的协议匹配来源）：** 最近 365 天内有一项合格的 treadmill-CPX-compatible `METABOLIC_CART` 读数，显示其参考年龄；状态写为“直接测量”，而不是误称为“稳定”。
- **数据已过期：** 合格数据曾能计算但超过上述时效；保留最后计算日期作为历史，不将其作为今天结论或训练建议。

3/6/28/90/30/365 是公开的产品质量/时效门槛，用来避免单次可穿戴估计和过期样本，不是论文宣称的身体年龄精度或医疗阈值。中位数对少量异常值更稳健，但并不能消除设备级系统误差。

### 3.3 可重现公式

对于未来获批准的 protocol-matched `METABOLIC_CART` 来源，令 `V` 为最近一项合格测量。对于未来获批准的同一可穿戴来源，令 `D` 为当前 90 天窗口中每个 civil date 最多一项合格读数，`V = median(D)`。不同来源和不同来源政策不得混合。

```text
Rsex(age) = FRIEND P50 参考点之间的分段线性插值
bodyAge = round(argmin(age ∈ [25, 75], |V − Rsex(age)|))
```

`Rsex(age)` 的锚点和单位就是 §2.1 表中提交到 Git 的数据。分段线性插值是本产品公开、确定性的显示转换，不声称论文已经验证了连续“生物年龄方程”。

- `V` 高于 25 岁锚点时显示 `≤25 岁`；低于 75 岁锚点时显示 `≥75 岁`。边界不能伪装成精确年龄。
- 恰好命中锚点时显示该锚点；其它值四舍五入至最接近的整岁。
- `实际年龄差 = bodyAge − chronologicalAge` 仅在出生日期存在且结果不是边界时显示。它只描述参考匹配方向，不代表衰老速度、疾病风险或医疗状态。
- 每次计算都持久化算法/来源政策/参考表版本与 SHA-256、窗口、合格读数计数、排除原因计数、输入 SHA-256 和计算时间。前端不接收 VO₂max 读数。

## 4. 数据流、存储与同步

### 4.1 新存储边界

迁移 `012_body_age_v1.sql` 新增下列最小实体；不复制完整 Google 原始响应、逐分钟心率或 OAuth token。

| 实体 | 只保存 | 不保存 |
| --- | --- | --- |
| `user_body_age_profiles` | `user_id`、`birth_date`、`reference_sex`、单调递增的 `profile_revision`、时间戳 | 性别推断、医疗资料、其它人口学 payload |
| `vo2_max_measurements` | `user_id`、physical timestamp、Google `sampleTime.civilTime.date` 原样提供的 source civil date、source UTC offset、method、`vo2_max`、政策匹配状态、不可逆来源键、接收时间 | 完整 Google DataPoint、活动轨迹、原始心率、可见来源 ID |
| `body_age_results` | 结果/边界、状态、coverage、窗口、算法/政策/参考表 hash、输入 hash、`profile_revision`、计算时间与非原始排除计数 | 每条输入值、raw Google payload、生日或来源键 |

来源键具有确定的层级，使用服务端密钥 HMAC 后才落库：优先 HMAC(`DataPoint.name`)；没有 name 时使用 HMAC(已 canonicalize 的 `dataSource`、measurement method、physical sample time)；若来源元数据也不存在，只在该时间点同步响应唯一时使用 HMAC(`singleton`、method、sample time)。同一 identity 的供应商修订是 upsert，不会被误判成两条来源。若一个无可辨识来源的时间点/日期返回多个不一致候选，系统只存 `ambiguous_unidentified_source` 质量事件、不存可计算测量值；绝不根据数值高低挑选。该次 authoritative refresh 在写入该事件前，必须删除或失效同一 method + physical sample time 已有的 singleton 可计算测量，并使受影响结果的 fingerprint 失配；因此“第一次响应唯一、后来同一时间点变成两个不一致匿名候选”必定回退为不可用，而不会保留旧数字。

`profile_revision` 每次出生日期或参考表变更都递增。每个 result 的 input fingerprint 包含该 revision（而不含生日明文），所以实际年龄差不可能因资料更新仍命中旧结果。

论文表存为 `data/reference/friend-treadmill-vo2max-p50-v1.json`；来源允许名单和论文引用存为 `data/reference/body-age-source-policy-v1.json`。两者都随 Git 管理并在运行时算 SHA-256。参考表、来源政策或公式有任何变化都要产生新版本，不能无版本覆写历史结果。

### 4.2 同步与重放

首次启用读取 `vo2-max` 最近 365 天；以后每小时同步仍刷新最近 48 小时，以接收供应商修订。`health_sync_cursors` 增加 `vo2-max`，失败只使身体年龄不可用/过期，不能阻塞睡眠、Recovery 或 Strain。

现有指标仍默认请求 `users/me/dataSourceFamilies/google-wearables`。仅身体年龄这一个、带 method 的 `vo2-max` 读取可显式请求 `users/me/dataSourceFamilies/all-sources`；为此给 `HealthApiClient.reconcileDataPoints` 增加受限的 `dataSourceFamily` 选项，默认值保持 `google-wearables`，调用端不能为其它类型任意覆盖。这样可发现独立验证过的直接测试来源，同时不改变睡眠、心率、Strain 或其它现有同步的来源范围，也不需要新增 OAuth scope。`all-sources` 返回的记录仍必须通过 §3.1 的空白 allowlist/后续审阅政策；扩大查询范围不是扩大合格范围。

任何已审阅的新来源政策发布后，系统创建显式的 `body_age_policy_replay` 作业，使用新 policy version 对该用户受限重读一次 `vo2-max` 最近 365 天的 `all-sources`；它与常规每小时 48 小时刷新分开执行、可重试且只重算身体年龄。重放使用同一 authoritative upsert/delete、匿名冲突和时区规则，再按新 policy 重新评估，因此“空 allowlist → 新 policy 放行既有 Fitbit/直接测试历史”会得到可复现的新结果，而不是依赖只保存的旧匹配状态。重放不能扩大读取天数、请求任何其它数据类型或改变既有指标来源范围；若失败，显示精确的“来源政策更新待重放”，不继续展示旧 policy 结果。

请求按 physical time 过滤：

```text
vo2_max.sample_time.physical_time >= "RFC3339 instant"
AND vo2_max.sample_time.physical_time < "RFC3339 instant"
```

查询窗口内的本地 `vo2-max` 集合是 authoritative：同一 identity 的值更新，已不在响应中的窗口内值删除；无法识别的多候选只更新质量事件。同步事务完成候选 upsert/delete 后，重算受影响的评价日并持久化 body-age result。

每条测量的 `source_civil_date` 必须直接保存 Google 返回的 `sampleTime.civilTime.date`，而不是后来按服务器或用户当前 IANA 时区重算；历史测量的日期永不因用户旅行或修改时区而移动。计算时的 `as_of_civil_date` 以 `user_health_time_zone_history` 最新可解析 IANA 时区的当前日期为准，90 天窗口为该日期及其之前 89 个 civil date。result/fingerprint 记录该 IANA 时区、时区历史 fingerprint、每条输入的 source civil date，以及计算时的 `as_of_civil_date`。将来时区历史变化会触发用新的评价日/窗口重算，但不改写任一历史 source civil date；缺少或无效的 `civilTime.date`，或当前 IANA 时区无法唯一解析时，结果必须为不可用并说明原因。

读取首页时以保存的算法版本、来源政策 hash、参考表 hash、`profile_revision`、计算时 IANA 时区和时区历史 fingerprint、`as_of_civil_date`、窗口、每条 `source_civil_date` 和排序后的非原始输入 canonical form 重新计算 fingerprint。保存 fingerprint 和现读 fingerprint 不同则显示“数据待更新”，而不是旧年龄。浏览器只收到结果、状态、coverage、版本、最后计算日期和 allowlist 解释；没有生日、VO₂max、method 原始字符串、来源键或 Google DataPoint。

## 5. 首页、资料填写与问号说明

### 5.1 卡片

首页在恢复与全天心肺负荷之后、建议之前加入一张简洁的 `身体年龄` 卡。它不是当天训练建议，也不抢占 `记录一餐` 的唯一实心 CTA。

- 可用：`身体年龄 · 34 岁 ?`，只显示“初步”“稳定”或“直接测量”之一；只有条件满足时才显示“较实际年龄 ±x 岁”。
- 边界：显示 `≤25 岁` 或 `≥75 岁`，不显示虚假精确差值。
- 来源待验证：显示 `—` 和 `已识别到心肺数据，设备来源尚无匹配验证`；不写“偏低”或暗示异常。
- 资料待补充：显示 `补充出生日期与参考表`，链接到账户设置；没有数据时没有占位数字。
- 过期：显示最后一次计算日期和“合格心肺测量尚未更新”，不输出相对常态或训练建议。

### 5.2 `?` 说明层

移动端为可关闭 bottom sheet，桌面为 modal，包含：

1. **定义：** “以可审计 VO₂max 测量匹配 FRIEND 跑台 CPX 人群的年龄/参考性别 P50；是心肺年龄等价值，不是完整生物学年龄或医疗结论。”
2. **本次依据：** 合格读数数/窗口、来源状态、最新合格日期、来源政策与数据过期状态；不列数值。
3. **公式与版本：** §3.3 简式、`body-age-v1`、来源政策和参考表版本。
4. **论文与限制：** FRIEND、AHA、适用的设备验证研究；写明参考人群、设备/实验室差异与 Fitbit Air 当前未通过来源政策的事实。
5. **边界：** 没有诊断、寿命或“训练是否安全”结论；不把 Sleep、HRV、RHR、体脂或饮食做未经验证的隐藏加权。

说明层须保留键盘焦点、`aria-labelledby`/`aria-describedby`、关闭按钮和 reduced-motion 行为；不得泄漏 OAuth scope、token、来源标识或逐条 VO₂max。

## 6. 验收与测试

1. FRIEND JSON schema、单位、12 个 P50 值、DOI 和 SHA-256 都有单测；每个锚点、插值、舍入与两侧边界独立断言。
2. 来源政策测试拒绝 `daily-vo2-max`、`GOOGLE_DEMOGRAPHIC`、未登记 Fitbit Air，以及只有 `METABOLIC_CART` 枚举但没有经政策确认的跑台最大 CPX 协议的记录；只接受 policy 完整匹配的 `METABOLIC_CART` 或将来明确登记的 `FITBIT_RUN`。证据/型号/协议/资料来源不足一律显示来源待验证。
3. 同步映射正确读取 `vo2-max` 的 sample time/method/value/data source；初次 365 天和以后 48 小时 filter 正确。仅 `vo2-max` 请求 `all-sources`，而既有 cardio/睡眠等读取仍请求 `google-wearables`。403、空集合、无效值、匿名多候选、身份相同的修订及重试不影响其它健康指标同步；“唯一匿名候选先被接收、后一次 authoritative refresh 同一时点返回两个不一致候选”会删掉旧 singleton、失配结果且不留下可计算值。
4. 资料缺失、直接测量、可穿戴来源的 2/3/6 个读数、28/89 天覆盖、30/365 天时效、未来日期、时区日界线、来源政策变更和 profile revision 均有确定性测试。来源政策从空 allowlist 升级为放行某一来源时，测试应断言会排队并完成该用户 365 天 `vo2-max` all-sources 重放、用新 policy 产生结果；重放失败只能显示待重放，不能展示旧 policy 数字。测试还应断言历史测量永远使用原始 `sampleTime.civilTime.date`，最新 IANA 时区只决定 `as_of_civil_date`/窗口；`civilTime.date` 缺失、无效或当前时区不唯一时不可用。`null` 不得显示成 0，过期不得标为稳定。
5. fingerprint 在 source/profile/reference-table/policy/current-IANA-timezone/timezone-history/source-civil-date/输入任一变化时失配；API serialization test 断言浏览器没有生日、逐条 VO₂max、raw Google DataPoint、source key 或 method 原始字符串。
6. 390px、768px 和 1440px 截图验证卡片与 `?` 的阅读顺序、触达大小、底部安全区、中文断行及 modal/bottom-sheet 焦点；它不得压过恢复、全天负荷或记录一餐 CTA。
7. 运行 `pnpm test`、`pnpm run lint`、`pnpm run build`，Docker 重建后以真实连接的非敏感计数验证：可查询、资料待补、来源待验证、可用与过期。

## 7. 非目标

- 不以此替代代谢车 CPX、医生评估、疾病风险评估或完整生物学年龄。
- 不将 Google Health 的 `daily-vo2-max`/`cardioFitnessLevel`、WHOOP/Garmin 私有年龄或本地 Sleep/Recovery/Strain 直接作为身体年龄输入。
- 不增加 OAuth scope、不写回 Google Health、不把 VO₂max、生日或原始健康数据发送给 AI Coach。
- 不因新参考表、公式、设备或来源政策改变而无版本地重写旧结果。
