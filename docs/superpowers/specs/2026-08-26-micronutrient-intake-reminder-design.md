# 微量营养素摄入提醒设计

**状态：** 草案
**日期：** 2026-08-26
**依赖：** [拍照记餐、完整营养与 Google Health 写回](2026-08-26-photo-nutrition-google-health-design.md) 的 `meal_nutrients` 本地事实。Google Health App 不展示微量元素，写回也不是本功能的数据源。

## 1. 目标与非目标

用户确认餐食后，产品根据本产品记下的微量营养素，对照《中国居民膳食营养素参考摄入量（2023）》告诉用户：**相对参考摄入量是偏低、已达到，还是数据不够下判断**。用途是帮助决定要不要从食物或补充剂里多补一点，不是诊断缺乏病。

非目标：

- 不做医疗诊断、实验室缺乏确诊、用药建议。
- 不把目录里没写的营养素当成 0。没数据就是「未知」，不能说缺乏。
- 不依赖 Google Health App 或 `nutrition-log` 是否展示微量元素。提醒只读本地 `meal_nutrients`。
- 一期不做推送通知、不做怀孕/哺乳/疾病专项 DRI、不做补剂品牌推荐。
- 一期页面可以后做；先把规则、档案字段和日汇总契约写死。

## 2. 为什么必须是本产品

Google Food 目录的 `nutrients[]` 含维生素和矿物质，但：

1. 匿名 `nutrition-log` 写回后，Google Health App 当前不展示这些微量元素。
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
- `users.birth_year`：四位年份，用于落到 DRI 年龄段
- 孕期、哺乳、疾病状态一期不收集，不适用对应专表

年龄按 Asia/Shanghai 当天的公历年减 `birth_year` 估算（不知道生日时偏一年可接受）。

## 4. 计算窗口与覆盖率

单餐或单日波动很大，不适合作为「缺乏」信号。

| 窗口 | 用途 |
| --- | --- |
| 当日（Asia/Shanghai 民用日） | 展示已记摄入，供核对「今天吃了什么」。不单独因「今天低于 RNI」弹出补充提醒。 |
| 最近 7 个民用日 | **提醒**用的窗口。对每个营养素：7 日合计 ÷ 有记录的天数，得到日均，再和 RNI/AI/UL 比。 |

覆盖率（每个营养素单独算）：

1. 取窗口内已确认 `meal_dishes` 的 `portion_grams` 合计为分母。
2. 分子是：该营养素在 `meal_nutrients` 里 **非 null** 的菜的 `portion_grams` 合计。
3. 覆盖率 &lt; 50% → 状态 `unknown`，文案「数据不足，不能判断是否偏低」。
4. 覆盖率 ≥ 50% 才允许 `below_reference` / `met` / `above_ul`。

目录没给出的营养素对该菜是 null，不记 0，不进分子。用户明确确认「无该营养素」才写 0（已有餐食规则）。

未记餐的日子不把摄入当 0 去拉低日均；日均分母是「至少有一餐确认记录的天数」。若 7 天里确认餐食的天数 &lt; 3，整窗提醒为 `unknown`：「记录天数不够」。

## 5. 一期提醒的营养素

只提醒目录里已经能较稳定拿到、且用户关心「要不要补」的项。目录长期空白的（如许多条目缺维生素 D、B12）一期只在详情里展示「未测到」，不参与偏低提醒。

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
| 其他目录偶发项（B 族、D、E、K、锌、硒等） | 有则展示 | 覆盖率达标才允许偏低提醒；否则 `unknown` |

状态机（每个营养素）：

```text
unknown          档案不全、记录天数不够、或覆盖率 < 50%
below_reference  日均 < RNI 或 AI（钠不做此项）
met              RNI/AI ≤ 日均 ≤ UL（无 UL 则只看下限）
above_ul         日均 > UL
```

文案必须用「相对参考摄入量偏低 / 已达到 / 偏高」，禁止「你缺乏维生素 C」「确诊缺铁」。补充建议只允许：「若这种情况持续，可考虑增加含该营养素的食物，或咨询医生/营养师是否使用补充剂。」

## 6. 数据与 HTTP

档案：

```text
users.sex          TEXT NULL CHECK (male|female)
users.birth_year   INTEGER NULL CHECK (1900–当前年)
```

日汇总不另建物化表。查询：当前用户、Asia/Shanghai 窗口内 `meal_versions` → `meal_dishes` → `meal_nutrients`。页面做出来时再考虑按日缓存。

提醒输入只包括已确认 `meal_version`。草稿、区间 estimate 不进入。

HTTP（均需登录，前缀 `/rhythm`；页面后做，契约先定）：

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `GET` | `/api/nutrition/reminders` | 最近 7 日提醒：每项状态、日均、参考值、覆盖率、窗口内有记录天数 |
| `GET` | `/api/nutrition/daily?date=YYYY-MM-DD` | 某民用日的摄入合计（含 unknown 项） |
| `PATCH` | `/api/account/profile` | 写 `sex`、`birth_year` |

`GET /api/nutrition/reminders` 响应不含原图、不含 Google token。参考值带来源字段：`dri_version = 2023`、年龄段、性别。

## 7. 与写回的关系

- 提醒 **不读写** `nutrition_write_outbox`。
- `local_only` 的餐食一样计入。没开写回开关的用户仍然要提醒。
- 写回 Google 的 payload 仍只含能量、碳水、脂肪、蛋白质等现有规则允许的字段；微量继续只存在本产品。

## 8. 关键决定

1. **提醒 = 摄入 vs 中国 DRI 2023，不是缺乏诊断。**
2. **只读本地 `meal_nutrients`。** Google Health App 有没有微量展示不影响本功能。
3. **缺数据是 unknown，不是 0。**
4. **7 日日均才出偏低/偏高提醒；当日只展示。**
5. **未填性别和出生年不出偏低/偏高。**
6. **钠只提醒超 UL，不提醒偏低。**
7. **一期不做推送、孕哺专表、补剂电商。**

## 9. 验收

1. 目录未提供维生素 C 的菜不把维生素 C 记为 0；覆盖率因此下降。
2. 覆盖率 &lt; 50% 的营养素状态为 `unknown`，文案不含「偏低」。
3. 7 天内确认餐食少于 3 天 → 全部提醒 `unknown`。
4. 无 `sex` 或 `birth_year` → 无 `below_reference` / `above_ul`。
5. 女性与男性铁的 RNI 不同，同样摄入量可以一个 `met`、一个 `below_reference`。
6. 钠日均超过 UL → `above_ul`；低于参考不产生补盐提醒。
7. 文案不含「缺乏」「确诊」「治疗」。
8. 关闭营养写回后，提醒结果不变。
9. 跨用户读不到他人餐食汇总。
