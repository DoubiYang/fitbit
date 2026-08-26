# 拍照记餐、完整营养与 Google Health 写回设计

**状态：** 已完成技术审查，待用户确认后实施
**日期：** 2026-08-26
**取代范围：** 本文细化 `2026-08-23-03-deepseek-vision-validation-design.md` 中营养计算、完整字段与 Google Health 写回部分；该旧文的视觉模型评测门槛仍然有效。

## 1. 目标与非目标

用户拍摄或上传一餐食物照片后，产品给出可编辑的食物、食材与份量候选；由版本化食物成分数据计算完整营养素。用户确认后，Google Health API 能表示的营养素写入该用户的 `nutrition-log`；其余营养事实、估算依据与置信度只保存在本产品。

一期目标是可靠的餐食记录与可解释的营养估算，而不是医疗诊断、维生素缺乏判断或无确认的自动写入。模型不持有 Google 凭证、不会调用写接口，也不能绕过用户确认。

## 2. 已核实的 Google Health API 契约

- `https://www.googleapis.com/auth/googlehealth.nutrition.writeonly` 可创建、编辑或删除本应用写入的营养数据；项目既有十项 OAuth 授权已包含该 scope。
- `nutrition-log` 支持 `create`、`get`、`list`、`reconcile`、`rollup`、`dailyRollup`、`update` 和 `batchDelete`；写入入口是 `POST /v4/users/me/dataTypes/nutrition-log/dataPoints`。
- 食物数据库为只读。若能找到 Google Food resource，使用 identified food；中餐菜品通常无法可靠匹配，默认创建 anonymous food：`foodDisplayName` 加上本产品计算的营养字段。
- anonymous food 不能更新。用户编辑时必须删除旧 Google data point 后创建新 data point；本地餐食版本永不覆盖。
- `NutritionLog` 顶层承载 `energy`（kcal）、`energyFromFat`（kcal）、`totalCarbohydrate`（g）和 `totalFat`（g）；`nutrients[]` 承载其余营养素。`NutrientQuantity` 在 API 中统一以克表示。
- Google 支持的 `nutrients[]` 枚举有：`BIOTIN`、`CAFFEINE`、`CALCIUM`、`CHLORIDE`、`CARBOHYDRATES`、`CHOLESTEROL`、`CHROMIUM`、`COPPER`、`DIETARY_FIBER`、`FOLIC_ACID`、`FOLATE`、`IODINE`、`IRON`、`MAGNESIUM`、`MANGANESE`、`MOLYBDENUM`、`MONOUNSATURATED_FAT`、`NIACIN`、`PANTOTHENIC_ACID`、`PHOSPHORUS`、`POLYUNSATURATED_FAT`、`POTASSIUM`、`PROTEIN`、`RIBOFLAVIN`、`SATURATED_FAT`、`SELENIUM`、`SODIUM`、`SUGAR`、`THIAMIN`、`TRANS_FAT`、`UNSATURATED_FAT`、`VITAMIN_A`、`VITAMIN_B12`、`VITAMIN_B6`、`VITAMIN_C`、`VITAMIN_D`、`VITAMIN_E`、`VITAMIN_K`、`ZINC`。
- Data point 可以采用客户端提供的 4–63 位小写字母、数字、连字符 ID。每个本地餐食版本生成稳定的 `meal-<uuid>` ID；网络超时后先 `get` 该 ID 再决定是否重发，避免重复写入。

