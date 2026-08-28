# 柔和绿色健康日记全站视觉重设计 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不改变健康计算、OAuth、餐食持久化或 Google 写回状态机的前提下，把节律的全部可见网页重构为以用户确认的暖白、鼠尾草绿、摄影优先餐食体验为核心的手机优先界面。

**Architecture:** 新建轻量、服务端可渲染的共享壳层来承载主页面的底部导航与阅读宽度；`AppShell` 只提供 `<div>`/`<nav>`，被包裹的页面组件保留并独占自己的一个 `<main>`，避免嵌套 landmark。餐食编辑器维持单个客户端状态机及原有 endpoint，只调整语义结构、图标和 CSS；同步恢复按钮只更改为准确的“检查同步状态”表达，仍向同一 endpoint 发请求，后端继续负责 unknown point 的 exact-GET-only 约束。

**Tech Stack:** Next.js App Router、React、TypeScript、CSS Modules/CSS custom properties、`lucide-react` 线性图标、Node `node:test` + React static markup、Codex In-app Browser 视觉 QA。

**Visual source:** 用户于 2026-08-28 上传并确认的参考图：[`codex-clipboard-ee116b8c-1d67-44bb-bcfc-f2f891713670.png`](/var/folders/0f/p355cr954d12xjcrf_57scqc0000gn/T/codex-clipboard-ee116b8c-1d67-44bb-bcfc-f2f891713670.png)。它是暖白底、深墨大标题、鼠尾草绿状态与 CTA、圆角摄影区、轻边框/轻阴影、松弛纵向间距的唯一视觉来源。实现中不复用图中的食物照片；产品只展示用户当前选择且已同意用于识别的本地照片预览。若此会话临时资源不可读，必须请产品负责人重新上传，而不能自行替换为深色或其他风格。

---

## 已锁定的文件结构

| 文件 | 责任 |
| --- | --- |
| `src/ui/shell/app-shell.tsx` | 主页面通用容器和今日/餐食/账户三项底部导航；不包裹餐食工作流。 |
| `src/ui/shell/app-shell.module.css` | 暖白页面容器、内容宽度、安全区底部导航与阅读页样式。 |
| `src/ui/legal/legal-page.tsx` | 隐私和条款共享的可读信息页，接收页面标题、段落和返回链接。 |
| `src/ui/legal/legal-page.module.css` | 法务阅读的暖白排版和低对比隔线。 |
| `app/globals.css` | 全局 token、系统中文字体、可见焦点、通用 button/input 与 reduced-motion 基线。 |
| `src/ui/dashboard/{today-dashboard,metric-card,data-state}.tsx` | 仪表盘信息层级和可解释指标的语义结构；不计算新分数。 |
| `src/ui/account/account-panel.tsx` | 状态优先的 Google Health 账户页面，沿用原表单 action 和状态机。 |
| `src/ui/shell/status-page.tsx` | 仪表盘的登录/配置/缺数据空态，使用共享主页面壳层。 |
| `app/{privacy,terms}/page.tsx` | 真实、最小化的数据披露/现有条款内容的页面入口。 |
| `src/ui/meals/mobile-meal-editor.tsx` | 餐食拍照、审阅、单项编辑、AI 会话、保存与显式同步的现有交互；重组 markup 和图标，但不改请求契约。 |
| `src/ui/meals/meal-editor.module.css` | 无全局导航的餐食工作流、固定操作栏、dialog、手机与宽屏布局。 |
| `tests/ui/app-shell.test.tsx`、`tests/ui/legal-pages.test.tsx`、`tests/ui/today-dashboard.test.ts`、`tests/ui/account-panel.test.ts`、`tests/ui/mobile-meal-editor.test.tsx` | 静态 markup、可访问名称、链接、固定栏互斥和不泄露数据的回归测试。 |

不创建新 route、数据库表、API endpoint、OAuth scope 或客户端持久化；不修改 `src/server/**` 和 worker 的业务行为。

