# 身体年龄 v1：可追溯的心肺年龄等价值

**状态：** 用户已确认方向，待独立规格审阅与实现计划  
**日期：** 2026-09-02  
**界面名称：** `身体年龄`

## 1. 决策与边界

第一版的 `身体年龄` 不是把睡眠、HRV、静息心率、步数或 Strain 任意加权后的“综合年龄”。它只回答一个更窄、可复核的问题：**用户当前的设备日汇总 VO₂max，与一套公开、按年龄和参考性别分层的心肺适能常模相比，最接近哪一个年龄。**

因此，卡片标题固定显示为“身体年龄”，但 `?` 必须把它的完整定义明确成“心肺年龄等价值（cardiorespiratory age-equivalent）”。它不是完整生物学年龄、疾病风险、寿命预测、诊断或训练许可。条件不满足就显示“尚在积累”，绝不伪造年龄。

这个选择刻意不用 WHOOP Healthspan 或 Garmin Fitness Age 的私有公式。两者可作为同类产品的背景参照，但本产品只实现用户可以检查输入、表和公式版本的公开方法。

## 2. 研究基础与适用限制

### 2.1 为什么选择心肺适能

- 美国心脏协会（AHA）的科学声明将心肺适能（CRF）视为具有独立健康关联的重要指标，并主张在临床实践中常规评估；这说明 VO₂max/VO₂peak 是有充分研究基础的单一体能维度，但**不**意味着本产品可以据此作医疗判断。[Ross et al., 2016](https://pubmed.ncbi.nlm.nih.gov/27881567/)
- FRIEND Registry 的同行评审研究以 8 个美国实验室、7,783 名无已知心血管病的 20–79 岁受试者的最大跑台 CPX 测试，给出按年龄十年段及性别分层的直接测得 VO₂max 常模和百分位。[Kaminsky et al., 2015](https://pubmed.ncbi.nlm.nih.gov/26455884/)
- 本项目采用该研究的 P50（中位数）参考点。下表的完整 P50 向量可由公开的转载表逐格核查；其来源仍是 FRIEND 跑台 CPX 数据，而非其它运动方式或厂商算法。[PLOS ONE 转载表](https://journals.plos.org/plosone/article/file?id=10.1371/journal.pone.0209897&type=printable)

| 参考年龄锚点（岁） | 25 | 35 | 45 | 55 | 65 | 75 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 男性参考表 P50 VO₂max（mL·kg⁻¹·min⁻¹） | 48.0 | 42.4 | 37.8 | 32.6 | 28.2 | 24.4 |
| 女性参考表 P50 VO₂max（mL·kg⁻¹·min⁻¹） | 37.6 | 30.2 | 26.7 | 23.4 | 20.0 | 18.3 |

**限制必须随算法呈现：** FRIEND 的常模来自美国、无已知心血管病、跑台 CPX 的人群；它不等同于中国一般人群、也不等同于自行车测试或手表估算。设备产生的 VO₂max 不是实验室代谢车测量。因此，v1 是一个透明的“参考年龄等价值”，不是经外部临床验证的生物学年龄模型。任何未来的多变量身体年龄，只有在找到可复现、适用人群清楚、且输入定义匹配的公开验证模型后才能加入；不能把现有指标临时配权。

## 3. 计算定义（`body-age-v1`）

### 3.1 必需资料

1. 用户主动填写的出生日期，用于显示与实际年龄的差值；**它不参与 VO₂max 到参考年龄的反推。**
2. 用户主动选择“男性参考表”或“女性参考表”。这是为了选择论文仅提供的二元参考队列，不从姓名、照片、设备或任何其它资料推断。用户不愿选择时，结果不可用。
3. Google Health 的 `daily-vo2-max` 日记录。该类型由现有第 3 个 OAuth 权限 `activity_and_fitness.readonly` 覆盖，无需新增授权；API 的 `estimated` 字段表示其置信度已下降到应视为估计的程度。[Google Health scopes](https://developers.google.com/health/filters)；[DailyVO2Max 字段定义](https://developers.google.com/health/reference/rest/v4/users.dataTypes.dataPoints)

输入条件故意比“只要返回一个数字”更严：只接受 `vo2Max` 为有限、正数，且 `estimated === false` 的日记录。`estimated === true`、字段缺失、日期冲突或无效值都会持久化为质量信息，但不会进入计算。`cardioFitnessLevel` 是供应商分箱，不参与公式；`vo2MaxCovariance` 若有则保存供质量审计，但 v1 不给它臆造阈值或权重。

`daily-vo2-max` 不携带单次测量方法，因此 v1 将结果始终描述为“设备日汇总输入”。若以后接入 `vo2-max` 单次记录，只有已知且非 `GOOGLE_DEMOGRAPHIC` 的来源才可作为一个**另行验证**的算法版本输入；不得把由人口学资料生成的数值反过来计算“身体年龄”。Google 的 API 明确区分 Fitbit 跑步、代谢车、Cooper 测试、心率比和人口学等测量方法。[Google Health VO₂max 方法枚举](https://developers.google.com/health/reference/rest/v4/users.dataTypes.dataPoints)

### 3.2 稳定性与结果状态

所有窗口以用户 Health 时区的 civil date 计算，评价日为 `as_of_civil_date`，窗口为其当日及之前 89 天，共 90 个 civil day；未来日期绝不参与。

- **尚在积累：** 90 天窗口中不足 28 个不同日期的合格记录，或资料不完整。显示缺失的精确原因和 `n / 28 天`，不显示年龄。
- **初步：** 有至少 28 个合格日期、且最新合格记录距 `as_of_civil_date` 不超过 14 天。显示年龄与“初步”标签。
- **稳定：** 有至少 63 个合格日期，窗口首日也有合格记录，且最新合格记录距 `as_of_civil_date` 不超过 14 天。显示年龄与“稳定”标签。
- **数据已过期：** 曾经可计算但最近合格记录超过 14 天。保留上次结果的历史时间，不将它作为今天的结论或建议。

28/63/90 是为减少偶发日估计和缺失数据对**中位数**的影响而设的产品质量门槛：28 是初步展示下限；63 是 90 天窗口内至少 70% 的可用日期。它们不是临床阈值、也不是论文宣称的生物学年龄精度。WHOOP 对其私有 Healthspan 也采用先积累、约 90 天完整校准的产品策略，但本产品不把该策略当作对本算法的医学验证。[WHOOP Healthspan guide](https://support.whoop.com/s/article/Healthspan-WHOOP-Age-Pace-of-Aging-Guide?language=en_US)

### 3.3 可重现公式

记 `D` 为 90 天窗口内每个合格 civil date 的一个设备日汇总 VO₂max，且每个日期最多一条。若同一日的合格数据源产生不同数值，该日记为 `source_conflict` 并从 `D` 排除；不选择较高或较低的那个数。

```text
V = median(D)
Rsex(age) = FRIEND P50 参考点之间的分段线性插值
bodyAge = round(argmin(age ∈ [25, 75], |V − Rsex(age)|))
```

这里的中位数只用于降低重复日估计中的偶发偏移；它没有给睡眠、心率或训练量分配任何隐藏权重。`Rsex(age)` 的锚点和单位就是 §2.1 表中提交到 Git 的数据。分段线性插值是本产品公开、确定性的显示转换，而非声称论文已经验证了一条连续的“生物年龄方程”。

- `V` 高于 25 岁锚点时显示 `≤25 岁`；低于 75 岁锚点时显示 `≥75 岁`。不能把边界强行伪装成精确的 25 或 75。
- 恰好命中锚点时显示该锚点；其它值四舍五入至最接近的整岁。
- `实际年龄差 = bodyAge − chronologicalAge` 只在出生日期存在且结果不是边界时显示。正值只描述这个参考匹配的方向，不表示衰老速度、疾病风险或医疗状态。
- 每次计算都持久化 `algorithm_version = body-age-v1`、参考表 SHA-256、窗口边界、合格日期数、排除原因计数、输入 SHA-256 和计算时间。前端不接收逐日 VO₂max 值。

## 4. 数据流、存储与同步

### 4.1 新存储边界

迁移 `012_body_age_v1.sql` 新增以下最小实体；不把完整 Google 原始响应、逐分钟心率或 OAuth token 复制到其中。

| 实体 | 只保存 | 不保存 |
| --- | --- | --- |
| `user_body_age_profiles` | `user_id`、`birth_date`、`reference_sex`、时间戳 | 性别推断、医疗资料、其它人口学 payload |
| `daily_vo2_max` | `user_id`、civil date、不可逆的来源键、`vo2_max`、`estimated`、可选 covariance、接收时间 | 完整 Google DataPoint、活动轨迹、原始心率 |
| `body_age_results` | 结果/边界、状态、coverage、窗口、版本、参考表 hash、输入 hash、计算时间和非原始排除计数 | 每天的输入值、原始证据、Google payload |

`daily_vo2_max` 的主键是 `(user_id, civil_date, source_key)`，以便检测同日多源冲突；`body_age_results` 以 `(user_id, as_of_civil_date, algorithm_version)` 标识。日汇总只保留运行 90 天窗口与审计所需的 120 个 civil day，超过后按用户范围删除。删除账户时沿用外键级联删除。

论文表存为受版本控制的数据文件 `data/reference/friend-treadmill-vo2max-p50-v1.json`，其中包括 DOI、访问日期、单位、参考人群描述、锚点和 12 个 P50 值。程序只读取这个文件并计算其 SHA-256；数据或公式变更必须新建算法版本，不得静默重算或覆写历史结果。

### 4.2 同步

首次启用时读取 `daily-vo2-max` 的最近 90 个 civil day；以后沿用每小时同步，刷新最近 48 小时以接收供应商修订。该数据类型和 cursor 要独立处理：失败只会使身体年龄变为缺失/过期，不会阻塞睡眠、Recovery 或 Strain 同步。`health_sync_cursors` 增加 `daily-vo2-max`，但不需要 OAuth scope 变更。

Google Health 的请求使用日类型匹配的 civil-date filter：

```text
daily_vo2_max.date >= "YYYY-MM-DD"
AND daily_vo2_max.date < "YYYY-MM-DD"
```

在一个同步事务内，先 upsert 日汇总、再重算受影响的 `as_of_civil_date`（当前日和未来 89 天中仍有存储窗口的日期），最后持久化 body-age result。每个 result 的 input fingerprint 包含：算法版本、参考表 hash、参考表选择、出生日期的已选状态（但不含生日明文）、窗口起止日期，以及排序后的每个输入日期/值/estimated/source-key 的 canonical form。读取首页时仅在保存 fingerprint 与当前重放的 fingerprint 一致时显示结果；不同就显示“数据待更新”，而不是显示旧分数。

## 5. 首页、资料填写与问号说明

### 5.1 卡片

首页在恢复与全天心肺负荷之后、建议之前加入一张简洁的 `身体年龄` 卡。它不是当天的训练建议，也不抢占 `记录一餐` 的唯一实心主 CTA。

- 可用：`身体年龄  ·  34 岁  ?`，加“初步”或“稳定”质量标记；只有条件满足时才显示“较实际年龄 ±x 岁”。
- 边界：显示 `≤25 岁` 或 `≥75 岁`，不显示虚假的精确差值。
- 积累中：显示 `—`、`已收集 12 / 28 天心肺数据` 和“查看依据”；不要写成“偏低”或暗示健康异常。
- 资料缺失：显示 `补充出生日期与参考表`，链接到账户设置。没有数据时不出现占位数字。
- 过期：显示最后一次计算日期和“设备日汇总尚未更新”，不输出相对常态或训练建议。

### 5.2 `?` 说明层

移动端为可关闭的 bottom sheet，桌面为 modal。它包含：

1. **定义：** “以近 90 天设备日汇总 VO₂max 的中位数，匹配 FRIEND 跑台 CPX 人群的年龄/参考性别 P50。它是心肺年龄等价值，不是完整生物学年龄或医疗结论。”
2. **本次输入：** `n / 90 个合格日`、结果状态、最新输入日期、设备日汇总/估计限制及数据过期状态；不列出逐日数值。
3. **公式与版本：** §3.3 的简式、`body-age-v1` 和参考表版本。
4. **依据：** FRIEND 和 AHA 的可点击论文/声明链接；写明参考人群和设备/实验室差异。
5. **边界：** 没有临床诊断、寿命或“训练是否安全”的结论；不使用睡眠、HRV、RHR、体脂或饮食作未经验证的隐藏加权。

说明层必须保留键盘焦点、`aria-labelledby`/`aria-describedby`、关闭按钮和 reduced-motion 行为；显示数据来源与算法版本时不得泄漏 OAuth scope、token、来源标识或逐日 VO₂max。

## 6. 验收与测试

1. Friend 数据文件 JSON schema、单位、12 个 P50 值、DOI 和 SHA-256 都有单测；每个锚点输入必须得到对应锚点年龄，分段插值、整数舍入与两侧边界都独立测试。
2. 同步映射准确读取 `daily-vo2-max` 的 date/value/estimated/covariance，初次 90 天和以后 48 小时 filter 正确；403、空集合、`estimated=true`、无效值、同日冲突和重试不会影响其它指标同步。
3. 资料缺失、27/28/62/63 个合格日、90 天首日缺失、14 天内/外的最新样本、未来日期、时区日界线和供应商修订均有确定性单测。没有任何 case 把 `null` 显示为 0 或把过期数据标为稳定。
4. 每个 body-age result 的 fingerprint 在 source/profile/reference-table 任一变化时失配；首页只收到结果、状态、覆盖计数、版本和非原始解释，API serialization test 断言没有逐日 VO₂max、raw Google DataPoint、source key 或生日。
5. 390px、768px 和 1440px 截图验证卡片和 `?` 的阅读顺序、触达大小、底部安全区、中文断行及 modal/bottom-sheet 焦点；它不能压过恢复、全天负荷或记录一餐 CTA。
6. 运行 `pnpm test`、`pnpm run lint`、`pnpm run build`，并在 Docker 重建后以真实连接的非敏感计数验证：可查询、无数据、积累中、可用、过期五种状态。

## 7. 非目标

- 不以此替代代谢车 CPX、医生评估、疾病风险评估或完整生物学年龄。
- 不将 Google Health 的 `cardioFitnessLevel`、WHOOP/Garmin 私有年龄或本地 Sleep/Recovery/Strain 直接作为身体年龄输入。
- 不增加新 OAuth scope、不写回 Google Health、不发送任何 VO₂max、生日或原始健康数据给 AI Coach。
- 不因新参考表、公式或设备来源改变而无版本地重写旧结果。
