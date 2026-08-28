# 手机端餐食审阅与显式同步 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户在手机网页上传一张餐食照片、审阅并修改完整营养、获得可选择应用的 AI 建议；先保存本地最新值，只有点击“同步这一餐”时才安全写入 Google Health。

**Architecture:** 将照片识别结果转换为可编辑的草稿快照，服务器以本地台湾 FDA 数据库为唯一营养计算权威。保存后数据进入一组只保存当前值的 `current_meal_*` 表；同步元数据独立于当前菜品行，以同步 generation 和远端 point name 保留删除/恢复所必需的最小信息。Google 写入继续由 Compose worker 异步执行：重同步严格先删除旧 point、再创建新 point，状态未知时只做精确 GET 恢复，绝不重放写请求。

**Tech Stack:** Next.js App Router、React client components、CSS modules、PostgreSQL/`pg`、Zod、node:test + tsx、DeepSeek chat completions、Google Health v4 nutrition-log。

**Spec:** `docs/superpowers/specs/2026-08-26-mobile-meal-review-and-sync-design.md`

---

## 不可变实现约束

- 不存照片字节、data URL、AI 消息或 AI 建议。原始识别 JSON 只在尚未保存的 `meal_drafts` 中短暂保留，以构造 editor；照片预览只存当前 client component 的内存；草稿保存成餐食后删除整行 `meal_drafts`，已保存餐食不保留原始识别 JSON。
- 前端从不计算营养、从不选择 Google payload、从不持有 OAuth token。所有食材重算、单项覆盖、Google 字段过滤都在服务器完成。
- `保存修改` 只能写本地；不能创建任何旧版或新版 outbox。`同步这一餐` 是唯一允许创建新版同步 generation 的用户动作。
- 保留旧 `meal_versions` / `nutrition_write_outbox` 及其 worker，以完成已经存在的旧任务；新版端点绝不能再向这些旧表写入。旧 `/confirm` 端点改为明确的废弃响应，防止旧路径绕过“两步同步”。
- 新版一个 active generation 未结束（尤其含 `unknown`）时禁止编辑、禁止再开新 generation、禁止重新 POST create/delete。`recovery` 页面唯一保留的固定动作是“重试这一餐”，并按最不安全状态优先：generation 含任一 `unknown` 时，它只请求已有 generation 的精确名称 GET 恢复，绝不新建 name 或重放写请求；只有所有 unknown 解除后，已确认的 `failed_action_required` 才能在用户完成重新授权/开启写回后恢复原有的已知 pending operation，仍不创建新 generation 或 name。

## 文件地图

| Path | Responsibility |
| --- | --- |
| `db/migrations/009_mobile_meal_review.sql` | 草稿编辑快照、只保留当前值的餐食表、独立的 generation/point 同步状态表与索引。 |
| `src/domain/meal-editor.ts` | 可编辑餐食、食材克数、营养覆盖、客户端/API 响应与 PATCH action 的 Zod schema。 |
| `src/domain/meal-ai-suggestions.ts` | DeepSeek suggestion JSON schema、单条 suggestion 与“应用全部”冲突判定。 |
| `src/server/nutrition/tw-fda.ts` | 基于明确食材克数（而非 vision 等比分配）计算一盘菜。 |
| `src/server/meals/current-meal.ts` | 从 vision 建立草稿编辑快照、食材重算、单项营养覆盖、保存/读取模型和 Google payload 投影。 |
| `src/server/meals/meal-assistant.ts` | 无照片的 DeepSeek 文本请求、严格 JSON 解析和服务端 suggestion 校验。 |
| `src/server/meals/current-meal-sync.ts` | 新 generation 的 delete → create 状态机、精确 GET 恢复与 lease-safe worker。 |
| `src/server/meals/nutrition-outbox.ts` | 共享的 Google client 增加 `batchDelete`；旧 outbox 行为保持不变。 |
| `src/server/meals/http.ts` | 新草稿、当前餐食、AI、显式同步的 session/origin 保护 HTTP handlers；旧 confirm 废弃。 |
| `src/server/auth/types.ts` | `AuthStore.currentMeals` 和 `AuthStore.currentMealSync` 的最小读写/claim 接口。 |
| `src/server/db/memory-store.ts` | 新存储接口的内存实现及测试观察器。 |
| `src/server/db/postgres-store.ts` | 新表映射、行锁/事务、按 generation claim 和状态转移。 |
| `src/server/meals/internal-nutrition-sync.ts` | 在保留旧 outbox worker 的前提下运行新 generation worker，返回安全的聚合计数。 |
| `app/api/meals/**` | 受 session 保护的 App Router 路由。 |
| `app/meals/new/page.tsx`, `app/meals/[id]/page.tsx` | 新建餐食与已保存餐食的入口页。 |
| `src/ui/meals/mobile-meal-editor.tsx` | 一个复用的、手机优先的上传/编辑/AI/同步 client component。 |
| `src/ui/meals/nutrient-presentation.ts` | 固定分组、中文标签、单位和 suggestion 冲突的纯展示辅助函数。 |
| `src/ui/meals/meal-editor.module.css` | 320–430 px 优先的编辑器、底部弹层、固定操作栏；桌面双栏适配。 |
| `src/ui/dashboard/today-dashboard.tsx` | 增加“记录餐食”入口，不改变既有指标逻辑。 |