### Task 1: 建立共享浅色壳层、图标依赖与全局设计 token

**Files:**
- Create: `src/ui/shell/app-shell.tsx`
- Create: `src/ui/shell/app-shell.module.css`
- Create: `tests/ui/app-shell.test.tsx`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `app/globals.css`
- Modify: `src/ui/shell/status-page.tsx`

- [ ] **Step 1: 安装唯一的图标库依赖**

Run: `pnpm add lucide-react`

Expected: `package.json` 的 `dependencies` 与 `pnpm-lock.yaml` 只增加 `lucide-react`；不引入另一套 UI 框架或手写 SVG。

- [ ] **Step 2: 写失败的共享壳层静态测试**

在 `tests/ui/app-shell.test.tsx` 先渲染尚不存在的 `AppShell`，断言：

```tsx
const html = renderToStaticMarkup(
  <AppShell active="today"><p>内容</p></AppShell>,
);
assert.match(html, /aria-label="主要导航"/);
assert.match(html, /href="\/rhythm"/);
assert.match(html, /href="\/rhythm\/meals\/new"/);
assert.match(html, /href="\/rhythm\/account"/);
assert.match(html, /aria-current="page"/);
assert.match(html, /今日/);
assert.match(html, /餐食/);
assert.match(html, /账户/);
```

再用 `active="account"` 验证账户项，而不是颜色，承担当前页的可访问语义。

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm test -- tests/ui/app-shell.test.tsx`

Expected: FAIL，原因是 `AppShell` 尚未存在。

- [ ] **Step 4: 实现服务端共享壳层和导航**

在 `src/ui/shell/app-shell.tsx`：

- 导出 `AppShell({ active, children, className? })`，`active` 是 `'today' | 'account'`；它只输出外层 `<div>` 和同级 `<nav aria-label="主要导航">`，绝不输出 `<main>`。调用方的 `TodayDashboard`、`AccountPanel`、`StatusPage` 与 `LegalPage` 各自保留一个、且仅一个根 `<main>`。
- 用 `House`、`Utensils`、`UserRound`（来自 `lucide-react`）加文字标签，不使用 emoji、内联 SVG 或 CSS 绘图。
- 用原有精确路径 `/rhythm`、`/rhythm/meals/new`、`/rhythm/account`；active 项以 `aria-current="page"` 与文字共同表达，不为此创建“餐食列表”页面。
- 将 `StatusPage` 改为使用 `AppShell active="today"`。它仍输出调用方传入的原因和行动链接，不能把未授权/配置状态伪装为健康分数。

在 `app-shell.module.css` 和 `app/globals.css`：

- 定义 `--surface-canvas: #F7F6F1`、`--surface-raised: #FFFFFF`、`--surface-sage: #E8F0EC`、`--ink: #172826`、`--sage: #8EACA2`、`--sage-deep: #2F765E` 及成功/注意/错误 token；系统中文无衬线字体与 tabular figures。
- 主页面内容在手机端两侧 `20px`，底部预留 `64px + env(safe-area-inset-bottom)`；导航固定且在 dialog 之下。768px 以上内容宽度居中。壳层只布置间距和导航，不能改变 `<main>` landmark 的数量。
- 设置最少 `44px` 触达面、`:focus-visible`、表单控件与 `prefers-reduced-motion`。全局样式不靠颜色单独传递状态，也不覆盖餐食 CSS module 的 scoped dialog 层级。

- [ ] **Step 5: 运行壳层测试、类型检查和完整单测**

Run: `pnpm test -- tests/ui/app-shell.test.tsx && pnpm lint && pnpm test`

Expected: 新测试和既有测试通过；`tsc --noEmit` 不报错。

- [ ] **Step 6: 提交壳层基础设施**