规范来源： [Google Health scopes](https://developers.google.com/health/scopes)、[Nutrition guide](https://developers.google.com/health/data-types/nutrition)、[NutritionLog / Nutrient reference](https://developers.google.com/health/reference/rpc/google.devicesandservices.health.v4)、[DataPoint create](https://developers.google.com/health/reference/rest/v4/users.dataTypes.dataPoints/create)。

## 3. 分层架构：不用 MCP

MCP 不作为产品运行时协议。它适合通用 Agent 调用外部工具，但会让用户授权、请求幂等、写入审计和失败重试依赖模型行为。运行时使用后端内部的强类型服务与 Google Health REST client：

```text
Browser
  └─ POST /api/meals/photo ──► MealVisionService ──► VisionProvider
                                      │                    │
                                      │                候选 JSON，不能写数据
                                      ▼
                              NutritionResolver
                                      │
                                      ▼
                            MealDraft（待确认）
                                      │
                     用户修正并确认 + 写回开关
                                      ▼
        transaction: MealVersion + MealNutrients + NutritionWriteOutbox
                                      │
                                      ▼
          Docker worker ──► GoogleHealthNutritionClient ──► nutrition-log
```

`VisionProvider` 允许替换模型；一期候选仍为 DeepSeek Vision，但只接收移除 EXIF 后的餐食图，且只返回受 JSON Schema 约束的候选。`NutritionResolver` 是唯一计算营养数值的组件；它查询具备商业使用授权的中国食物成分数据和版本化菜谱，绝不采用视觉模型直接声称的维生素或热量数值。

AI Coach 是独立的只读消费者：仅能读取用户确认的日/周营养汇总、证据来源和置信度；不能读取照片原文、OAuth token 或直接调用 Google 写入服务。

## 4. 照片输出与确认

Vision 模型返回的只是可审计候选：

```json
{
  "foods": [
    {
      "nameZh": "番茄炒蛋",
      "ingredients": ["鸡蛋", "番茄", "食用油"],
      "portionGrams": {"min": 140, "max": 220},
      "visibleFraction": "partial",
      "confidence": 0.72,
      "needsConfirmation": ["油量", "实际食用比例"]
    }
  ],
  "photoQuality": "usable",
  "globalUncertainties": ["是否使用额外酱汁不可见"]
}
```

确认页显示菜品、食材、份量范围、餐次、时间和关键不确定项。用户可以改为准确克数、添加/删去食材、指定食用比例或选择不写回。包装食品优先 OCR 条码、产品名与营养标签，再由用户确认；没有可靠数据库或菜谱匹配时，保留草稿并要求手工填写，不能伪造完整营养。

照片估算记录的 `source` 为 `vision_estimate`；包装标签为 `label_confirmed`；用户手工修正为 `user_confirmed`。每项营养还保存 `confidence`、`databaseVersion`、`recipeVersion` 与计算输入。未知值必须为 `null` 并从 Google payload 省略；只有确认无该营养素时才写显式 0。

## 5. 本地规范化营养模型

本地不是为 Google 的字段裁剪的镜像，而是完整、可扩展的规范层。

### 5.1 营养代码

所有重量类营养以 `grams NUMERIC(20,9)` 存储，能量以 `kcal NUMERIC(12,3)` 存储；界面按合适单位转为 g、mg 或 μg。这样维生素 D、B12 等微量值写入 Google 时不会因展示层取整为零。

代码集合至少覆盖 Google 的全部营养素，并额外包含：`ADDED_SUGAR`、`FREE_SUGAR`、`OMEGA_3`、`ALA`、`EPA`、`DHA`、`CHOLINE`、`FLUORIDE`。后者没有 Google 对应字段，只在本地保存和展示。

营养字段与中国标签命名/单位对齐 `GB 28050-2025`；个人目标不使用统一 NRV，而按年龄、性别、活动与孕哺状态选用《中国居民膳食营养素参考摄入量（2023）》的 RNI、AI、UL。标准仅用于展示与 Coach 的非诊断提示，不能将估算结果解释为医学缺乏。

### 5.2 持久化实体

| 实体 | 不可变内容 | 用途 |
| --- | --- | --- |
| `meal_drafts` | 上传/分析状态、候选、照片过期时间 | 用户确认前的可编辑工作区 |
| `meal_versions` | 用户、餐次、时间、菜品摘要、确认时间、前一版本 | 每次确认/编辑形成新版本 |
| `meal_ingredients` | 食物/菜谱 ID、用户确认克数、来源版本 | 可重算和解释营养 |
| `meal_nutrients` | `nutrient_code`、grams/kcal、来源、置信度、覆盖率 | 完整营养事实 |
| `nutrition_write_outbox` | 版本、操作、稳定 data point ID、payload hash、状态、下次尝试 | 可靠异步写 Google |
| `google_nutrition_links` | 已同步版本与 Google data point name | 编辑时定位删除对象 |

任何查询都以服务器 session 的 `user_id` 过滤。照片二进制不进入这些业务表；默认在视觉请求完成或失败后 24 小时内从私有存储删除，用户显式选择保留重试时最长 30 天。

## 6. Google 写回映射

1. `NutritionResolver` 只从已确认的 `meal_version` 生成 payload。
2. `energy`、`energyFromFat`、`totalCarbohydrate` 和 `totalFat` 写顶层；`CARBOHYDRATES` 不重复放入 `nutrients[]`。Google 支持的其他非空营养素写进 `nutrients[]`，并转换到克。
3. `ADDED_SUGAR`、`FREE_SUGAR`、Omega-3 / ALA / EPA / DHA、胆碱、氟等不出现在 payload，但完整留在 `meal_nutrients`。
4. 若菜单可精确匹配 Google Food resource，优先写 `food`；否则写 anonymous food 的 `foodDisplayName` 和计算值。中餐默认走后者。
5. 只有连接仍为 `active`/`partial`、实际已授营养写 scope、用户的 `writeback_enabled=true` 且本餐确认后，才创建 outbox 任务。

## 7. 可靠性状态机

确认餐食与 outbox 任务必须同一 PostgreSQL 事务提交。HTTP 请求不在浏览器请求中直接承担可靠性责任；用户保存后显示“等待写入”或“仅保存在本地”，Docker worker 每分钟处理到期 outbox 项。

```text
draft → confirmed_local → write_pending → synced
                                  ├── retrying
                                  ├── local_only (未开写回/权限缺失)
                                  └── failed_action_required
```

- 新建：outbox 使用版本稳定 ID `meal-<uuid>` 作为 client-provided data point ID。超时或进程中断后，先用 `.nutrition.readonly` 查询该 ID；把返回数据规范化为 Google 可写字段后与本地 payload hash 比较，相同才标记 `synced`，否则再安全重试。
- Google `create`、`batchDelete` 返回 `Operation`。若响应并非 `done=true`，worker 持久化 operation name 并通过已验证的 Google Operation 查询契约在后续 tick 检查状态；只有 `done=true` 且无 error 才推进状态。该查询路径和失败语义必须纳入真实 Fitbit Air 合同测试，不能由 mock 假定。
- Google 限流和 5xx 按 1 分钟、5 分钟、30 分钟退避，随后保留失败原因并让用户点击重试；401/403、撤销授权和 scope 缺失不盲目重试。
- 编辑：先在本地创建新版本，然后 enqueuing `delete_old → create_new` saga。anonymous log 不能 PATCH；旧 data point 删除成功而新建失败时，Google 会暂时没有该餐，但本地新版本仍存在且任务会继续重试，界面明确显示“Google 写回恢复中”。这样不会在 Google 日汇总中出现双计数。
- 用户断开账户或关闭写回：取消所有待写任务，不再尝试使用已清除的 token；本地已确认餐食不删除。

## 8. 隐私、安全与可观测性

- 上传限制 MIME、文件大小、解码后的像素数；清除 EXIF，不接受公开图片 URL；私有对象路径与用户隔离。
- 首次识别前单独说明照片将发送给模型供应商，且允许用户跳过 AI 进入手工记录。
- API key、Google token、原图和模型原始响应绝不进入浏览器日志、worker 日志或异常正文。保留最小的模型版本、提示词版本、响应 hash、数据库版本和写回状态。
- 内部 worker endpoint 延续现有 bearer secret、Docker 内网与计数式响应原则；不得返回用户 ID、营养 payload 或照片元数据。
- 用户可以删除本地餐食并请求删除对应 Google data point；写回只影响本应用创建的记录。

## 9. 实施前置与验收

### 外部前置

1. 选定并获得商业使用授权的中国食物成分数据源；其许可证、更新频率和字段覆盖率需要记录。未满足时只可交付手工/示例数据流程，不能声称营养估算可靠。
2. 配置并评测 VisionProvider；DeepSeek Vision 必须通过旧设计中独立 holdout 的中餐候选、份量、不确定性、JSON 有效率、成本与隐私门槛。
3. 用真实 Fitbit Air 测试账户验证 Google `nutrition-log` 的完整字段、client-provided ID、Operation 轮询、匿名删除重建与数据源可见性。

### 验收测试

1. 模型输出被 JSON Schema 和业务规则拒绝时不会创建餐食或 Google 请求。
2. 同一确认餐食在网络超时、worker 重启和重复 tick 后最多产生一个 Google data point。
3. 已确认的维生素、矿物质和脂肪细分正确映射为 API grams；不支持/未知字段不写 Google 且仍保留本地。
4. 匿名餐食编辑不会使用 PATCH；删除旧记录、创建新记录与失败恢复状态可观察。
5. 断开、缺写权限或关闭写回时，只保存本地，不发 Google 请求。
6. 多用户无法读取、修改或写入他人的草稿、照片、餐食、outbox 或 Google data point。
7. 图片过期删除、原图不进日志、模型和 Google 凭证不出现在响应或 worker 输出。