## API 契约（实现前固定）

所有路由都在项目现有 `/rhythm` base path 下；下列 JSON 不含图片、token、原始 vision 结果或聊天记录。

| Method / path | Request | 成功响应 / 关键错误 |
| --- | --- | --- |
| `POST /api/meals/photo` | 现有 multipart，保留 `aiPhotoConsent` | `201 { draft }`；`draft` 是可编辑结构和已计算营养。 |
| `GET /api/meals/drafts/:id` | — | `{ draft }`；只返回编辑快照。 |
| `PATCH /api/meals/drafts/:id` | `replace_ingredients` 或 `set_nutrient` action | `{ draft }`；食材 action 只重算目标菜，营养 action 只替换目标营养项。 |
| `POST /api/meals/drafts/:id/ai-suggestions` | `{ question }` | `{ suggestions }`；不持久化。 |
| `POST /api/meals/drafts/:id/save` | `{}` | `201 { meal }`；不产生同步任务。 |
| `GET /api/meals/:id` | — | `{ meal }`，包括本地/Google 可同步状态和人类可读原因。 |
| `PATCH /api/meals/:id` | 同上两种 action | `{ meal }`；成功后 `contentRevision + 1` 且变为 `unsynced`。 |
| `POST /api/meals/:id/ai-suggestions` | `{ question }` | 同草稿 AI schema，只以当前已保存餐食结构请求模型。 |
| `POST /api/meals/:id/sync` | `{}` | `202 { meal }`；新建或恢复本餐的一个 generation；任一 `unknown` 存在时仅排 exact-GET，全部解除后已恢复权限的 `failed_action_required` 才回到原有 pending operation；绝不接收批量 ID。 |

`replace_ingredients` 的 request shape 固定为：

```ts
{
  kind: 'replace_ingredients';
  dishId: string;
  nameZh: string;
  ingredients: Array<{ nameZh: string; grams: number }>;
}
```

`portionGrams` 始终由服务端取 `ingredients[].grams` 之和，不允许前端传入另一个可能冲突的总克数。`set_nutrient` 固定为 `{ kind: 'set_nutrient', dishId, nutrientCode, value, unit }`，只可改当前已有代码；`ENERGY` 只接受 `kcal`，其他行只接受该代码规定的 `g` / `mg` / `μg` 显示单位。所有数值必须有限且非负。

## 数据模型和状态机（实现前固定）

迁移不得重写 `005`–`008`。`009` 采用以下前向结构：

- `meal_drafts.editor JSONB NULL`：仅草稿期保存 `{ dishes, nutrients, mealType, eatenAt }` 的可编辑快照；现有 `vision` 只用于从识别结果构造 editor，保存成功时随 draft 行一起删除。
- `current_meals`：`id`、`user_id`、餐次、时间、`content_revision`、`sync_state`（`unsynced | syncing | synced | recovery`）、`last_synced_generation_id`、时间戳。用户可见值只存在这一餐及其三个 child 表中。
- `current_meal_dishes`、`current_meal_ingredients`、`current_meal_nutrients`：current meal 的菜、明确克数和全量本地营养。菜的 UUID 仅在这道当前菜存续期间稳定；同步表不对它设外键。
- `meal_sync_generations`：冻结的 `content_revision`、phase（`pending_delete | pending_create | synced | recovery`）和现在的餐食归属。一个 meal 最多一条非 `synced` generation。
- `meal_sync_points`：generation、`dish_key`（无 FK）、role（`delete_target | create_target`）、Google name、不可变 payload/hash、outbox 状态、attempt/lease/error/operation name、`recovery_requested_at`。它是保留旧远端 name 的唯一位置，不保存旧营养快照。

对已同步餐食再次点击同步时，在同一 DB 事务中：锁定 current meal、冻结 revision；从 `last_synced_generation_id` 的 create rows 复制 delete targets；为所有当前可写菜生成新的 `d-${uuid}` name 和不可变 payload；先把 generation 置为 `pending_delete`（没有旧点时直接 `pending_create`）。worker 只在本 generation 所有 delete target 成功后才 claim create target。所有 create 成功后原子地：将 generation 标为 `synced`，更新 `last_synced_generation_id`，删除上一已同步 generation 与本 generation 已完成 delete rows，保留本 generation create rows 作为下一次删除依据。

## 任务

### Task 1: 可编辑餐食和营养覆盖的领域契约

**Files:**
- Create: `src/domain/meal-editor.ts`
- Create: `tests/domain/meal-editor.test.ts`
- Modify: `src/domain/meal-vision.ts`（仅导出/复用必要的安全类型；不放编辑逻辑）

