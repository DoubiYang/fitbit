# 身体年龄 v1：Fitbit Air 心肺估算（中国成人参照）

**状态：** 用户已确认 Fitbit Air 是唯一输入；待实施计划与实现
**日期：** 2026-09-02  
**界面名称：** `身体年龄`
**指标版本：** `body-age-air-cn-v1`

## 1. 产品决定与不做的事

用户只有 Fitbit Air，明确选择直接用其上传到 Google Health 的数据估算 `身体年龄`，不把设备型号级验证作为出分前置条件。第一版因此是一个**可解释的 Air 心肺年龄估算**：将该已连接账户的 Air 日心肺值，或从已同步 Air 心率推得的体重归一化心肺适能 proxy，与中国成人 CPET 参考人群的年龄/参考性别 P50 相匹配。

它不把睡眠、HRV、静息心率、步数、全天负荷或饮食任意加权成“综合年龄”。睡眠/HRV 不会悄悄改变年龄；静息心率只在 Air 没有上传每日 VO₂max 时，作为已公开的心率比 VO₂max 方程所需输入。

卡片名保持“身体年龄”，但 `?` 必须首句说明：**“这是依据 Fitbit Air 数据与中国成人心肺适能常模得到的估算心肺年龄，不是完整生物学年龄、医疗检测、疾病风险、寿命预测或运动处方。”** 这不是阻止出分的验证门槛，而是对用户准确说明数字的含义。

## 2. 研究基础与采用的中国参考表

中国成人 CPET 常模不能用“黄种人”这种宽泛类别代替。产品按**具体中国成人参考队列、测试方式、年龄段与参考性别**选择表，不从姓名、照片、设备或任何资料推断族群。

