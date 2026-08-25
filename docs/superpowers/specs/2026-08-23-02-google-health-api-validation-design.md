# Google Health API v4 接入与验证设计

**状态：** 草案，待用户审阅
**日期：** 2026-08-23
**对应工作项：** 2. 验证 Google Health API 的授权、拉数、写回和多用户审批

> **实现状态更新（2026-08-25）：** OAuth、10 个固定首次 scope、账户隔离，以及授权后单用户最近 14 天的睡眠 / 每日 HRV / 每日静息心率 / 训练热同步已实现。本文其余的冷同步、webhook、营养写回、拍照记餐和 AI Coach 是后续验证与实现目标，不能视为已交付能力；现行同步边界以 [真实数据同步整改设计](2026-08-25-sync-remediation-design.md) 为准。

## 1. 目标

在开始产品开发前，证明系统可以在多用户场景下安全地：

1. 让用户用 Google/Fitbit 账号完成授权；
2. 拉取一期所需的原始健康和活动数据；
3. 读取、删除并以新版本替代由本产品创建的匿名餐食记录；
4. 知道哪些数据因权限、地区、设备或 API 限制而不可用。

本期唯一的服务端数据通道是 **Google Health API v4**（`https://health.googleapis.com/v4`）。它是 Fitbit Web API 的下一代 API，而不是只改名称：OAuth、scope、端点、用户 ID 和 webhook 都已变化。旧 `api.fitbit.com` 仅可作为迁移资料，不可作为一期实现或验收环境，因为其公开弃用日期为 2026 年 9 月。

Health Connect 是 Android 本机数据层，不作为一期核心依赖；仅在后续需要接入非 Fitbit 设备时评估。

## 2. 已知边界

| 项目 | 设计结论 |
| --- | --- |
| Google 私有分数 | 公开 API 不提供 Readiness、Sleep Score、Cardio Load 或 Target Load；本产品只使用原始数据。 |
| 多用户分钟级数据 | 不沿用旧 Fitbit Web API 的 intraday 审批假设。v4 以数据类型和 Google OAuth scope 授权；实际可用粒度仍须以 Fitbit Air 测试账号验证，且不把分钟级心率作为一期上线前提。 |
| Health Connect | 是 Android 设备侧 SDK；无法替代服务端的多用户 OAuth 数据管道。 |
| 旧 API 迁移 | 旧 token 不可转移到 v4；新用户直接使用 Google OAuth，若将来迁移旧用户，必须要求重新授权并保存 `healthUserId` 映射。 |
| 营养写回 | v4 的 `nutrition-log` 支持创建、查询和批量删除。照片生成的匿名 food log 不可更新，编辑必须删除旧记录后创建新记录。 |
| 地区能力 | Google Health Coach 的地区限制不应影响本产品的数据管道，但实际 OAuth、设备数据和 API 可用性必须用测试账号验证。 |

## 3. 授权范围、同意与数据流

### Scope 集合

首次 Google 授权的完整 scope 列表以 [OAuth 与账户设计](2026-08-24-05-oauth-account-docker-design.md) 为准：一次请求 Google Health **全部现行只读数据 scope**（睡眠、生命体征、活动、营养读、档案、设置、运动 GPS、ECG、心律不齐）以及一期写回所需的 `nutrition.writeonly`。不再把营养权限留到第二次 Google 同意页——后续补 scope 会再次打断用户，且测试模式 refresh token 只有 7 天。

仪表盘核心读权限仍是：

- `googlehealth.sleep.readonly`：睡眠会话与阶段；
- `googlehealth.health_metrics_and_measurements.readonly`：HRV、RHR、心率及可用生命体征；
- `googlehealth.activity_and_fitness.readonly`：训练会话、步数与活动/心率区间上下文。

用户拒绝部分 scope 时按部分同意降级：核心三项缺失则仪表盘数据不完整；仅缺营养写时连接仍为部分授权，当前仪表盘热同步继续可用，但未来 Google Health 写回必须停用。

**Google 已授予 `nutrition.writeonly` 不等于可以写回。** 必须等用户在产品内打开“写回 Google Health”并确认该次餐食后，才创建或删除 `nutrition-log`。每个写回功能在开关与确认 UI 上说明用途；应用内拒绝写回时不得调用写接口。不申请睡眠/运动/档案等产品不会使用的 writeonly。

### 敏感数据与第三方模型

健康指标、健康记录和餐食图片均按敏感个人信息处理。授权页面与拍照页分开获得以下可撤回同意，并记录版本、时间和用途：

1. Google Health 数据同步与自建指标；
2. 将单张餐食图片发送给 DeepSeek 仅用于识别候选；
3. 将最小化的指标证据摘要发送给 AI 教练仅用于生成当前会话回答；
4. 将已确认餐食写回 Google Health。