- [ ] **Step 1: 写失败测试。** 覆盖 `replace_ingredients` 必须有至少一个非空食材和正有限克数；`set_nutrient` 拒绝未知 dish、负数、NaN/Infinity、ENERGY 的非 `kcal` 单位，以及非 ENERGY 使用 `kcal`；并确认 schema 没有 `photo`、`vision`、token 字段。

- [ ] **Step 2: 运行失败测试。**

  Run: `pnpm test tests/domain/meal-editor.test.ts`

  Expected: FAIL，因为 `meal-editor.ts` 尚不存在。

- [ ] **Step 3: 实现最小 schema。** 建立 `editableIngredientSchema`、`editableDishSchema`、`editableNutrientSchema`、`mealEditActionSchema`、`mealDraftViewSchema` 和 `mealViewSchema`。把可编辑的能量保存在 `kcal`，其余统一内部克数并通过 unit conversion 辅助函数转换；为 API action 加上 `dishId` 和最大长度限制。

- [ ] **Step 4: 运行测试并检查类型。**

  Run: `pnpm test tests/domain/meal-editor.test.ts && pnpm lint`

  Expected: PASS，TypeScript 无错误。

- [ ] **Step 5: 提交。**

  ```bash
  git add src/domain/meal-editor.ts src/domain/meal-vision.ts tests/domain/meal-editor.test.ts
  git commit -m "feat: define editable meal contracts"
  ```

### Task 2: 明确克数的台湾 FDA 重算和初始草稿投影

**Files:**
- Modify: `src/server/nutrition/tw-fda.ts`
- Create: `src/server/meals/current-meal.ts`
- Create: `tests/server/current-meal.test.ts`
- Modify: `tests/server/tw-fda.test.ts`

- [ ] **Step 1: 写失败测试。** 用两种食材的不同比例验证 `resolveEditableTwFdaDishIngredients` 直接按传入 grams 缩放，不调用 `allocateIngredientGrams`；未命中食材保留为 ingredient 且对应营养为未知；`TW_FDA:*` 本地事实仍在结果中。再验证 vision 的 range 用中点和现有分配规则只生成初始 editor 值，之后 editor 永远只用明确克数。

- [ ] **Step 2: 运行失败测试。**

  Run: `pnpm test tests/server/tw-fda.test.ts tests/server/current-meal.test.ts`

  Expected: FAIL，新的 explicit-grams resolver 和草稿投影尚不存在。

- [ ] **Step 3: 实现最小计算层。** 在 `tw-fda.ts` 提取现有 `scaleFoodNutrients` 所需的共享逻辑，新增 `resolveEditableTwFdaDishIngredients({ nameZh, ingredients }, catalog)`；在 `current-meal.ts` 实现：
  - `draftFromVision`：生成 dish UUID、以 range 中点分配初始 grams、调用 local resolver 形成完整 nutrient list；
  - `replaceDishIngredients`：仅替换该 dish 的名字/ingredients/portion 和该 dish 的全量营养；
  - `setDishNutrient`：仅替换一个已有 nutrient；
  - `toGoogleNutritionInput`：只投影 Google 支持的当前字段，保留非 Google 微量元素于本地。

- [ ] **Step 4: 运行测试。**

  Run: `pnpm test tests/server/tw-fda.test.ts tests/server/current-meal.test.ts && pnpm lint`

  Expected: PASS；食材编辑覆盖全部当前营养，单项编辑只变一项。

- [ ] **Step 5: 提交。**

  ```bash
  git add src/server/nutrition/tw-fda.ts src/server/meals/current-meal.ts tests/server/tw-fda.test.ts tests/server/current-meal.test.ts
  git commit -m "feat: recalculate editable meals from local FDA facts"
  ```

### Task 3: 迁移与 current meal 存储接口

**Files:**
- Create: `db/migrations/009_mobile_meal_review.sql`
- Modify: `src/server/meals/types.ts`
- Modify: `src/server/auth/types.ts`
- Modify: `src/server/db/memory-store.ts`
- Create: `tests/server/current-meal-store.test.ts`

- [ ] **Step 1: 写失败的内存存储测试。** 测试草稿可写 editor/读到 editor 但不暴露 raw vision；保存草稿创建一个 current meal 并删除 draft；保存后的单项覆盖仅改变这一行；食材替换删除/插入该 dish 的 current nutrients 而不生成历史；每次有效保存编辑令 `contentRevision` 加一并回到 `unsynced`。

- [ ] **Step 2: 运行失败测试。**

  Run: `pnpm test tests/server/current-meal-store.test.ts`

  Expected: FAIL，因为 `AuthStore.currentMeals` 及其内存实现尚不存在。

- [ ] **Step 3: 写迁移和类型。** `009` 增加上述五组新表/索引/约束，明确 `meal_sync_points.dish_key` 没有 FK；`meal_drafts` 增加 nullable `editor`，以便存量草稿不被 migration 阻塞。向 `types.ts` 增加 current dish/nutrient、generation、point 与状态类型；向 `AuthStore` 新增：
  - `currentMeals.findDraft/updateDraft/saveDraft/find/update`；
  - `currentMealSync.startOrRequestRecovery`、claim/finish/retry/unknown/operation 状态转移与聚合状态读取。

