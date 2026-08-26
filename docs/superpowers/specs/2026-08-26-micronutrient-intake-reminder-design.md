# 微量营养素摄入提醒设计

**状态：** 草案
**日期：** 2026-08-26
**依赖：** [拍照记餐、完整营养与 Google Health 写回](2026-08-26-photo-nutrition-google-health-design.md) 的完整本地营养事实与可追溯来源。Google 写回是受支持字段的远端投影，不是本功能的数据源。

## 1. 目标与非目标

用户确认餐食后，产品根据本产品记下的微量营养素，对照《中国居民膳食营养素参考摄入量（2023）》告诉用户：**相对参考摄入量是偏低、已达到，还是数据不够下判断**。用途是帮助决定要不要从食物或补充剂里多补一点，不是诊断缺乏病。

非目标：

- 不做医疗诊断、实验室缺乏确诊、用药建议。
- 不把目录里没写的营养素当成 0。没数据就是「未知」，不能说缺乏。
- 不依赖 Google Health App 或 `nutrition-log` 是否展示微量元素。提醒只读本地 `meal_nutrients`。
- 一期不做推送通知、不做怀孕/哺乳/疾病专项 DRI、不做补剂品牌推荐。
- 一期页面可以后做；先把规则、档案字段和日汇总契约写死。

## 2. 为什么必须是本产品

Google Food 目录和本产品写入的 `nutrition-log` 可以含维生素和矿物质，但：

1. Google 写入是字段受限的投影，且远端展示和后续读回都不应决定本产品的营养判断。
2. 目录条目经常缺项（例如某条「牛肉」没有维生素 B12）。缺项不能当零摄入。

因此「要不要额外补充」只能由本产品用本地事实 + 中国 DRI 来提醒。

## 3. 对照标准

个人目标用《中国居民膳食营养素参考摄入量（2023）》：

| 符号 | 用途 |
| --- | --- |
| RNI | 推荐摄入量。达到则「已达到参考」。 |
| AI | 尚无 RNI 时用适宜摄入量，语义与 RNI 相同，文案写「适宜摄入量」。 |
| UL | 可耐受最高摄入量。超过则「偏高，长期过量有风险」。 |
| EAR | 一期不用。不按群体概率评估缺乏。 |

不用 GB 28050 的 NRV 做个人提醒。NRV 是标签比较基准，不是这个用户的参考摄入量。

DRI 按 **性别 + 年龄段** 取值。未填写档案时，所有「偏低 / 偏高」提醒都不出，只展示已记录的摄入量和「填写年龄与性别后才能对照参考」。

一期档案：

- `users.sex`：`male` / `female`
- `users.birth_date`：出生日期，用于精确落到 DRI 年龄段
- 孕期、哺乳、疾病状态一期不收集，不适用对应专表

年龄按 Asia/Shanghai 窗口结束日计算；生日未到时不进下一年龄。只有用户主动保存的档案字段可以用于 DRI 对照。

### 3.1 版本化 DRI 目标数据

DRI 不是散落在代码里的常量。上线前必须导入一份版本化的本地参考表（或同等受版本控制的数据文件），每一条至少有：`dri_version`、`nutrient_code`、`sex`、年龄段起止、`reference_kind`（RNI / AI / UL）、数值、规范单位和可追溯来源定位。提醒服务只使用显式存在于该表的目标；缺目标的营养素是 `not_eligible`，不得推断或补零。

## 4. 计算窗口与覆盖率

单餐或单日波动很大，不适合作为「缺乏」信号。

| 窗口 | 用途 |
| --- | --- |
| 当日（Asia/Shanghai 民用日） | 展示已记摄入，供核对「今天吃了什么」。不单独因「今天低于 RNI」弹出补充提醒。 |
| 最近 7 个已结束的民用日 | **提醒**用的窗口。只取用户已标记为“当天已完整记录”的日子；每个营养素的合计 ÷ 完整记录日数，得到日均，再和 RNI/AI/UL 比。当天只展示，不参与提醒。 |

