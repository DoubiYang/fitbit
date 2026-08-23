# 节律

面向 Fitbit Air 用户的中文健康数据仪表盘与自助 AI 教练。

当前分支实现一期的本地演示基础：PWA 壳、透明指标计算和“今日”视图。它不会读取 Google Health，也不会调用 DeepSeek；真实服务在凭证、测试账号和合规前置完成后才会启用。

演示模式只使用服务器固定的 `demo_user` 和确定性样本，不能通过浏览器传入其他人的用户 ID；其目的是先确认数据隔离、指标和展示边界。完整实现说明见 [P1 Foundation](docs/implementation/p1-foundation.md)。

## 本地运行

需要 Node.js 25 与 pnpm 11。

```bash
pnpm install --frozen-lockfile
pnpm dev
```

## 校验

```bash
pnpm test
pnpm lint
pnpm build
```

仅复制 `.env.example` 为 `.env.local` 后填写后续集成所需变量；不要把任何真实凭证写入 Git。演示模式不读取这些变量。