```bash
git add package.json pnpm-lock.yaml app/globals.css src/ui/shell/app-shell.tsx src/ui/shell/app-shell.module.css src/ui/shell/status-page.tsx tests/ui/app-shell.test.tsx
git commit -m "feat: add sage app shell"
```

### Task 2: 重构今日仪表盘为行动优先的暖白健康日记

**Files:**
- Modify: `src/ui/dashboard/today-dashboard.tsx`
- Modify: `src/ui/dashboard/metric-card.tsx`
- Modify: `src/ui/dashboard/data-state.tsx`
- Modify: `tests/ui/today-dashboard.test.ts`
- Modify: `tests/app-shell.test.ts`
- Modify: `app/globals.css`

- [ ] **Step 1: 扩充仪表盘失败测试**

在 `tests/ui/today-dashboard.test.ts` 先断言渲染出的页面：

```ts
assert.match(html, /今日记录/);
assert.match(html, /记录餐食/);
assert.match(html, /数据质量：中/);
assert.match(html, /aria-label="主要导航"/);
assert.match(html, /href="\/rhythm\/meals\/new"/);
```

保留当前的证据（`HRV · 日期：值`）、恢复/睡眠/训练、数据新鲜度和 demo/OAuth 区分断言；新增断言不可把 `score: null` 显示成数字，并验证 `html.match(/<main\b/g)?.length === 1`。`tests/app-shell.test.ts` 继续验证 server-rendered dashboard 为 `force-dynamic`。

- [ ] **Step 2: 运行目标测试确认失败**

Run: `pnpm test -- tests/ui/today-dashboard.test.ts tests/app-shell.test.ts`

Expected: FAIL，缺少新信息层级/导航结构。

- [ ] **Step 3: 实现仪表盘结构和样式**

- 用 `AppShell active="today"` 包住仪表盘；删掉顶部零散的“账户”链接，保留“记录餐食”作为当屏唯一绿色主 CTA。
- 首屏按“日期与同步新鲜度 → 恢复状态 → 一句建议 → 记录餐食”排序；建议与依据保持已有 `TodayView.primaryAction`，不得重写或夸大 AI/健康结论。
- 将三个指标改为纵向节奏模块：标签、分数、数据质量和 detail；分数使用 tabular numbers，`null` 继续展示 `—`。数据不足时保留 `DataState`、原文和真实链接，而不是伪造“恢复良好”。
- 使用共享 token 完成暖白背景、浅绿重点块、低对比隔线和软阴影；不把三个模块恢复为重白卡墙。

- [ ] **Step 4: 运行仪表盘回归**

Run: `pnpm test -- tests/ui/today-dashboard.test.ts tests/app-shell.test.ts && pnpm lint`

Expected: PASS；首页中的文章结构、证据和行为路径均维持。

- [ ] **Step 5: 提交仪表盘**

```bash
git add app/globals.css src/ui/dashboard/today-dashboard.tsx src/ui/dashboard/metric-card.tsx src/ui/dashboard/data-state.tsx tests/ui/today-dashboard.test.ts tests/app-shell.test.ts
git commit -m "feat: redesign today dashboard"
```

### Task 3: 重构账户、空态、隐私与条款，并校正事实披露

**Files:**
- Create: `src/ui/legal/legal-page.tsx`
- Create: `src/ui/legal/legal-page.module.css`
- Create: `tests/ui/legal-pages.test.tsx`
- Modify: `src/ui/account/account-panel.tsx`
- Modify: `src/ui/shell/status-page.tsx`
- Modify: `app/privacy/page.tsx`
- Modify: `app/terms/page.tsx`
- Modify: `tests/ui/account-panel.test.ts`

- [ ] **Step 1: 写账户和法务页失败测试**

在 `tests/ui/account-panel.test.ts` 增加每个账户状态都存在 `aria-label="主要导航"`、账户项为当前页、所有原 form action（连接、重新授权、退出、断开）未变化的断言。

