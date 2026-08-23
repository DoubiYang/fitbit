# 节律

面向 Fitbit Air 用户的中文健康数据仪表盘与自助 AI 教练。

当前分支实现一期的本地演示基础：PWA 壳、透明指标计算和“今日”视图。它不会读取 Google Health，也不会调用 DeepSeek；真实服务在凭证、测试账号和合规前置完成后才会启用。

## 本地运行

需要 Node.js 25 与 pnpm 11。

```bash
pnpm install
pnpm dev
```

## 校验

```bash
pnpm test
pnpm lint
pnpm build
```

仅复制 `.env.example` 为 `.env.local` 后填写后续集成所需变量；不要把任何真实凭证写入 Git。
