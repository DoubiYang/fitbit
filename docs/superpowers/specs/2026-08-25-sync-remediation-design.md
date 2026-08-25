# 真实数据同步整改设计

**状态：** 已完成，待提交  
**日期：** 2026-08-25  
**范围：** 修正已实现的 OAuth、Google Health 同步与仪表盘数据边界；不把拍照记餐、营养写回、AI Coach 或 webhook 伪装为本次已完成。

## 1. 目标与非目标

本整改使 Fitbit Air 用户的首次真实数据同步在失败、断开、并发和缺失数据时保持诚实：不覆盖旧快照、不伪造新鲜度、不混入非 wearable 来源，也不把未知数据当成睡眠或休息日。

本次不新增照片上传、DeepSeek 调用、餐食确认、`nutrition-log` 写回状态机、AI Coach、行为实验、周报或 webhook。它们仍是一期产品范围中的独立工作项，必须另有数据同意、接口验证和验收测试。

## 2. 已记录问题与完成清单

- [x] **P0 快照完整性：** 单个数据类型请求、token 刷新或快照持久化失败时，不覆盖已有快照，也不更新 `last_successful_sync_at`。已由 Provider 回归测试覆盖。
- [x] **P1 用户范围：** OAuth 回调只同步刚完成授权的用户；移除全用户 callback 同步和 15 分钟批量 cron。已由 OAuth callback 与单用户同步回归测试覆盖。
- [x] **P1 数据来源：** 读取时显式限定 `google-wearables` 数据源族；不再把 all-sources 的结果称为 Fitbit Air 数据。已覆盖请求参数与限流错误语义。
- [x] **P1 断开删除：** 断开事务同时删除本地健康快照；旧同步在断开后不得重新写回；若 access token 刷新在飞行中，条件更新也不得将断开的凭证写回。已覆盖事务删除、同步中断开与刷新中断开场景。
- [x] **P1 睡眠语义：** 没有 API 实际睡眠分钟时不生成睡眠记录；使用 API 的 `metadata.nap` 与 `metadata.processed`。已由映射回归测试覆盖。
- [x] **P1 训练完整日：** 仅在 exercise 查询成功覆盖的日期补确认零负荷；存在无法计算负荷的训练会话时保留未知状态。已由零负荷与未知会话测试覆盖。
- [x] **P1 授权契约：** 经产品确认，首次 OAuth 固定请求 10 个 scope（9 个只读 + `nutrition.writeonly`），以覆盖完整仪表盘、AI Coach 和未来经确认的餐食写回；授权 URL 测试以显式 10 项列表锁定该契约。当前热同步只读取四类核心数据，营养写入仍未实现且不会调用写接口。
- [x] **P1 敏感数据边界：** 移除会解密 token 并向终端输出原始 Health data point 的临时 probe 脚本；交付代码不输出凭证或原始健康记录。
- [x] **文档一致性：** README、账户页、OAuth/Health 设计和原 P1 foundation 文档同步反映当前能力与未完成项。
- [x] **验证：** 每个行为先有失败测试，修复后通过针对性与全量测试、类型检查、生产构建和 Compose 配置检查。

## 3. 设计决定

### 3.1 快照是完整版本，不是错误的部分成功

当前 `health_snapshots.records` 是一个单一 JSON 快照，无法表达每个数据类型的成功水位。因此一次同步必须在四类核心输入（sleep、daily HRV、daily RHR、exercise）都成功查询且快照成功写入后，才更新连接的成功时间。任一失败保留旧快照和旧成功时间，并让同步任务失败。

以后若需要部分成功，必须先把快照重构为按数据类型版本、日期覆盖范围和错误状态存储；不能重新引入“失败即空数组”。

### 3.2 同步由当前用户触发

OAuth callback 返回内部 `userId`，运行时只为该用户执行最近 14 天热同步。删除全局内部 cron endpoint 和 `sync` Compose 服务；后续日常刷新应通过已登录用户的显式同步动作或独立、可观察的每用户作业实现，而不是扫描所有 token。

### 3.3 来源、断开与并发围栏

查询显式传 `dataSourceFamily=users/me/dataSourceFamilies/google-wearables`。保存快照与刷新后的 token 写入均在 SQL 中要求连接仍为 `active` 或 `partial`；断开事务先将连接置为 `disconnected` 并删除快照。因此已在飞行中的同步在断开后无法重新插入健康数据或复活凭证。

### 3.4 缺失数据的保守映射

`minutesAsleep` 只能来自 Google 的 sleep summary；卧床区间不是睡眠时长。睡眠的 nap 和处理完成状态使用 API metadata。exercise 查询成功覆盖的无会话日期才记为零负荷；有无法计算的会话的日期是 `unknown`，不参与训练负荷比。

### 3.5 权限与文档

首次 OAuth 保持用户确认的 10 个固定 scope：睡眠、生命体征、活动、营养读写、档案、设置、位置、ECG 与 IRN。三个核心 readonly scope 是当前热同步的最小读取集，但不是产品的首次授权集。`nutrition.writeonly` 仅为未来经用户确认的餐食写回预先授权；当前代码不写入 Google Health。新增实际读取或写入行为时，必须更新用途说明、隐私评审与回归测试。

## 4. 验收标准

1. 任一 Health API 请求或快照写入失败后，旧快照和 `lastSuccessfulSyncAt` 均保持不变。
2. OAuth callback 只调用目标用户的同步函数；Compose 不含全用户定时同步服务。
3. Health API 请求包含 wearable 数据源族；401/403/429/5xx 不降级为 list 查询或空成功。
4. 断开后快照不存在；同步若在断开后完成也不能重建快照，飞行中的 token 刷新也不能复活凭证。
5. 缺 summary、nap 或未处理 sleep 不会产生虚假的恢复/睡眠输入；已确认无训练日可贡献零负荷，未知训练日不可以。
6. 新授权 URL 严格包含产品确认的 10 个 scope；当前热同步仅访问四类核心数据，且不调用营养写接口。
7. 文档不再声称已完成不存在的餐食、写回、AI Coach、webhook 或全量一期功能。
8. 交付内容不含会解密凭证或打印原始健康记录的调试脚本。

## 5. 验证记录

- `pnpm test`：76/76 通过（包含快照原子性、单用户 14 天范围、wearable 来源、断开/刷新竞争、睡眠与训练映射、固定 10-scope OAuth URL）。
- `pnpm lint`：通过（`tsc --noEmit`）。
- `pnpm build`：通过（Next.js 生产构建）。
- `docker compose --env-file .env.example config --quiet`：通过；同时修复了 app healthcheck 的意外 `done` 续行，使 `start_period` 成为有效 duration。