v1 的可复现参考表采用 Wang 等人的公开中国社区成年人研究：北京和广西四个城乡社区共 1,114 名无运动心电图异常的成人，以功率车 CPET 测得 `VO₂peak`，覆盖 20–79 岁并公开了按年龄十年段和性别的 P50。该研究明确指出其中国成人参考值与西方表不同。[Wang et al., 2022](https://pmc.ncbi.nlm.nih.gov/articles/PMC9409785/)

| 参考年龄锚点（岁） | 25 | 35 | 45 | 55 | 65 | 75 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 男性 P50 VO₂peak（mL·kg⁻¹·min⁻¹） | 35.7 | 27.7 | 26.7 | 24.4 | 22.4 | 19.7 |
| 女性 P50 VO₂peak（mL·kg⁻¹·min⁻¹） | 27.7 | 26.0 | 24.7 | 22.0 | 21.2 | 17.0 |

这张表不是民族本质差异的结论，也不是全国代表性生物学年龄模型；它是当前可公开逐格复核、覆盖中国社区成人 20–79 岁的参照。另有 2024 年 4,199 名健康中国成年人跑台 CPX 研究，20–59 岁并有独立验证集，证实中国跑台参考优于直接套用 FRIEND；其完整 P50 表不公开可复核，因此 v1 不擅自用摘要均值替代 P50。后续若以合规方式取得完整表，会以新参考表版本增加“跑台中国成人”路线，不能静默更换当前结果。[Huang et al., 2024](https://pubmed.ncbi.nlm.nih.gov/38488145/)

Air 的日心肺值与功率车 CPET 的 `VO₂peak` 并不等价；本产品只把两者做透明的参考映射，不声称有 Air→该表的校准。消费级可穿戴设备的 exercise-based VO₂max 在群体层面平均偏差较小、但个人误差仍可很大；这正是本页持续显示“估算”的理由。[INTERLIVE 系统综述](https://pubmed.ncbi.nlm.nih.gov/35072942/)

## 3. 输入、优先级与质量状态

### 3.1 用户资料

1. 用户主动填写出生日期，仅用于显示“较实际年龄 ±x 岁”；它不参与 VO₂max 到参考年龄的反推。
2. 用户主动选择“男性参考表”或“女性参考表”，只用于选择论文已有的二元参考队列；没有选择时不出结果。

### 3.2 Air 输入优先级

1. **优先：Air 每日心肺值。** 读取 Google Health `daily-vo2-max`（现有 `activity_and_fitness.readonly` 权限），限 `users/me/dataSourceFamilies/google-wearables`。此 family 不是设备型号断言；本版按用户“该账户只有 Air 一个设备”的产品决定使用其已连接账户数据，不额外抓取或保存设备身份。使用每个 civil date 的有限正数 `vo2Max`；`estimated` 为 `true` 或缺失均可用，并在结果中标注为 Air 估算。`cardioFitnessLevel` 和 covariance 不参与公式。
2. **回退：Air 观察峰值心率比 proxy。** 当当前 28 天没有至少 7 个每日心肺值，使用已同步 Air 逐分钟心率中的历史有效观察峰值 `HRpeak_observed` 与最近 7 个有效 `daily-resting-heart-rate` 的中位数：

   ```text
   estimatedVO2_proxy = 15.3 × (HRpeak_observed / median(dailyRhr[latest 7]))
   ```

   Uth 等人发表的 Heart Rate Ratio Method 使用的是实测 `HRmax`；日常 Air 数据的最高分钟值不等于生理最大心率。因此本版只是**受该方程启发的观察峰值 proxy**，不是 Uth 方程的原始、经验证使用方式；它永远标为“观察峰值心率比估算”，不会取得“稳定”质量状态。[Uth et al., 2004](https://pubmed.ncbi.nlm.nih.gov/14624296/)

`HRpeak_observed` 不允许人工填写：取账户自首次同步以来所有已保存 Air 心率分钟中满足 `sample_count > 0`、`coverage_seconds ≥ 30`、`100 ≤ max_bpm ≤ 230` 的最大 `max_bpm`，并随新同步单调更新；这符合用户“直接在历史数据取最大值”的决定。首次接入回看约 37 天，之后累积新增同步，不能称为设备生涯最大心率。`dailyRhr` 仅接受 `30–120 bpm` 的有限值。没有 7 个有效 RHR 日期，心率比路线显示具体缺失原因，不以全天最低心率或年龄公式偷填。

不同路线绝不混合：有足够每日心肺值就只取 Air 每日心肺值；否则完全使用一次心率比估算。Google `vo2-max`（含 `GOOGLE_DEMOGRAPHIC`）以及除 `google-wearables` 的 `daily-vo2-max` 外的任何来源、WHOOP/Garmin 私有年龄，均不进入 v1。

### 3.3 质量状态

所有日期以 Google Health 返回的 civil date 保存，未来日期不参与。

- **资料待补充：** 缺出生日期或参考表选择。
- **数据待积累：** 每日心肺值不足 7 个日期且 RHR 不足 7 个日期；显示各自缺口，不显示年龄。
- **初步 · Air 每日心肺估算：** 当前 28 天至少 7 个不同日期的有效 `daily-vo2-max`，且最新值不超过 7 天；以这些日期的中位数计算。
- **稳定 · Air 每日心肺估算：** 当前 28 天至少 21 个不同日期的有效 `daily-vo2-max`，且最新值不超过 7 天；以这些日期的中位数计算。
- **初步 · Air 观察峰值心率比估算：** 每日心肺值不足 7 个日期，但已取得 7 个有效 RHR 日期与历史有效观察峰值；仅计算一次 proxy 结果，不使用“稳定”。
- **数据已过期：** 上述路线曾能计算、但最新所需 Air 输入已超过 7 天；保留最后计算日期，不把旧值作为今天训练建议。

7/21/28/7 是公开的产品稳定性与时效门槛，目的是减小单日波动和陈旧值影响，并不是论文承诺的“身体年龄精度”或医疗阈值。

## 4. 可重现算法

对选中的 Air 路线取得 `V`：每日心肺路线为当前 28 天内每个日期至多一个值的中位数；观察峰值心率比路线为 §3.2 的单一 `estimatedVO2_proxy`。二者都只是与参考表的映射值，不声称等同于 CPET 的 `VO₂peak`。

```text
R(referenceSex, age) = 中国成人功率车 CPET P50 锚点之间的分段线性插值
bodyAge = round(argmin(age ∈ [25, 75], |V − R(referenceSex, age)|))
```

- `V` 高于 25 岁锚点显示 `≤25 岁`，低于 75 岁锚点显示 `≥75 岁`；边界不伪装成精确年龄。
- 命中锚点显示锚点年龄，其余值四舍五入至最接近整岁。
- 仅在出生日期存在且结果不是边界时显示 `bodyAge − chronologicalAge`。
- 所有输出持续冠以 `估算`；不得用于诊断、风险判断、寿命结论或“是否可以训练”。

## 5. 数据流、存储、同步与隐私

迁移 `012_body_age_air_cn_v1.sql` 新增：

| 实体 | 只保存 | 不保存 |
| --- | --- | --- |
| `user_body_age_profiles` | `user_id`、`birth_date`、`reference_sex`、`historical_hr_peak_bpm`、首次/最近观察峰值时间、单调 `profile_revision` | 性别推断、设备身份推断、医疗资料、原始分钟心率 |
| `air_daily_vo2` | `user_id`、source civil date、`vo2_max`、`estimated`、接收时间 | 完整 Google DataPoint、来源 ID、活动轨迹 |
| `body_age_results` | 结果/边界、状态、route、coverage、窗口、算法/参考表版本与 hash、输入 hash、`profile_revision`、计算时间与非原始排除计数 | 每条 VO₂、每日 RHR、生日、HRmax、raw Google payload |

首次启用读取 `daily-vo2-max` 最近 28 个 Google civil day；以后每小时同步刷新最近 48 小时的 Google civil date。来源日期按 Google 返回值原样保存，用户时区变化、旅行和 DST 不重写历史日；时区只用于判断“今天”与数据是否陈旧。落在 48 小时 authoritative 刷新窗的缺失记录会删除；窗外迟到修订只会在有意触发的后续全量回填时生效，v1 不承诺自动捕捉它。原有心率与每日 RHR 同步继续提供观察峰值心率比回退所需数据，且新输入失败不会阻塞睡眠、Recovery 或 Strain。`health_sync_cursors` 增加 `daily-vo2-max`。

每轮心率同步按 §3.2 条件更新 `historical_hr_peak_bpm = GREATEST(已保存值, 本轮有效 max_bpm)`；同一账户资料删除或 Air 连接撤销时按用户数据删除流程级联清除。每日 VO₂ 窗口是 authoritative：同日期供应商修订 upsert、落在刷新窗口却不再返回的值删除，然后重算今天的结果。

参考表存为 Git 管理的 `data/reference/chinese-community-cycle-vo2peak-p50-v1.json`，包含 DOI、访问日期、测试方式、样本限制、P50 值和 SHA-256。算法、表、路线、窗口、排序后的非原始输入、profile revision 和时区历史都进入 input fingerprint。变化后不展示旧结果，而显示“数据待更新”。浏览器只收到年龄/边界、状态、route 标签、coverage、版本和说明；不接收生日、VO₂、RHR、HRmax、来源键或 Google 原始数据。

## 6. 首页与 `?` 说明

首页在恢复与全天心肺负荷之后、建议之前展示卡片：

- 可用：`身体年龄 · 34 岁 · 估算 ?`，副标题为 `Air 每日心肺` 或 `Air 观察峰值心率比`，并显示初步/稳定；只有非边界且出生日期已填时显示较实际年龄差。
- 待积累：显示 `—` 和精确缺口，例如 `还差 3 天 Air 心肺数据` 或 `还差 2 天静息心率`；不写“偏低”。
- 过期：显示最后计算日期和 `Air 心肺数据尚未更新`。

移动端 `?` 为可关闭 bottom sheet、桌面为 modal，内容固定包括：

1. 定义：Air 数据相对中国成人功率车 CPET P50 的估算心肺年龄。
2. 本次输入路线、有效日期数/窗口、最新输入日期与状态；不列原始数值。
3. §4 的公式、`body-age-air-cn-v1` 和参考表版本。
4. Wang 2022、Uth 2004（若走观察峰值 proxy）和 INTERLIVE 的可点击研究链接及限制；明确日常观察峰值不是最大运动测试的 HRmax。
5. “不是医疗检测或生物学年龄”的边界。

说明层要保留键盘焦点、`aria-labelledby` / `aria-describedby`、关闭按钮和 reduced-motion；不得泄漏 OAuth scope、token 或原始健康数据。

## 7. 验收与测试

1. 中国 P50 JSON schema、12 个值、DOI、测试方式与 SHA-256 有单测；每个锚点、插值、舍入与边界独立断言。
2. 每日 Air 路线对 6/7/21 个不同日期、同日修订、`estimated=true`、无效/未来/过期值有测试；P50 输入值不能因 `estimated` 被错误排除。
3. 观察峰值心率比路线测试 Uth 启发式 proxy、历史有效观察峰值的单调更新、首次接入约 37 天窗口、7 个 RHR 的中位数、无效 HR/RHR、RHR 日期不足和“每日 Air 心肺优先、不混合路线”。
4. `daily-vo2-max` 过滤、Google civil date 原样保存、28 天首次读取、48 小时刷新、cursor、403/空集合/重试、旅行/DST/供应商迟到修订均有同步测试；它继续只请求 `google-wearables`，不改变既有指标来源范围。
5. profile/reference-table/route/timezone/输入任一变化时 fingerprint 失配；API serialization 测试断言浏览器没有生日、逐条 VO₂、RHR、HRmax 或 raw Google DataPoint。
6. 390px、768px、1440px 截图验证卡片、状态、中文断行与 `?` 焦点；它不得压过恢复、全天负荷或记录一餐 CTA。
7. 运行 `pnpm test`、`pnpm run lint`、`pnpm run build`；Docker 重建后，以真实连接的非敏感状态验证待积累、每日心肺初步/稳定、心率比初步与过期。

## 8. 非目标

- 不声称 Fitbit Air 或本算法获得临床/设备型号级验证，也不把 `google-wearables` family 伪装为可验证的 Air 型号身份。
- 不将结果称为完整生物学年龄，不增加血液、基因、体成分或人工智能黑箱加权。
- 不增加 OAuth scope、不写回 Google Health、不把生日、心率、VO₂ 或原始健康数据发送给 AI Coach。
- 不把美国 FRIEND、闭源的中国跑台摘要均值或功率车以外的参考表混入当前版本。