- [ ] **Step 4: 实现内存事务语义。** 先 clone then commit `withTransaction`，让失败的保存/同步准备不会部分写入。给 `MemoryStore` 增加测试专用 `currentMealSnapshot()` 和 `currentMealSyncPoints()`，仅测试可用。

- [ ] **Step 5: 运行测试和迁移检查。**

  Run: `pnpm test tests/server/current-meal-store.test.ts && pnpm lint`

  Expected: PASS；不需要连接真实 PostgreSQL。

- [ ] **Step 6: 提交。**

  ```bash
  git add db/migrations/009_mobile_meal_review.sql src/server/meals/types.ts src/server/auth/types.ts src/server/db/memory-store.ts tests/server/current-meal-store.test.ts
  git commit -m "feat: persist current meal snapshots and sync generations"
  ```

### Task 4: PostgreSQL current meal 实现和事务边界

**Files:**
- Modify: `src/server/db/postgres-store.ts`
- Create: `tests/server/postgres-current-meal-store.test.ts`（若项目没有可用的 Postgres 测试容器，则仅保留 SQL mapping 的纯单元测试，并在本任务记录原因）
- Modify: `tests/server/current-meal-store.test.ts`

- [ ] **Step 1: 写失败测试。** 以 mock `Queryable` 或项目已有数据库测试方式验证 save 使用一笔 transaction：写 current children 后才删 draft；`find` 永远按 `user_id` 过滤；编辑时锁定 `current_meals` 行；`sync_points` 查询不 join/外键依赖可删除的 current dish。

- [ ] **Step 2: 运行失败测试。**

  Run: `pnpm test tests/server/postgres-current-meal-store.test.ts`

  Expected: FAIL，新的 store methods 未实现。

- [ ] **Step 3: 实现 PostgreSQL 映射。** 在 `storeFor(queryable)` 中实现 Task 3 的接口：
  - JSONB editor 用 Zod 解析后返回；
  - 保存/更新先获取 current meal `FOR UPDATE`，全量替换其当前 child rows；
  - 只在 mutation 实际改变数据时递增 revision；
  - generation start、point 插入、phase/state 完成在同一事务中，claim 使用 `FOR UPDATE SKIP LOCKED` 和 lease 比较。

- [ ] **Step 4: 运行存储测试和完整类型检查。**

  Run: `pnpm test tests/server/current-meal-store.test.ts tests/server/postgres-current-meal-store.test.ts && pnpm lint`

  Expected: PASS；每个查询带用户所有权过滤。

- [ ] **Step 5: 提交。**

  ```bash
  git add src/server/db/postgres-store.ts tests/server/current-meal-store.test.ts tests/server/postgres-current-meal-store.test.ts
  git commit -m "feat: store current meals in postgres"
  ```

### Task 5: AI suggestion 协议和无照片 DeepSeek client

**Files:**
- Create: `src/domain/meal-ai-suggestions.ts`
- Create: `src/server/meals/meal-assistant.ts`
- Modify: `src/server/meals/deepseek-vision.ts`
- Create: `tests/domain/meal-ai-suggestions.test.ts`
- Create: `tests/server/meal-assistant.test.ts`

- [ ] **Step 1: 写失败测试。** 验证 parser 仅接受 `replace_ingredients` 和 `set_nutrient`；拒绝未知 kind、非当前 `dishId`、未知 nutrient、错误 unit、非法数值、未命中 AI 食材；验证同一 dish 的两个 replacement 或 replacement + nutrient 标记为不可“应用全部”。验证 client payload 中没有 `photo`、`image_url`、`Authorization` token 或历史聊天。

- [ ] **Step 2: 运行失败测试。**

  Run: `pnpm test tests/domain/meal-ai-suggestions.test.ts tests/server/meal-assistant.test.ts`

  Expected: FAIL，因为 strict suggestion parser 与 assistant client 尚不存在。

- [ ] **Step 3: 实现 schema 与 assistant。** 使用 DeepSeek 已有 `DEEPSEEK_CHAT_URL` / API key，新增独立 `MealAssistantClient.complete({ apiKey, prompt, meal, question })`。它发送 `response_format: json_object` 的纯文本 messages（没有 image content），模型只能提出现有菜的两种 patch。服务器解析后逐条用当前 meal、营养 descriptors 和 local catalog 验证；任何不合法条目不返回、也不产生任何 mutation；完全无效则返回 `ai_response_invalid`。

- [ ] **Step 4: 运行测试。**

  Run: `pnpm test tests/domain/meal-ai-suggestions.test.ts tests/server/meal-assistant.test.ts && pnpm lint`

  Expected: PASS；不调用真实 DeepSeek。

- [ ] **Step 5: 提交。**

  ```bash
  git add src/domain/meal-ai-suggestions.ts src/server/meals/meal-assistant.ts src/server/meals/deepseek-vision.ts tests/domain/meal-ai-suggestions.test.ts tests/server/meal-assistant.test.ts
  git commit -m "feat: add validated photo-free meal AI suggestions"
  ```