新建 `tests/ui/legal-pages.test.tsx`，渲染隐私/条款入口，先断言：

```tsx
assert.match(privacy, /同步的健康快照/);
assert.match(privacy, /当前餐食照片仅用于一次视觉识别/);
assert.match(privacy, /结构化餐食和问题/);
assert.match(privacy, /加密保存在服务端/);
assert.doesNotMatch(privacy, /本阶段不会拉取、展示或向模型发送你的真实健康记录/);
assert.match(terms, /非医疗的生活方式参考/);
```

同时验证隐私和条款没有 `refresh-token`、`healthUserId`、`GOCSPX`，并都保留可达 `/rhythm/account` 的返回入口和账户 active 导航。

- [ ] **Step 2: 运行目标测试确认失败**

Run: `pnpm test -- tests/ui/account-panel.test.ts tests/ui/legal-pages.test.tsx`

Expected: FAIL，旧页面没有共享壳层和准确的隐私文字。

- [ ] **Step 3: 实现状态优先的账户和阅读页**

- `AccountPanel` 用 `AppShell active="account"` 包住它现有且唯一的根 `<main>`，展示单个连接状态模块：短状态标题、现有原因、唯一主操作，次要退出/断开为轻量按钮。保留 `unconfigured` 才显示 `.env.local`/Docker 指引的既有约束；不添加“本地/部署”环境判别，不显示任何凭证。账户/空态/法务测试均断言页面只出现一个 `<main>`。
- 空态 `StatusPage` 与账户共享相同暖白密度、明确可执行操作，原有原因文案与 href 不变。
- `LegalPage` 统一温白阅读面、深墨标题、宽行距、低对比隔线、返回账户入口和 `AppShell active="account"`；不引入新法律承诺。
- 将 `app/privacy/page.tsx` 的过期断言替换为以下可验证事实（分段呈现）：
  1. 授权范围内的健康记录会同步为本地健康快照，并被读取和展示；
  2. 用户同意后，当前餐食照片仅用于一次视觉识别，保存后不保留照片或识别原文；
  3. 餐食助手只接收当前结构化餐食和本次问题，不接收照片、OAuth/session/refresh token；
  4. OAuth 凭证加密保存在服务端数据库，不进入浏览器存储或模型请求；断开连接删除本地授权。
- 条款继续使用现有非医疗、授权期和撤销说明，仅通过 `LegalPage` 改变阅读结构。

- [ ] **Step 4: 运行账户、法务和首页回归**

Run: `pnpm test -- tests/ui/account-panel.test.ts tests/ui/legal-pages.test.tsx tests/app-shell.test.ts && pnpm lint`

Expected: PASS；账户操作仍指向原有 POST route，文字不泄露 token。

- [ ] **Step 5: 提交账户与法务页**

```bash
git add src/ui/legal/legal-page.tsx src/ui/legal/legal-page.module.css src/ui/account/account-panel.tsx src/ui/shell/status-page.tsx app/privacy/page.tsx app/terms/page.tsx tests/ui/account-panel.test.ts tests/ui/legal-pages.test.tsx
git commit -m "feat: redesign account and reading pages"
```

### Task 4: 将餐食新建页做成摄影优先、可访问的移动端入口

**Files:**
- Modify: `src/ui/meals/mobile-meal-editor.tsx:274-648`
- Modify: `src/ui/meals/meal-editor.module.css:1-325`
- Modify: `tests/ui/mobile-meal-editor.test.tsx`

- [ ] **Step 1: 为新建状态添加失败测试**

扩展 `new editor offers a consented photo upload` 测试，先断言：

```ts
assert.match(html, /拍照，读懂这一餐/);
assert.match(html, /aria-label="选择或拍摄餐食照片"/);
assert.match(html, /type="file"/);
assert.match(html, /我同意将这张照片发送给 AI 识别/);
assert.match(html, /进食时间/);
assert.match(html, /mealEditor__actionBar/);
assert.match(html, /form="meal-upload-form"/);
assert.match(html, /<button[^>]*disabled=""[^>]*>开始识别<\/button>/);
assert.doesNotMatch(html, /aria-label="主要导航"/);
```