任何一项被拒绝时，不暗中降级为传输：拍照记餐改为手动录入，AI 教练仅显示本地规则或不可用提示，写回开关关闭。上线前须形成数据流清单（接收方、字段、目的、保存期限、地域、删除方式）、供应商协议与删除/导出响应流程；该清单需要隐私和合规审阅，不以本设计替代法律意见。

## 4. 目标架构

```text
用户浏览器
  └─ Google OAuth 授权 ─→ 产品后端 ─→ Google Health API v4
                         │
                         ├─ 加密保存 refresh token
                         ├─ healthUserId / OAuth scope / 同意版本
                         ├─ 原始数据与来源记录
                         ├─ 标准化日数据 / 自建指标
                         ├─ webhook 验签与增量拉取（后续）
                         └─ 已确认餐食写回（后续）
```

访问令牌与 refresh token 只保存于后端，不进入浏览器、前端日志或 AI 上下文。每个用户的 API 凭证、原始记录、派生数据和删除任务必须按用户 ID 严格隔离。模型调用只接收本次功能最少字段，永不接收 refresh token、完整原始健康 JSON 或其他用户的数据。

## 5. 一期数据清单

### 必需数据

| 域 | 用途 | 最低可接受粒度 |
| --- | --- | --- |
| 睡眠日志与阶段 | 睡眠完整度、规律性、睡眠债 | `sleep` 会话、阶段与睡眠汇总 |
| HRV、静息心率 | 恢复信号的个人基线和偏离 | `daily-heart-rate-variability`、`daily-resting-heart-rate` 每日值 |
| 心率与训练/活动 | 训练负荷、训练会话解释 | 优先 `exercise.metricsSummary.heartRateZoneDurations` 或 `time-in-heart-rate-zone`；原始 `heart-rate` 仅作增强 |
| 步数、距离、热量 | 日常活动上下文 | 每日汇总 |
| 呼吸率、SpO₂、皮温 | 仅作趋势补充与异常说明 | 每日/夜间汇总，缺失可降级 |
| 食物日志 | 支持本产品写回、删除和营养上下文 | `nutrition-log` 数据点与其 `name` |

### 数据来源规则

- 保存每条数据的 v4 `dataPoint.name`、数据源、开始/结束时间、civil time 与 UTC offset、抓取时间和原始负载哈希。
- 同一餐食写回使用客户端生成的、符合 v4 格式的 data point ID 作为幂等键；每个 ID 映射唯一的本地餐食版本。只有在验证证明该 ID 对 `nutrition-log` 可检索且创建语义稳定后才启用自动恢复。
- 后续原始层保留 `list` 结果；展示与指标计算优先使用同一时间窗口的 `reconcile` 结果。当前热同步显式限定 `google-wearables`，请求失败不降级为其他来源或空成功。未来若引入来源回退，必须在 UI 展示来源，且不得覆盖原始记录。

## 6. 同步生命周期

1. **授权与 identity（已实现）：** 显示固定 10 个 scope 的用途后进入 Google OAuth；调用 `getIdentity` 获取并保存 `healthUserId`，不把邮箱当作健康数据主键。
2. **热同步（已实现）：** 授权完成后仅为该用户尝试拉取最近 14 天的睡眠、HRV、RHR 与训练；失败不覆盖旧快照，首页只读最后成功快照。
3. **冷同步（后续）：** 按数据类型的日期范围和分页限制分块回填最近 90 天。睡眠和训练每页最多 25 条，必须消费 `nextPageToken`；任务可暂停、恢复、重放且显示进度。
4. **增量同步（后续）：** 为睡眠、每日 HRV、每日 RHR、训练和 nutrition-log 配置 v4 HTTPS webhook；验证签名/共享密钥后按通知时间窗拉取。日轮询仅作 webhook 遗漏、延迟或初期验证的兜底。
5. **标准化（部分实现）：** 当前实现保守映射睡眠、每日 HRV/RHR 与训练；完整原始层、来源审计与可更新日汇总层仍待实现。
6. **断开与删除（部分实现）：** 当前断开会撤销本地连接、删除本地快照并尽力撤销 Google token；webhook/订阅、原始/派生数据的选择删除与完成审计仍待实现。

## 7. 营养写回规则

只有满足以下条件才写回：

- 用户已确认餐食名称、时间、份量和估算营养；
- 用户已启用 nutrition 的读写授权和该次写回同意；
- 系统已检查该餐食版本对应的 client data point ID 是否已成功写入；
- v4 `create` 返回的异步 Operation 已完成，且持久化 `nutrition-log` 的 data point `name`。