### Task 6: 新版 HTTP handlers，废弃旧 confirm 写回路径

**Files:**
- Modify: `src/server/meals/http.ts`
- Modify: `app/api/meals/photo/route.ts`
- Modify: `app/api/meals/drafts/[id]/route.ts`
- Create: `app/api/meals/drafts/[id]/ai-suggestions/route.ts`
- Create: `app/api/meals/drafts/[id]/save/route.ts`
- Create: `app/api/meals/[id]/route.ts`
- Create: `app/api/meals/[id]/ai-suggestions/route.ts`
- Create: `app/api/meals/[id]/sync/route.ts`
- Modify: `app/api/meals/drafts/[id]/confirm/route.ts`
- Modify: `tests/server/meal-http.test.ts`
- Create: `tests/server/current-meal-http.test.ts`

- [ ] **Step 1: 写失败 HTTP 测试。** 覆盖：
  - `POST photo` 返回 editor/nutrients 且响应不含 base64/vision；
  - draft PATCH 的食材 action 会重算一菜全部营养，nutrient action 只改一个；
  - save 只创建本地 current meal，所有 legacy/new outbox 都为空；
  - saved PATCH 使 synced meal 变 unsynced；
  - 两个 AI route 只把当前结构发送给 mock assistant；
  - `POST sync` 无权限/无可写字段为 409 加 machine-readable reason，成功为 202；
  - 未认证 401、跨域写 403、他人资源 404、syncing/recovery 中 PATCH 409；
  - 旧 confirm route 返回 `410 { error: 'meal_confirm_replaced' }`，绝不入旧 outbox。

- [ ] **Step 2: 运行失败测试。**

  Run: `pnpm test tests/server/meal-http.test.ts tests/server/current-meal-http.test.ts`

  Expected: FAIL，因为新 handlers/routes 不存在且现有 confirm 仍会排队。

- [ ] **Step 3: 实现 handlers。** 保留 `checkPostOrigin` 和 session cookie 模式；photo 识别后用 Task 2 创建 `editor`、存 raw vision 仅供草稿期审计转换、返回 sanitized draft。将 PATCH action 经 Zod 后交给 `current-meal.ts` 和 store transaction。save 删除整个 draft 行；新增 saved-food/AI/sync handlers；旧 `handleMealConfirm` 与 route 只给 410。所有异常统一为既有 no-store JSON，不泄漏模型输出、payload 或 token。

- [ ] **Step 4: 运行 HTTP 测试和 lint。**

  Run: `pnpm test tests/server/meal-http.test.ts tests/server/current-meal-http.test.ts && pnpm lint`

  Expected: PASS；所有写 route 均有 origin 与 session 保护。

- [ ] **Step 5: 提交。**

  ```bash
  git add src/server/meals/http.ts app/api/meals tests/server/meal-http.test.ts tests/server/current-meal-http.test.ts
  git commit -m "feat: add explicit meal save and sync APIs"
  ```

### Task 7: Google batch delete client（不改变旧 create worker）

**Files:**
- Modify: `src/server/meals/nutrition-outbox.ts`
- Modify: `tests/server/nutrition-outbox.test.ts`
- Create: `tests/server/google-nutrition-batch-delete.test.ts`

- [ ] **Step 1: 写失败测试。** mock fetch 并断言 `batchDelete` 调用 `POST users/me/dataTypes/nutrition-log/dataPoints:batchDelete`，body 为 Google Health REST schema 要求的 `{ names: [...] }`，拥有 bearer token，非 2xx 抛 `GoogleNutritionWriteError`，404 的单点 GET 仍返回 undefined。再断言现有 `runNutritionOutbox` create 测试不变。

- [ ] **Step 2: 运行失败测试。**

  Run: `pnpm test tests/server/google-nutrition-batch-delete.test.ts tests/server/nutrition-outbox.test.ts`

  Expected: FAIL，因为 client 没有 `batchDelete`。

- [ ] **Step 3: 实现最小 client 扩展。** 只向 `GoogleNutritionOutboxClient` 加 `batchDelete(accessToken, pointNames, signal)`，复用现有超时/error class 与 operation 解析；不改 `runNutritionOutbox` 的状态机和返回契约。

- [ ] **Step 4: 运行测试。**

  Run: `pnpm test tests/server/google-nutrition-batch-delete.test.ts tests/server/nutrition-outbox.test.ts && pnpm lint`

  Expected: PASS；旧 worker 行为未回归。

- [ ] **Step 5: 提交。**

  ```bash
  git add src/server/meals/nutrition-outbox.ts tests/server/nutrition-outbox.test.ts tests/server/google-nutrition-batch-delete.test.ts
  git commit -m "feat: support Google nutrition batch delete"
  ```

### Task 8: generation 同步状态机与未知状态恢复