继续断言无“搜索”或营养搜索入口。为 disabled 的“开始识别”保留失败前提（未选照片/未同意），用静态 `disabled` 属性验证，不模拟或实际发送照片。

- [ ] **Step 2: 运行目标测试确认失败**

Run: `pnpm test -- tests/ui/mobile-meal-editor.test.tsx`

Expected: FAIL，旧 new-meal markup 没有新的摄影优先文案和命名上传触达面。

- [ ] **Step 3: 重组新建页 markup，保持请求和隐私边界**

- 顶部使用 `ChevronLeft` 返回 `/rhythm`、小型“节律”品牌行、深墨标题“餐食记录”和副标题“拍照，读懂这一餐”。餐食页不引入全局底部导航。
- 将可访问的 `<input type="file">` 置于大圆角上传面内或以 `label` 关联；可用 `Camera` 图标和“拍照或上传照片”文案作为可点触入口。它必须继续接受 jpeg/png/webp，选中后仅使用 `URL.createObjectURL` 显示当前客户端预览。
- 使用可见的 `LockKeyhole` 说明“照片仅用于本次 AI 识别”；餐次使用清晰的四项 segmented select（仍是原生 `<select>` 或有同等 label 的控件），时间保持本地 `datetime-local` 字段。checkbox 语义不变，视觉上为鼠尾草开关/标签。
- 新建状态也渲染唯一的餐食固定操作栏：给现有上传 form 固定 `id="meal-upload-form"`，把 `type="submit" form="meal-upload-form"` 的“开始识别”按钮移入该栏。它继续由 `!file || !photoConsent || !eatenAt || busy` 禁用；同意与文件均满足后，只有用户点击才沿用现有 `submitPhoto` 和 `/rhythm/api/meals/photo`。不要在渲染、选文件或视觉 QA 时自动上传，不保存图片、不引入固定食物图或模型/token 入参。
- 将 CSS 改为同参考图一致的暖白留白、照片比例大圆角面、鼠尾草 CTA、轻阴影/边线与安全区。新建、草稿、已保存和恢复各只有这一个 `56px + env(safe-area-inset-bottom)` 餐食栏，滚动内容为其预留完整高度；至少保持 44px 点击面和照片上文字的实色承托。

- [ ] **Step 4: 运行餐食编辑器回归与类型检查**

Run: `pnpm test -- tests/ui/mobile-meal-editor.test.tsx && pnpm lint`

Expected: PASS；公开的 endpoint helper、营养编辑工具函数与 dialog 测试不变。

- [ ] **Step 5: 提交餐食拍照入口**

```bash
git add src/ui/meals/mobile-meal-editor.tsx src/ui/meals/meal-editor.module.css tests/ui/mobile-meal-editor.test.tsx
git commit -m "feat: redesign meal capture"
```

### Task 5: 重构餐食审阅、AI 底部抽屉和显式同步操作栏

**Files:**
- Modify: `src/ui/meals/mobile-meal-editor.tsx:650-901`
- Modify: `src/ui/meals/meal-editor.module.css:1-325`
- Modify: `tests/ui/mobile-meal-editor.test.tsx`
- Modify: `tests/server/mobile-meal-regression.test.ts`
- Modify: `tests/server/current-meal-http.test.ts`

- [ ] **Step 1: 先扩写同步和审阅的失败测试**

在 UI 测试中先新增断言：

```ts
assert.match(draftHtml, /完整营养/);
assert.match(draftHtml, /只覆盖这一项，其他营养不会改变/);
assert.match(draftHtml, /问 AI 修改这餐/);
assert.match(savedHtml, /同步这一餐/);
assert.match(recoveryHtml, /检查同步状态/);
assert.match(recoveryHtml, /编辑已暂停/);
assert.doesNotMatch(recoveryHtml, /aria-label="主要导航"/);
```