提醒有两层覆盖门槛，缺任何一层都不能报「偏低」。

**第一层：当天完整记录。** 用户必须显式标记一天“已完整记录”，表示早餐、午餐、晚餐、加餐均已记录或已明确跳过；系统不得从「有一餐」推断整天完整。修改该日任一餐食后自动撤销完整标记，需重新确认。最近 7 个已结束民用日中，完整记录日少于 3 天，整窗所有可评估营养素均为 `unknown`。

**第二层：营养素可用性覆盖率（每个营养素单独算）。** 只使用完整记录日的确认菜：

1. 取窗口内已确认 `meal_dishes` 的 `portion_grams` 合计为分母。
2. 分子是：该营养素在 `meal_nutrients` 里 **非 null** 的菜的 `portion_grams` 合计。
3. 覆盖率 &lt; 80% → 状态 `unknown`，文案「数据不足，不能判断是否偏低」。
4. 覆盖率 ≥ 80%，且第一层完整记录日门槛已满足，才允许 `below_reference` / `met` / `above_ul`。

**计算顺序是硬门槛，不是展示后处理：** 先检查档案、DRI 目标、完整记录日数和该营养素覆盖率。任一条件不满足时，服务立刻返回 `unknown`（没有 DRI 目标则返回 `not_eligible`），不得计算、持久化或在 API/UI 输出 `below_reference`。也就是说，覆盖率不足或当天记录不完整时页面只可显示「数据不足」，不能以灰色、弱提示或任何其他形式显示「偏低」。

目录没给出的营养素对该菜是 null，不记 0，不进分子。用户明确确认「无该营养素」才写 0（已有餐食规则）。

未标记完整的日子不把摄入当 0，也不进入日均分母；日均分母是完整记录日数。系统不会以一份早餐或一张照片制造“完整一天”的错觉。

## 5. 一期提醒的营养素

只提醒目录里已经能较稳定拿到、且具有版本化 DRI 目标的项。目录长期空白的（如许多条目缺维生素 D、B12）一期只在详情里展示已记录值或「数据不足」，不参与偏低提醒。

| 代码 | 展示 | 提醒 |
| --- | --- | --- |
| ENERGY | kcal | 不作为微量提醒 |
| PROTEIN | g | 可对照 RNI，但是宏量，文案不说「微量」 |
| FAT / CARBOHYDRATES / SATURATED_FAT / SUGAR | g | 展示，不对照 DRI 缺乏 |
| DIETARY_FIBER | g | 对照 AI |
| SODIUM | mg | 主要对照 UL（易超），偏低不提醒补盐 |
| POTASSIUM | mg | 对照 AI |
| CALCIUM | mg | 对照 RNI |
| IRON | mg | 对照 RNI（女性和男性参考不同） |
| VITAMIN_A | µg | 对照 RNI，并检查 UL |
| VITAMIN_C | mg | 对照 RNI |
| CHOLESTEROL | mg | 展示，一期不提醒 |
| 其他 Google 支持或本地扩展项（B 族、D、E、K、锌、硒、胆碱、Omega-3 等） | 有则展示 | 一期 `not_eligible`；待目录覆盖率和 DRI 目标经验证后，以显式白名单另行开放 |

状态机（每个营养素）：

```text
not_eligible     不在一期提醒白名单，或没有可用的版本化 DRI 目标
unknown          档案不全、完整记录日少于 3 天、或覆盖率 < 80%
below_reference  日均 < RNI 或 AI（钠不做此项）
met              RNI/AI ≤ 日均 ≤ UL（无 UL 则只看下限）
above_ul         日均 > UL
```

文案必须用「相对参考摄入量偏低 / 已达到 / 偏高」，禁止「你缺乏维生素 C」「确诊缺铁」。补充建议只允许：「若这种情况持续，可考虑增加含该营养素的食物，或咨询医生/营养师是否使用补充剂。」

## 6. 数据与 HTTP

档案：

```text
users.sex          TEXT NULL CHECK (sex IN ('male', 'female'))
users.birth_date   DATE NULL CHECK (birth_date >= DATE '1900-01-01')
```