**Files:**
- Create: `src/server/meals/current-meal-sync.ts`
- Modify: `src/server/meals/google-nutrition.ts`
- Modify: `src/server/auth/types.ts`
- Modify: `src/server/db/memory-store.ts`
- Modify: `src/server/db/postgres-store.ts`
- Create: `tests/server/current-meal-sync.test.ts`

- [ ] **Step 1: 写失败的状态机测试。** 以 memory store/mock Google 覆盖以下不可退让行为：
  1. 首次显式同步只创建新 names/payload，worker 才调用 create；
  2. 已同步编辑后，新 generation 先一次 `batchDelete` 所有旧 names，尚未完成删除时 create 次数为 0；
  3. delete 完成后才逐一 create 新的 `d-*` names；全成功后 current state 为 synced 且只有当前 generation create names 被保留；
  4. create 或 delete 请求超时/异常后变 `unknown`，第二个普通 worker tick 不调用 POST；用户显式请求恢复只调用该名称 GET，create 必须 payload hash 完全匹配、delete 必须 GET 404 才可成功；
  5. 429/5xx 进入退避 retry，401/403 为 action-required；用户恢复 scope/开关/连接后，只有 generation 没有任何 unresolved unknown 才可显式重试，把 `failed_action_required` 还原为该行原来的已知状态（有 `google_operation_name` 为 `operation_pending`，否则按 generation phase 为 `write_pending`），并由正常 worker 恢复；混合 unknown/action-required 时本次重试只能 GET unknown；一个 generation 有任何 unknown 时编辑和新同步都被拒绝。
  6. 同一 generation 同时含 unknown 和 action-required 时，即使写回前提已恢复，重试也不将 action-required 改回 pending、mock Google 的 POST 次数保持为 0；直到 unknown 的 exact GET 成功后才允许恢复已知 operation。

- [ ] **Step 2: 运行失败测试。**

  Run: `pnpm test tests/server/current-meal-sync.test.ts`

  Expected: FAIL，因为新同步 worker 和 generation claim 接口不存在。

- [ ] **Step 3: 实现 generation 准备。** 在 `current-meal.ts` 用现有 `buildGoogleNutritionDataPoint` 的等价输入构造当前 dish payload/hash；在 store 的 `startOrRequestRecovery` 中事务性冻结 revision、复制 prior active names 作为 delete targets、给每个可写 current dish 分配一次性 `d-${randomUUID()}`，并将 create rows 保持为不可变。若没有可写字段，拒绝且不生成 generation。

- [ ] **Step 4: 实现 worker。** 在 `current-meal-sync.ts` 复用 `withLeaseSafeTimeout`、lease 时长、退避和 Google error 分类（必要时把这些纯辅助函数从 `nutrition-outbox.ts` 明确导出）：
  - 普通 claim 必须排除含任一 `unknown` point 的整个 generation；唯一例外是用户显式标记的 recovery claim，它只取得 unknown point 作 GET；
  - claim 一个 generation 的 delete rows；小于 10,000 个 name 一次 `batchDelete`，否则按 10,000 分块；
  - operation 未完成时只轮询 operation；operation 成功后才把该批 delete rows 标记 synced；
  - 所有 delete synced 时原子推进 generation 到 `pending_create`；
  - create 使用现有 exact-name hash 恢复规则；
  - unknown 永不自动 claim。`POST /sync` 的恢复分支仅为 unknown 设置 `recovery_requested_at`，worker 对这些 rows 只 GET，不能发 write；
  - `failed_action_required` 不是 unknown：endpoint 先检查本 generation 是否仍有 unknown；有则不改变任何 failed row，只排 unknown GET。没有 unknown 时再重新检查账户写回开关、connection、nutrition write scope；条件仍不满足则返回相同可读 reason，条件恢复后只把原 rows 重置为其已知的 `operation_pending`（已有 operation name）或当前 phase 的 `write_pending`，由普通 worker 恢复原请求；
  - 只有所有 create synced 才 finalise generation，清理上一 generation 与 delete targets。

- [ ] **Step 5: 运行状态机与旧 outbox 回归。**

  Run: `pnpm test tests/server/current-meal-sync.test.ts tests/server/nutrition-outbox.test.ts && pnpm lint`

  Expected: PASS；测试日志证明没有 unknown 后的第二次 POST。

- [ ] **Step 6: 提交。**

  ```bash
  git add src/server/meals/current-meal-sync.ts src/server/meals/google-nutrition.ts src/server/auth/types.ts src/server/db/memory-store.ts src/server/db/postgres-store.ts tests/server/current-meal-sync.test.ts
  git commit -m "feat: sync current meals with safe replacement generations"
  ```

### Task 9: 将新同步 worker 接入现有 Docker scheduler

**Files:**
- Modify: `src/server/meals/internal-nutrition-sync.ts`
- Modify: `app/api/internal/nutrition-sync/route.ts`（仅在需要扩展响应类型时）
- Modify: `worker/nutrition-loop.mjs`
- Modify: `tests/server/internal-nutrition-sync.test.ts`
- Modify: `tests/worker/nutrition-loop.test.ts`