保留（或添加）行为回归：

- 修改食材只请求该 dish 的 `replace_ingredients`，重新计算该菜；
- 单项编辑只发 `set_nutrient` 并保留其它营养；
- AI 建议需点击后才 apply、手工编辑使待处理建议失效、聊天不持久化；
- 保存并不写 Google，显式同步后才产生同步任务；
- recovery 中的同步请求仍由服务端以 `unknown_exact_get` 启动，测试继续保证无 duplicate create/delete POST。

`tests/server/mobile-meal-regression.test.ts` 和 `tests/server/current-meal-http.test.ts` 只能维护/补足断言，不能为视觉改动修改 server 实现。

- [ ] **Step 2: 运行测试确认新的 UI 标签失败，而既有安全测试仍通过**

Run: `pnpm test -- tests/ui/mobile-meal-editor.test.tsx tests/server/mobile-meal-regression.test.ts tests/server/current-meal-http.test.ts`

Expected: UI 测试因新标签/结构失败；现有 server 安全回归仍 PASS。

- [ ] **Step 3: 实现连续审阅流和不变的安全动作**

- 审阅顶部展示餐次、时间和现有 `syncState` 文本；在草稿中仅显示“保存修改”，保存后才显示“同步这一餐”。菜品清单显示“编辑此菜”，营养组先展开能量/宏量、折叠维生素/矿物质/其他；每个营养行仍可打开原生 dialog，且明确“只覆盖这一项”。
- 继续复用 `beginDishEdit`、`saveDishEdit`、`saveNutrientEdit`、`applyPatch`，不改变 JSON payload、保存 URL 或 `MealPatch` 语义。食材 dialog 仍明确保存后会取代该菜原先单项修改。
- 把 AI 入口设计为次级“问 AI 修改这餐”按钮，dialog 内保留同页会话、待处理建议和“查看并应用”；不添加 localStorage、数据库字段、图片、消息、建议或 token 的持久化。assistant 请求继续只含结构化餐食和本次问题。
- 固定餐食操作栏在手机端保持 `56px + safe area`，滚动内容预留完整高度，层级低于 dialog。草稿只含保存；已保存才显示同步。页面完全不渲染全局底部导航。
- `syncing` 和 `recovery` 继续锁住编辑。仅将 recovery CTA 的文字改为“检查同步状态”，其 `onClick`、endpoint 和 POST 方法完全不改；该既有 endpoint 由 server 识别 recovery，并只发起原 point name 的 exact GET。不要添加重新排队、重新创建或删除 CTA；`failed_action_required` 只在所有 unknown 消除后才由现有服务端恢复。
- CSS 使用温白表面、浅绿 status/已保存、琥珀注意、红色错误、低对比隔线；保留现有 native dialog、焦点恢复、Escape 行为和可见焦点。768px 以上允许主内容＋AI 侧栏两列，但动作顺序、请求和内容不变。

- [ ] **Step 4: 运行餐食全链路和同步安全回归**

Run: `pnpm test -- tests/ui/mobile-meal-editor.test.tsx tests/server/mobile-meal-regression.test.ts tests/server/current-meal-http.test.ts tests/server/current-meal-sync-worker.test.ts && pnpm lint`

Expected: PASS；“检查同步状态”对应的 server test 仍只观察到 exact-name GET，绝无第二个 create/delete POST。

- [ ] **Step 5: 提交审阅与同步视觉改造**

```bash
git add src/ui/meals/mobile-meal-editor.tsx src/ui/meals/meal-editor.module.css tests/ui/mobile-meal-editor.test.tsx tests/server/mobile-meal-regression.test.ts tests/server/current-meal-http.test.ts
git commit -m "feat: redesign meal review and sync states"
```

