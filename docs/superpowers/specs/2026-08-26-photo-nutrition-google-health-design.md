# 拍照记餐、完整营养与 Google Health 写回设计

**状态：** 草案（按审查修订中）
**日期：** 2026-08-26
**取代范围：** 本文细化 `2026-08-23-03-deepseek-vision-validation-design.md` 中营养计算、完整字段、照片生命周期与 Google Health 写回部分；该旧文的视觉模型评测门槛仍然有效。本文第 4 节的 Vision JSON 为运行时唯一 schema，覆盖旧文第 4 节的 `meal_candidates` 示例。

## 1. 目标与非目标

用户拍摄或上传**一张**餐食照片后，产品给出可编辑的多道菜候选（菜品、食材与份量范围）；由版本化食物成分数据计算完整营养素。用户确认后，每一道确认的菜写入一条 Google Health `nutrition-log`；其余营养事实、估算依据与置信度只保存在本产品。

一期目标是可靠的餐食记录与可解释的营养估算，而不是医疗诊断、维生素缺乏判断或无确认的自动写入。模型不持有 Google 凭证、不会调用写接口，也不能绕过用户确认。本产品不持久化原图。

## 2. 已核实的 Google Health API 契约

- `https://www.googleapis.com/auth/googlehealth.nutrition.writeonly` 可创建或删除本应用写入的营养数据；项目既有十项 OAuth 授权已包含该 scope。写回仍须账户开关与该次确认（见第 6.2 节）。
- `nutrition-log` 支持 `create`、`get`、`list`、`reconcile`、`rollup`、`dailyRollup`、`update` 和 `batchDelete`。写入入口是 `POST /v4/users/me/dataTypes/nutrition-log/dataPoints`。**匿名 log 创建后不可 PATCH**；类型表中的 `update` 只适用于 identified food，一期照片路径不用。
- 食物数据库为只读，且 identified food 会用 Google 食物库**覆盖**调用方提供的营养字段。一期照片记餐一律写 anonymous food：`foodDisplayName` 加上本产品算出的营养。不匹配 Google Food resource。
- anonymous food 不能更新。用户编辑时必须删除旧 Google data point 后创建新 data point；本地餐食版本永不覆盖。
- `NutritionLog` 顶层承载 `energy`（kcal）、`energyFromFat`（kcal）、`totalCarbohydrate`（g）和 `totalFat`（g）；`nutrients[]` 承载其余营养素。`NutrientQuantity.quantity` 的存储单位是克；展示可用 `WeightQuantity.userProvidedUnit`（如 `MICROGRAM`）。已知脂肪时 `energyFromFat` = 脂肪克数 × 9 kcal/g；脂肪未知则省略该字段。
- Google 支持的 `nutrients[]` 枚举有：`BIOTIN`、`CAFFEINE`、`CALCIUM`、`CHLORIDE`、`CARBOHYDRATES`、`CHOLESTEROL`、`CHROMIUM`、`COPPER`、`DIETARY_FIBER`、`FOLIC_ACID`、`FOLATE`、`IODINE`、`IRON`、`MAGNESIUM`、`MANGANESE`、`MOLYBDENUM`、`MONOUNSATURATED_FAT`、`NIACIN`、`PANTOTHENIC_ACID`、`PHOSPHORUS`、`POLYUNSATURATED_FAT`、`POTASSIUM`、`PROTEIN`、`RIBOFLAVIN`、`SATURATED_FAT`、`SELENIUM`、`SODIUM`、`SUGAR`、`THIAMIN`、`TRANS_FAT`、`UNSATURATED_FAT`、`VITAMIN_A`、`VITAMIN_B12`、`VITAMIN_B6`、`VITAMIN_C`、`VITAMIN_D`、`VITAMIN_E`、`VITAMIN_K`、`ZINC`。
- Data point 可以采用客户端提供的 4–63 位小写字母、数字、连字符 ID。每一道确认后的菜有自己的短 ID，写入完整资源名（见第 6.3 节）。
- 必填 `interval`（`startTime` / `endTime`）和 `mealType`。中文餐次映射：早餐 `BREAKFAST`、午餐 `LUNCH`、晚餐 `DINNER`、加餐 `SNACK`。时间按用户确认的 Asia/Shanghai 民用时间；interval 为该时刻起 1 秒，不假装知道实际进食时长。不用 `BEFORE_*` / `ANYTIME`。