- [ ] **Step 1: 写失败测试。** 验证内部 endpoint 仍需要 `SYNC_SECRET`；有 secret 时同一 token resolver 驱动 legacy `runNutritionOutbox` 和新版 `runCurrentMealSyncOutbox`；响应保留顶层 aggregate counts 并增加不含 payload 的 `{ legacy, currentMeals }` 明细；worker log 不输出 point name、payload、照片或 token。

- [ ] **Step 2: 运行失败测试。**

  Run: `pnpm test tests/server/internal-nutrition-sync.test.ts tests/worker/nutrition-loop.test.ts`

  Expected: FAIL，因为 endpoint 尚未调用新版 worker/没有新版计数。

- [ ] **Step 3: 实现最小接入。** 在旧 handler 成功鉴权后顺序运行 legacy 和 current worker，任一内部逻辑错误转换为受控 aggregate，而非让 scheduler 崩溃；顶部 counts 为两者之和，保留原有 worker log 格式。不要添加计时器、不要让没有用户点击的 meal 进入队列；worker 每分钟只能消费已显式创建的 generation。

- [ ] **Step 4: 运行测试。**

  Run: `pnpm test tests/server/internal-nutrition-sync.test.ts tests/worker/nutrition-loop.test.ts && pnpm lint`

  Expected: PASS；无 `SYNC_SECRET` 时继续零轮询。

- [ ] **Step 5: 提交。**

  ```bash
  git add src/server/meals/internal-nutrition-sync.ts app/api/internal/nutrition-sync/route.ts worker/nutrition-loop.mjs tests/server/internal-nutrition-sync.test.ts tests/worker/nutrition-loop.test.ts
  git commit -m "feat: run explicit meal sync generations in worker"
  ```

### Task 10: 手机编辑器的纯展示状态和营养分组

**Files:**
- Create: `src/ui/meals/nutrient-presentation.ts`
- Create: `tests/ui/nutrient-presentation.test.ts`

- [ ] **Step 1: 写失败测试。** 对输入的 complete nutrient list，断言固定分为“能量与宏量、维生素、矿物质、其他本地已知成分”；前两组不会虚构未知 0；`TW_FDA:维生素样字段` 有可读中文 fallback；ENERGY 为 kcal、其余按明确 g/mg/μg 显示；AI “应用全部”在 Task 5 的两种冲突情形返回 disabled reason。

- [ ] **Step 2: 运行失败测试。**

  Run: `pnpm test tests/ui/nutrient-presentation.test.ts`

  Expected: FAIL，因为展示辅助函数尚不存在。

- [ ] **Step 3: 实现纯辅助函数。** 不把 fetch、React state 或营养计算放进此文件；只输出排序/分组/标签/unit/格式化/冲突提示所需的稳定数据。

- [ ] **Step 4: 运行测试。**

  Run: `pnpm test tests/ui/nutrient-presentation.test.ts && pnpm lint`

  Expected: PASS。

- [ ] **Step 5: 提交。**

  ```bash
  git add src/ui/meals/nutrient-presentation.ts tests/ui/nutrient-presentation.test.ts
  git commit -m "feat: present complete meal nutrients by fixed groups"
  ```

### Task 11: 手机优先的上传、编辑和 AI 审阅界面

**Files:**
- Create: `app/meals/new/page.tsx`
- Create: `app/meals/[id]/page.tsx`
- Create: `src/ui/meals/mobile-meal-editor.tsx`
- Create: `src/ui/meals/meal-editor.module.css`
- Create: `tests/ui/mobile-meal-editor.test.tsx`
- Modify: `src/ui/dashboard/today-dashboard.tsx`

- [ ] **Step 1: 写失败的 UI/状态测试。** 用 React server rendering 或纯 event-state helpers 断言：新页有一张照片选择、AI 发送同意 checkbox、固定“保存修改/同步这一餐”操作栏；没有营养搜索；草稿只显示保存；保存后显示同步；营养行打开 editor sheet；AI 不存在“自动应用”；使用 native history 更新已保存 meal URL 时本地 `messages` state 保持、刷新入口则从服务器加载且 messages 为空。

- [ ] **Step 2: 运行失败测试。**

  Run: `pnpm test tests/ui/mobile-meal-editor.test.tsx`

  Expected: FAIL，因为 editor component 尚不存在。

- [ ] **Step 3: 实现页面和 component。**
  - `new` 页面渲染上传态；照片预览用 `URL.createObjectURL`，在 file 替换/unmount 时 revoke，不写 localStorage/sessionStorage；
  - `POST photo` 后在同一个 `MobileMealEditor` 中进入 draft；食材编辑走全屏 sheet，单营养编辑走底部 sheet；每次成功 PATCH 用服务器返回的整份 editor 替换 client state；
  - AI sheet 在当前 React state 保存 `messages`，每次发问只调用当前 draft/meal endpoint，建议只能调用同一个 PATCH action 来应用；显示逐条应用/忽略与“应用全部”的冲突禁用说明；
  - save 成功后在不卸载 component 的情况下用 `window.history.replaceState` 改为 `/rhythm/meals/:id`，保留当前 session 的 messages；直接加载 `[id]` 页面从 GET 开始且 messages 为空；
  - saved meal 顶栏显示 `unsynced/syncing/synced/recovery`；`syncing` 禁用编辑和同步，`recovery` 禁用编辑但把第二个固定动作替换为“重试这一餐”：存在 unknown 时只触发精确 GET；全部 unknown 解除后，action-required 才先显示重新授权/开启写回原因并在前提恢复后恢复原 pending operation；对 `canSync=false` 显示服务器 reason；
  - dashboard 加可发现的 `记录餐食` 链接到 `/rhythm/meals/new`。