一期照片餐食统一按匿名 `nutrition-log` 写入，因为 Google Health 的 Food 数据库不可创建或修改，且中餐覆盖不能假定完整。匿名 log 不可 PATCH：用户编辑时先在本产品创建新的餐食版本，随后在 Google Health **删除旧 data point、创建新 data point**。只有两步均确认后才标记“已同步”；删除成功、创建失败时显示“Google Health 餐食已移除，正在恢复”，不可声称仍已同步。

用户删除时只对本产品写入的 `dataPoint.name` 调用 `batchDelete`。同一用户手动在 Google Health 录入的餐食绝不自动合并、改写或删除。

### 幂等性与不确定响应恢复

提交前先创建不可变的本地 `food_write_operation`，其字段至少包括：`operation_id`、`user_id`、`local_food_entry_version_id`、规范化请求负载哈希、client data point ID、状态、请求时间、尝试次数、Operation 名称和 `provider_data_point_name`。同一餐食版本在该表中唯一，状态机为：

`prepared → create_submitted → operation_pending → confirmed | unknown | failed`

- `create` 成功只代表 Operation 被接受；轮询 Operation 至终态，再保存其 `provider_data_point_name` 并标记 `confirmed`。对未完成 Operation 不得发第二次创建。
- 超时、连接中断或响应无法解析时，状态变为 `unknown`。先以 client data point ID 调用 v4 `get`；找到同名记录即映射为 `confirmed`。找不到时，保留 `unknown` 并提示用户，不按时间和营养值模糊匹配、更不创建第二条。
- 仅当 v4 验证确认“同一个 client data point ID + 同一负载”的 create 可安全重放时，才允许自动重试；否则一期宁可出现“待确认同步”，也不以重复餐食换取表面成功率。该结论须通过正常返回、超时、Operation 延迟、用户双击和网络重连五个用例证明。
- 同一用户的手动 Google Health 餐食与本产品来源不自动合并或删除；界面只标示潜在重复来源。

## 8. 验证计划与退出条件

### 验证顺序

1. 注册 Google Health API v4 应用、配置 OAuth consent screen、HTTPS redirect URI、隐私政策和 webhook endpoint；
2. 验证首次固定 10 个 scope、refresh token、`getIdentity` 与用户拒绝部分 scope 的降级；
3. 验证热同步、90 天冷同步、分页、webhook 验签、漏通知日轮询与幂等重放；
4. 验证 sleep、daily HRV、daily RHR、exercise、心率区间和 nutrition-log 的实际字段、来源与 Fitbit Air 覆盖；
5. 用匿名 nutrition-log 验证创建、读取、删除后重建、删除、Operation 延迟及五种未知响应用例；
6. 以两到三位不同设备/地区的同意测试用户重复验证，并完成数据流、删除和供应商同意的隐私审阅。

### 通过标准

- 授权、刷新、部分拒绝、撤销与 webhook 删除均可完整跑通；
- 最小数据集可稳定获得，且每项的 scope、字段覆盖、页数、延迟与数据源被记录；
- 匿名照片餐食可准确创建、编辑（删除后重建）、删除且不重复；
- 对网络超时的写入会进入 `unknown` 并按同一 client data point ID 恢复或提示人工处理，不产生盲目重试；
- 不依赖原始分钟级心率也能生成一期训练负荷；
- 数据流、删除、模型传输同意、风险与必要审核有书面证据。

## 9. 风险与应对

| 风险 | 应对 |
| --- | --- |
| 旧 Fitbit API 在一期期间弃用 | 不在一期接入旧端点；所有验证和 provider adapter 以 Google Health API v4 为准。 |
| Fitbit Air 字段覆盖不足 | 以 exercise 心率区间/会话优先，原始分钟心率仅增强；缺失时生成低质量负荷或不生成。 |
| 设备未同步或字段缺失 | 显示数据新鲜度，降低指标置信度，不生成强结论。 |
| 匿名 food log 不可编辑 | 本产品中每次编辑形成新版本，Google Health 侧执行删除后重建，并显示中间失败状态。 |
| 第三方与本产品重复写餐食 | 使用 client data point ID、单一写回路径和来源标示，不按营养值推断合并。 |
| API 规格变化 | 以 provider adapter 封装 API，保留原始响应并增加契约测试。 |
| 用户撤回同意 | 立即阻断同步与 AI 数据检索，完成可审计的删除流程。 |
| 模型/跨境数据传输不被同意 | 不发送图片或健康摘要；保留手动记餐和非 AI 仪表盘路径。 |

## 10. 研究依据

- Google Health API v4：迁移、OAuth scope、data types、data point、nutrition、webhook 与用户数据政策。
- Google OAuth：敏感/受限 scope、增量授权、生产验证与删除要求。
- 中国个人信息保护法及数据出境相关要求；由合规人员在上线前审阅实际数据流。
- Android Health Connect 文档：设备侧权限、历史读取与记录模型。

上线实现前需重新核对这些官方资料的版本与实际 API 响应。