### Task 6: 响应式、无障碍与视觉 QA 收口

**Files:**
- Create: `design-qa.md`
- Modify: `app/globals.css`
- Modify: `src/ui/shell/app-shell.module.css`
- Modify: `src/ui/meals/meal-editor.module.css`
- Modify: `tests/ui/app-shell.test.tsx`
- Modify: `tests/ui/mobile-meal-editor.test.tsx`

- [ ] **Step 1: 增加固定栏和可访问性的失败/回归断言**

在壳层/餐食静态测试中确认：主页面有 `主要导航`、餐食编辑器没有该导航但有 `mealEditor__actionBar`；按钮和输入均有可访问名称；recovery 锁定时菜品编辑和营养编辑按钮 disabled。保留 native dialog 的 Escape/焦点恢复测试。

- [ ] **Step 2: 运行 UI 回归**

Run: `pnpm test -- tests/ui/app-shell.test.tsx tests/ui/mobile-meal-editor.test.tsx`

Expected: FAIL 仅在新布局/语义未达成时；修复后 PASS。

- [ ] **Step 3: 在用户选择的 In-app Browser 做页面核验**

- 启动本地预览：`pnpm dev --port 3000`。为此轮**仅本地、不可提交**的视觉核验，用 `apply_patch` 临时创建 `app/__visual-qa__/page.tsx`：它只在 `state=draft|saved|recovery` 三种 query state 之间选择预定义的 `EditableMealDraft`/`EditableMealSaved` fixture，渲染 `MobileMealEditor` 的现有 `initialDraft` 或 `initialMeal` props；fixture 不含图片、真实用户、token、AI 消息或网络请求。recovery fixture 使用 `initialSyncState="recovery"` 与 `initialCanSync={true}`，但浏览器测试不点击任何保存/同步/AI 动作。截图后用 `apply_patch` 删除此文件、确认 `git status --short` 不含它，且绝不提交这个 route。
- 在 In-app Browser 检查 `/rhythm`、`/rhythm/account`、`/rhythm/privacy`、`/rhythm/terms`、`/rhythm/meals/new`，以及临时 `/rhythm/__visual-qa__?state=draft`、`?state=saved`、`?state=recovery`。
- 分别以 320×844、390×844、768×1024 截图；检查没有横向滚动、文字截断、固定导航/操作栏遮挡、低对比文字、不可见焦点或导航重叠。
- 对 390×844 的餐食新建页，将本计划顶部链接的用户确认参考图与同视口实现截图放入**同一张比较输入**，依据大标题、暖白画布、鼠尾草主色、圆角、摄影/上传区比例、边距和阴影逐项修正。新建页不选择/同意/提交真实照片，因此不会调用视觉模型；fixture 页也不触发网络操作。
- 用键盘验证 tab 顺序、focus-visible、select、checkbox、dialog Escape 与焦点返回；确认 reduced-motion 下没有依赖动画才可理解的状态。

- [ ] **Step 4: 记录设计 QA**

在项目根 `design-qa.md` 写明：本计划顶部的参考图路径/日期、审查 URL、三个视口、检查过的新建/draft/saved/recovery 状态、发现并修复的可见差异，以及最终一行 `Result: PASSED`。该记录不得含真实餐食照片、token、健康数据或聊天内容。

- [ ] **Step 5: 跑完整验证**

Run: `git diff --check && pnpm test && pnpm lint && pnpm build`

Expected: 所有命令退出码为 0；测试覆盖既有 meal/sync 隐私安全契约，构建成功。

- [ ] **Step 6: 提交 QA 与最后样式调整**

```bash
git add design-qa.md app/globals.css src/ui/shell/app-shell.module.css src/ui/meals/meal-editor.module.css tests/ui/app-shell.test.tsx tests/ui/mobile-meal-editor.test.tsx
git commit -m "test: verify sage health journal redesign"
```