- [ ] **Step 4: 实现手机 CSS。** 默认单列、最小宽 320 px、触达区至少 44 px、内容末尾 padding 大于 fixed action bar；能量与宏量默认展开，其他三组折叠并显示已知项数量；宽度 ≥ 768 px 用两栏将 AI 固定右侧。使用语义 button/label/dialog、`aria-expanded` 和可见 focus，且不增加图标库。

- [ ] **Step 5: 运行 UI、类型和 production build。**

  Run: `pnpm test tests/ui/mobile-meal-editor.test.tsx tests/ui/nutrient-presentation.test.ts && pnpm lint && pnpm build`

  Expected: PASS；Next 生产构建成功。

- [ ] **Step 6: 手工浏览器验收。** 在 320 px、390 px、768 px 宽度分别验证上传→编辑食材→改单项营养→问 AI（不应用/应用）→保存→同步按钮状态；刷新已保存 URL 后确认没有预览/聊天消息；打开 DevTools Network 确认保存过程没有 Google 请求，只有显式同步创建 generation。

- [ ] **Step 7: 提交。**

  ```bash
  git add app/meals src/ui/meals src/ui/dashboard/today-dashboard.tsx tests/ui/mobile-meal-editor.test.tsx
  git commit -m "feat: add mobile meal review interface"
  ```

### Task 12: 端到端回归、隐私检查和交付说明

**Files:**
- Modify: `README.md`（仅补充本地使用流程、显式同步和不持久化边界；不写 secret）
- Modify: `docs/superpowers/specs/2026-08-26-mobile-meal-review-and-sync-design.md`（仅把状态更新为已实现，列出已验证的非功能约束）
- Create: `tests/server/mobile-meal-regression.test.ts`

- [ ] **Step 1: 写失败回归测试。** 串联 mock vision/catalog/assistant/store/google，覆盖“照片草稿 → 食材重算 → 单项覆盖 → 保存（零写任务）→ 显式同步 → 编辑 → delete 再 create”；断言当前餐食读取不含 `vision`、图片、历史或聊天，AI 调用不含照片/token，unknown 后 no second POST。

- [ ] **Step 2: 运行失败测试。**

  Run: `pnpm test tests/server/mobile-meal-regression.test.ts`

  Expected: FAIL，直到所有层完成并正确接线。

- [ ] **Step 3: 修复最小集成问题。** 只修复回归测试暴露的契约偏差；不趁此任务迁移旧 version/outbox 数据、添加批量同步、保存照片或新增营养目标功能。

- [ ] **Step 4: 运行完整验证。**

  Run: `pnpm test && pnpm lint && pnpm build`

  Expected: 全绿；测试不访问真实 DeepSeek 或 Google。

- [ ] **Step 5: 审查工作区和文档。**

  Run: `git diff --check && git status --short`

  Expected: 无空白错误；仅本功能的预期文件处于变更状态。

- [ ] **Step 6: 更新简短文档并提交。**

  ```bash
  git add README.md docs/superpowers/specs/2026-08-26-mobile-meal-review-and-sync-design.md tests/server/mobile-meal-regression.test.ts
  git commit -m "test: verify mobile meal review flow"
  ```

## 最终验收清单

- [ ] 在 320–430 px 手机上能上传、看全量营养、编辑食材/克数、编辑任一当前营养、保存并显式同步一餐。
- [ ] 改食材只重算目标菜的全部当前营养；改单项只覆盖这一项；不保留原始/修正历史。
- [ ] AI 只返回验证后的 suggestion，用户可继续当前页面会话的对话但刷新不恢复消息，保存后 AI 不接收原照片。
- [ ] 微量元素本地完整保存；Google 支持的字段写回，其他字段不伪造为 0、也不阻止本地保存。
- [ ] 保存不请求 Google；首次同步只 create；后续同步严格全 delete 成功后才 create；未知状态只 exact GET 恢复。
- [ ] 已确认的 401/403 不被误作 unknown：用户恢复授权或写回前提后，可从原有已知 pending operation 安全继续。
- [ ] 混合 unknown/action-required generation 始终以 unknown 为先：在所有 unknown 经精确 GET 解除前，不恢复任何 POST。
- [ ] 不持久化照片、data URL、已保存餐食的原始 vision、AI suggestions/messages 或 OAuth token；日志和 API 响应不泄露 payload。
