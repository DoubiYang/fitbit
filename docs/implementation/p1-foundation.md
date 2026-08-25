# P1 Foundation 本地演示实现（历史切片）

最后更新：2026-08-25

> 本文记录 2026-08-23 的演示纵切。随后已增加 Google OAuth、多用户服务器会话、PostgreSQL 加密 token 存储，以及授权完成后仅同步该用户最近 14 天的核心数据。现行真实同步行为以 [整改设计](../superpowers/specs/2026-08-25-sync-remediation-design.md) 为准；不要把本文的“未实现”清单理解为当前仓库状态。

## 这次实现了什么

这是一条可在本地运行的、移动端优先的 PWA 纵切。它用一个服务器控制的演示用户把规范化健康记录计算为三个自有指标，并渲染带依据与质量标识的“今日”视图。

- 首页 `GET /`：服务端按请求构建并展示今日建议、恢复信号、睡眠完整度、训练负荷、数据新鲜度。
- 数据端点 `GET /api/today`：返回同一份、无缓存的 `TodayView`；不返回原始健康记录、来源记录 ID 或凭证。
- 指标：睡眠完整度、恢复信号、训练负荷/近期负荷比均由纯函数计算，并带 `p1-v1` 指标版本、校准与低质量状态。
- 数据边界：每一条记录都要带 `userId` 和来源身份；Provider 的每个查询都必须接收服务端解析出的用户 ID；演示 Provider 只为 `demo_user` 返回复制后的样本。
- PWA：包含中文 manifest、安装图标和响应式仪表盘；小屏上三张指标卡会变为单列。

## 当前没有实现的内容

这仍不是完整可上线的 Google Health 或 AI Coach 集成。以下能力留在后续切片中：

- 历史回填、webhook、持续增量同步、原始记录的删除和完整重算。
- Fitbit Air 多账号、跨地区的真实字段可用性验证，以及任何写回能力。
- 拍照识别餐食、营养确认、匿名营养日志的写回状态机。
- DeepSeek-V4-Flash-Vision-Exp 或其他视觉/教练模型的实际调用、评测、提示词安全策略和隐私审查。
- 医疗建议、疾病诊断、自动增训或自动写入用户健康记录。

当前 `GoogleHealthProvider` 仅在安全配置完整、连接仍有效并由授权完成的单用户同步任务调用时访问 Google Health；它固定为 `google-wearables` 来源，任何请求或保存失败均 fail closed，保留旧快照。仪表盘页面从不直接访问 Google。

## 数据与隐私边界

浏览器不选择健康数据所属用户，也不能提供 `userId`。当前用户从 `src/server/session/current-user.ts` 的服务器会话边界取得：演示模式固定为 `demo_user`，OAuth 模式为服务器 session 对应的内部用户 ID。不得接受 URL 参数、请求体或客户端存储提供的健康用户 ID。

页面只消费 `TodayView`，而非记录明细。建议最多附三条含日期的指标依据；数据校准中、过期或不足时，界面显示数据状态而不是训练处方。

环境变量名称见 `.env.example`。它们只能放在未提交的 `.env.local` 或部署平台密钥管理中；日志、测试样本和 Git 历史中不得出现 token、OAuth secret、真实健康记录或真实餐食照片。

## 本地运行与验证

需要 Node.js 25 和 pnpm 11。

```bash
pnpm install --frozen-lockfile
pnpm dev
```

运行质量检查：

```bash
pnpm test
pnpm lint
pnpm build
```

`pnpm test` 使用 Node 测试运行器；在某些受限沙箱中，`tsx` 创建本机 IPC 管道会失败，需在允许本机 IPC 的环境中执行。

## 下一步的外部前置

继续 Google Health 接入前，需要用 Fitbit Air 测试账号验证真实字段、数据保存期限与删除策略、加密密钥托管和隐私审查。开始拍照记餐前，还需要确定营养数据源、人工确认交互、Google 匿名营养日志写回/删除重建策略，以及视觉模型供应商的数据处理条款和离线评测集。