服务端还必须拒绝未来出生日期；不用 `CURRENT_DATE` 写入 PostgreSQL `CHECK`，以避免随时间变化的约束语义。

完整记录状态：

```text
nutrition_day_records.user_id
nutrition_day_records.civil_date       DATE (Asia/Shanghai)
nutrition_day_records.status           open | complete
nutrition_day_records.completed_at
```

唯一键为 `(user_id, civil_date)`。用户只可将已结束的民用日标记为 `complete`；任何该日餐食的新增、编辑或删除都将它退回 `open`。日汇总不另建物化表。查询：当前用户、Asia/Shanghai 窗口内 `meal_versions` → `meal_dishes` → `meal_nutrients`，再以 `nutrition_day_records` 筛选完整日。页面做出来时再考虑按日缓存。

提醒输入只包括已确认 `meal_version`。草稿、区间 estimate 不进入。

HTTP（均需登录，前缀 `/rhythm`；页面后做，契约先定）：

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `GET` | `/api/nutrition/reminders` | 最近 7 日提醒：每项状态、日均、参考值、覆盖率、窗口内有记录天数 |
| `GET` | `/api/nutrition/daily?date=YYYY-MM-DD` | 某民用日的摄入合计（含 unknown 项）与完整记录状态 |
| `PATCH` | `/api/nutrition/days/:date` | 将已结束民用日标记为 `complete`；餐食变更后由服务自动退回 `open` |
| `PATCH` | `/api/account/profile` | 写 `sex`、`birth_date` |

`GET /api/nutrition/reminders` 响应不含原图、不含 Google token。每项返回 `status`、完整记录日数和覆盖率；参考值带来源字段：`dri_version = 2023`、年龄段、性别和 `reference_kind`。

## 7. 与写回的关系

- 提醒 **不读写** `nutrition_write_outbox`。
- `local_only` 的餐食一样计入。没开写回开关的用户仍然要提醒。
- 本地保存所有已知营养事实；Google 支持且值已知的维生素、矿物质、纤维、糖、胆固醇和脂肪细分全部写入 `nutrition-log`，仅 Google 不支持的本地扩展代码不写回。

## 8. 关键决定

1. **提醒 = 摄入 vs 中国 DRI 2023，不是缺乏诊断。**
2. **只读本地 `meal_nutrients`。** Google Health App 有没有微量展示不影响本功能。
3. **缺数据是 unknown，不是 0；没有目标是 not_eligible。**
4. **7 个已结束民用日内，至少 3 个完整记录日且营养素覆盖率 ≥80% 才出偏低/偏高；当日只展示。**
5. **未填性别和出生日期不出偏低/偏高。**
6. **钠只提醒超 UL，不提醒偏低。**
7. **一期不做推送、孕哺专表、补剂电商。**

## 9. 验收

1. 目录未提供维生素 C 的菜不把维生素 C 记为 0；覆盖率因此下降。
2. 仅记录一餐、但没有将当天标记为完整记录时，不能使任何营养素进入 `below_reference`；它不是“完整一天”。
3. 完整记录日少于 3 天时，白名单营养素状态为 `unknown`。
4. 覆盖率 &lt; 80% 的营养素状态为 `unknown`，文案不含「偏低」。
   `GET /api/nutrition/reminders` 也不得返回 `below_reference` 或偏低提示对象。
5. 餐食新增、编辑或删除后，当天 `complete` 自动退回 `open`。
6. 无 `sex` 或 `birth_date` → 无 `below_reference` / `above_ul`。
7. 女性与男性铁的 RNI 不同，同样摄入量可以一个 `met`、一个 `below_reference`。
8. 钠日均超过 UL → `above_ul`；低于参考不产生补盐提醒。
9. B12、维生素 D、锌等不在一期白名单时，即使有数值也只能为 `not_eligible`，不得输出偏低。
10. 文案不含「缺乏」「确诊」「治疗」。
11. 关闭营养写回后，提醒结果不变。
12. 跨用户读不到他人餐食汇总。