规范来源： [Google Health scopes](https://developers.google.com/health/scopes)、[Nutrition guide](https://developers.google.com/health/data-types/nutrition)、[NutritionLog / Nutrient reference](https://developers.google.com/health/reference/rpc/google.devicesandservices.health.v4)、[DataPoint create](https://developers.google.com/health/reference/rest/v4/users.dataTypes.dataPoints/create)。

## 3. 分层架构：不用 MCP

MCP 不作为产品运行时协议。运行时使用后端内部的强类型服务与 Google Health REST client：

```text
Browser（一张图，客户端压缩并去 EXIF）
  └─ POST /rhythm/api/meals/photo
         MealVisionService（仅请求内存）──► VisionProvider ──► 候选 JSON
                      │
                      ▼
         NutritionResolver.estimate（区间，只供展示）
                      │
                      ▼
         MealDraft（结构化候选 + 可选估算；不存图）
                      │
         PATCH 草稿 / 用户按道改克数
                      │
                      ▼
         POST …/confirm
         NutritionResolver.finalize（点值，唯一事实）
                      │
                      ▼
         transaction: MealVersion + 每道确认菜的 dishes/ingredients/nutrients
                      + 符合条件的菜各一条 NutritionWriteOutbox
                      │
                      ▼
         nutrition-sync worker ──► GoogleHealthNutritionClient
                      ──► 每道菜一条 nutrition-log
```

`VisionProvider` 允许替换模型；一期候选仍为 DeepSeek Vision。`NutritionResolver` 是唯一计算营养数值的组件，分两拍（见第 4.3 节）。

AI Coach 是独立的只读消费者：仅能读取用户确认的日/周营养汇总、证据来源和置信度；不能读取照片原文、OAuth token 或直接调用 Google 写入服务。

## 4. 照片、识别与确认

### 4.1 不落盘

比「先写磁盘、结果出来再删」更好：发给模型时图必须在内存里，落盘不减少内存；崩溃会留下孤儿文件，又要扫盘。一期不提供「保留照片再识别」。

1. 原图只存在于当次 `POST /rhythm/api/meals/photo` 的请求内存。成功、校验失败、模型失败或超时后立即丢弃。
2. 不接受公开图片 URL。浏览器不直连模型供应商。
3. 客户端：仅 JPEG/WebP，长边压到 ≤ 1536，去掉 EXIF。服务端拒绝其它 MIME、请求体 > 4 MiB、解码后长边 > 2048 或总像素 > 4_000_000。
4. 日志、异常、worker 输出不得包含原图或 base64。
5. 识别失败或离开页面后必须重新上传。确认页不依赖服务端原图。

拍照前单独同意将本张图片发给模型；拒绝则走手工记餐（`POST /rhythm/api/meals`）。供应商侧留存按其条款。

### 4.2 一张总览，模型按道拆开

一期默认拍一张能囊括这一餐的照片。不做连拍或多张加拍。确认页允许手工增删菜。

| 方案 | 取舍 |
| --- | --- |
| 一张总览（采用） | 对准「30 秒记一餐」；一次模型调用。份量更粗，靠确认页改克数。 |
| 每道菜一张 | 识别更稳，步骤和费用随菜数线性增加。 |
| 总览 + 可选加拍 | 一期不做。 |

Vision 必须按「道」拆开。包装食品的条码、产品名、标签营养也由**同一次** Vision JSON 给出（可选字段），不另建 OCR 服务：

```json
{
  "foods": [
    {
      "nameZh": "番茄炒蛋",
      "ingredients": ["鸡蛋", "番茄", "食用油"],
      "portionGrams": {"min": 140, "max": 220},
      "visibleFraction": "partial",
      "confidence": 0.72,
      "needsConfirmation": ["油量", "实际食用比例"],
      "barcode": null,
      "labelText": null
    },
    {
      "nameZh": "米饭",
      "ingredients": ["稻米"],
      "portionGrams": {"min": 150, "max": 250},
      "visibleFraction": "full",
      "confidence": 0.8,
      "needsConfirmation": [],
      "barcode": null,
      "labelText": null
    }
  ],
  "photoQuality": "usable",
  "globalUncertainties": ["共享菜无法判断实际食用比例"]
}
```

### 4.3 NutritionResolver 两拍

| 拍 | 何时 | 输入 | 输出 | 用途 |
| --- | --- | --- | --- | --- |
| `estimate` | 识图成功写入草稿时 | `foods[]` 的份量**区间**、食材候选 | 每道菜的营养**区间**（可空） | 确认页展示。不落 `meal_nutrients`，不写 Google |
| `finalize` | 用户确认保存时 | 该道菜的**点值克数**、确认食材 | 每道菜一组营养点值 | 唯一事实：写入 `meal_nutrients` 并生成 Google payload |

`estimate` 在以下情况对该道菜不预填 kcal（区间也为空）：共享菜或食用比例未确认、油量标为需确认且用户未填、找不到数据库/菜谱、能量区间宽度超过中点的 100%。模型不得直接提供热量数字。

写回 Google 只接受 `finalize` 的点值，不写区间中点。

### 4.4 保存规则：不能部分确认

保存（`confirm`）时，草稿里**仍留下的每一道菜**都必须同时满足：用户确认的点值克数、食用比例已确认、油量等 `needsConfirmation` 已处理或该菜已被用户删除。

任一留下的菜未完成 → `400`，整餐不建 `meal_version`，草稿保留。不想记的菜先删掉再保存。一期不做「先存米饭、番茄炒蛋留草稿」——那会把一餐拆成两个 version，后续合并又要删再建米饭的 Google log。

`source`：`vision_estimate`、`label_confirmed`、`user_confirmed`。未知营养为 `null` 并从 Google payload 省略；只有用户确认「无该营养素」时才写显式 0。

## 5. 本地模型与 HTTP

### 5.1 营养代码与克数关系

重量类营养以 `grams NUMERIC(20,9)` 存储，能量以 `kcal NUMERIC(12,3)` 存储。写入 Google 时转到克，微量营养素设置 `userProvidedUnit`（维生素 A/D 等用 `MICROGRAM`）。额外本地代码：`ADDED_SUGAR`、`FREE_SUGAR`、`OMEGA_3`、`ALA`、`EPA`、`DHA`、`CHOLINE`、`FLUORIDE`。

标签命名对齐 `GB 28050-2025`；个人目标用《中国居民膳食营养素参考摄入量（2023）》的 RNI、AI、UL，不用统一 NRV，不作医学缺乏判断。

**菜与食材：**

- `meal_dishes.portion_grams`：用户确认的**这道菜进食克数**。Google 一条 log 对应这一行的营养合计。
- `meal_ingredients`：菜谱拆解，克数按菜的进食克数缩放，只用于重算和解释，不单独写 Google。
- `meal_nutrients`：挂在**菜**上，等于食材营养缩放后的合计。写回读这一层。

### 5.2 持久化实体

| 实体 | 内容 | 用途 |
| --- | --- | --- |
| `users.nutrition_writeback_enabled` | `boolean not null default false` | 账户级写回开关，**不**放在 `google_health_connections` |
| `meal_drafts` | 候选 JSON、estimate 区间、餐次/时间 | 确认前工作区；无照片 |
| `meal_versions` | 用户、餐次、时间、确认时间、前一版本、该次是否请求写回 | 「这一餐」的一次确认 |
| `meal_dishes` | 名称、进食克数、来源、client 短 ID | 一餐多道；每道新 version 都分配新的 `d-{uuid}` |
| `meal_ingredients` | 食物/菜谱 ID、缩放克数、版本 | 重算 |
| `meal_nutrients` | 菜级 nutrient_code、grams/kcal、来源、置信度 | 事实 |
| `nutrition_write_outbox` | 一道菜、操作、完整 data point name、nutritionLog hash、状态 | 一道菜一条任务 |
| `google_nutrition_links` | 菜（该 version 的 dish）与 Google `name` | 删除时定位 |

任何查询按 session `user_id` 过滤。编辑生成新 `meal_version` 和新的一组 `meal_dishes`（含未改动的菜也换新 `d-{uuid}`）。匿名 log 不能 PATCH，未改动的菜也走删旧建新，避免跨版本稳定 ID。

### 5.3 HTTP（均需登录 session，前缀 `/rhythm`）

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `POST` | `/api/meals/photo` | 上传一图；返回 `draftId` + 候选 + estimate |
| `GET` | `/api/meals/drafts/:id` | 读草稿（无图） |
| `PATCH` | `/api/meals/drafts/:id` | 改菜、克数、餐次、时间、食用比例 |
| `POST` | `/api/meals/drafts/:id/confirm` | 校验第 4.4 节后 `finalize` 并落 version；body 含 `writebackThisMeal` |
| `POST` | `/api/meals` | 手工记餐（无图），body 与 confirm 的菜结构相同 |
| `GET` | `/api/meals` | 当前用户已确认餐食列表 |
| `GET` | `/api/meals/:id` | 某 version：菜、营养、每道 outbox 状态 |
| `POST` | `/api/meals/:id/revise` | 基于已确认餐食出新 version（无图） |
| `DELETE` | `/api/meals/:id` | 删本地；对已同步的菜 enqueue `batchDelete` |
| `POST` | `/api/account/nutrition-writeback` | 开/关 `users.nutrition_writeback_enabled` |
| `POST` | `/api/meals/dishes/:dishId/retry` | 用户对 `retrying` / `failed_action_required` 点重试。`unknown` 不提供此按钮，直到合同测试允许重放 |
| `POST` | `/api/internal/nutrition-sync` | worker 认领到期 outbox；bearer 与现有 `SYNC_SECRET` 相同，路径与健康同步分开 |

## 6. Google 写回

### 6.1 映射

1. **一道确认的菜 = 一条 anonymous `nutrition-log`。** 禁止整桌一个 `foodDisplayName`。
2. Payload 来自该菜的 `finalize` 结果：顶层 `energy`、`energyFromFat`、`totalCarbohydrate`、`totalFat`；`CARBOHYDRATES` 不进 `nutrients[]`。
3. 本地独有代码不进 payload。

### 6.2 何时建 outbox

同时满足才为该菜插入 `create` 任务：

1. `users.nutrition_writeback_enabled === true`
2. 该次 `confirm` / `revise` body 的 `writebackThisMeal === true`
3. 连接 `active` 或 `partial`，且 `canWriteNutrition(grantedScopes)`
4. 该菜已通过第 4.4 节确认

缺开关或缺写 scope → 餐食仍保存，outbox 为 `local_only`。Google 已授 `nutrition.writeonly` 不等于可以写回。

### 6.3 client-provided name 与 hash

短 ID：`d-{uuid}`（小写，约 38 字符）。完整 name：

```text
users/me/dataTypes/nutrition-log/dataPoints/d-{uuid}
```

create：

```http
POST /v4/users/me/dataTypes/nutrition-log/dataPoints
```

```json
{
  "name": "users/me/dataTypes/nutrition-log/dataPoints/d-550e8400-e29b-41d4-a716-446655440000",
  "nutritionLog": {
    "interval": {
      "startTime": "2026-08-26T12:00:00+08:00",
      "endTime": "2026-08-26T12:00:01+08:00"
    },
    "mealType": "LUNCH",
    "foodDisplayName": "番茄炒蛋",
    "energy": { "kcal": 220 },
    "energyFromFat": { "kcal": 126 },
    "totalCarbohydrate": { "grams": 8 },
    "totalFat": { "grams": 14 },
    "nutrients": [
      { "nutrient": "PROTEIN", "quantity": { "grams": 12 } }
    ]
  }
}
```

恢复时：

```http
GET /v4/users/me/dataTypes/nutrition-log/dataPoints/d-550e8400-e29b-41d4-a716-446655440000
```

`payload hash` = `sha256(canonicalJSON(nutritionLog))`，只包含我们**发出去**的 `nutritionLog` 字段。GET 响应里的 `dataSource`、外层 `name`、服务器补的 civil time / utcOffset **不参与** hash。比较前把 GET 的 `nutritionLog` 抽成同一规范再哈希。

## 7. 可靠性状态机

确认与该餐要创建的 outbox 同一 PostgreSQL 事务提交。写回 worker 是 Compose 服务 `nutrition-sync`（`node worker/nutrition-loop.mjs`），每分钟 `POST /rhythm/api/internal/nutrition-sync`；与健康同步 `sync` 服务分开，不共用 15 分钟连接 lease。可共用 `SYNC_SECRET`。

状态挂在**每一道菜的 outbox** 上：

```text
（confirm 事务内）
         ├─ local_only                  未开写回或无写权限
         └─ write_pending
                ├─ operation_pending    create/batchDelete 已接受，Operation 未 done
                ├─ synced
                ├─ retrying             429 / 5xx，按 1m / 5m / 30m 退避
                ├─ unknown              超时或响应不可解析；GET 未找到
                └─ failed_action_required   401/403、撤销、backoff 用尽
```

- 超时：GET 到且 hash 一致 → `synced`。GET 404 / 未找到 → `unknown`，**不自动再 create**。界面：「同步状态待确认」。在合同测试证明同一 name 可安全重放之前，不提供重试按钮。禁止按时间和营养值模糊匹配第二条。
- `done=true` 且无 error 才离开 `operation_pending`。未完成 Operation 不得第二次 create。
- 编辑：新 version、每道菜新 `d-{uuid}`。对旧版 `google_nutrition_links` enqueue `delete_old`，对新菜 enqueue `create_new`。删成功建失败时界面「Google 写回恢复中」，不得标已同步，不得新旧并存双计数。
- 断开或关闭账户写回开关：取消 `write_pending` / `retrying` / `operation_pending`；`unknown` 不再轮询；本地餐食保留。

## 8. 隐私、安全与可观测性

- 第 4.1 节的 MIME / 体积 / 像素限制；原图不落盘；不接受 URL。
- 首次识别前单独同意；可跳过 AI。
- 密钥、原图、模型原文不进日志。只留模型版本、提示词版本、响应 hash、数据库版本、写回状态计数。
- `/api/internal/nutrition-sync` 只返回 `{ claimed, succeeded, failed, unknown }` 这类计数。
- 用户删除只 batchDelete 本应用 `google_nutrition_links` 里的 name。

## 9. 关键决定

1. **不落盘，请求内直传模型。**
2. **一餐一张总览；** `foods[]` 按道拆；一期不加拍。
3. **一道确认的菜 = 一条 anonymous nutrition-log。**
4. **Resolver 两拍：** estimate 供展示，finalize 才是事实。
5. **保存必须确认草稿里留下的每一道菜**；不支持一餐拆两次保存。
6. **写回 = 账户开关 ∧ 该次 confirm 勾选 ∧ 营养写 scope。** 开关在 `users.nutrition_writeback_enabled`。
7. **超时 GET 不到则为 `unknown`，不自动重放。** create 使用完整 DataPoint name。
8. **编辑给每道菜换新 `d-{uuid}`，** 未改动的菜也删再建。
9. **写回 worker 与健康同步分开**；条码/标签走同一 Vision JSON。

## 10. 实施前置与验收

### 外部前置

1. 商业授权的中国食物成分数据源；未满足时只交付手工记餐。
2. VisionProvider 通过旧文 holdout（须含一图多菜）。
3. 真实 Fitbit Air 账户验证：完整字段、client-provided **完整 name**、GET 恢复、Operation、匿名删再建、一餐多 log。在证明可安全重放之前，`unknown` 不得改成自动 create。

### 验收测试

1. Schema / 业务规则拒绝时不建餐食、不打 Google。
2. 同一 `d-{uuid}` 在超时、重启、重复 tick 后最多一条 Google data point。
3. 一餐两道确认菜 → 两条 log、两个 name；删除只影响对应那条。
4. 留下未确认菜时 `confirm` 返回 400，无 `meal_version`。
5. 微量营养素为 grams + `userProvidedUnit`；本地独有字段不写 Google。
6. 不 PATCH 匿名 log；删旧建新与「恢复中」可观察。
7. 账户关写回或该次不勾选或无写 scope → `local_only`，无 Google 请求。
8. 跨用户读不到他人草稿、餐食、outbox。
9. 原图不落盘、不进日志；请求结束后不保留 buffer。
10. 共享菜未确认食用比例时 estimate 不预填 kcal；未删该菜则无法 confirm。
