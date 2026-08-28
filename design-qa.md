# 柔和绿色健康日记：设计 QA

## 对照对象与证据

- Source visual truth: `/var/folders/0f/p355cr954d12xjcrf_57scqc0000gn/T/codex-clipboard-ee116b8c-1d67-44bb-bcfc-f2f891713670.png`
- Source pixels: `852 × 1846`（按约 `2×` 密度看待）。为消除密度差异，已缩放为 `/private/tmp/rhythm-reference-normalized-390x844.png`，`390 × 844`。
- Implementation: `http://localhost:3000/rhythm/meals/new`，未选择照片的初始拍照状态。
- Implementation screenshot: `/private/tmp/rhythm-meal-new-390x844-v4.png`，`390 × 844` pixels；CSS viewport `390 × 844`，device scale factor `1`。
- Full-view evidence: 上述归一化参考图与最终实现截图在同一次视觉对照中查看；二者都是无浏览器外框的 `390 × 844` 内容区域。
- Focused-region evidence: 全幅截图已能清晰读取标题、上传面、原生字段、同意开关、固定主操作和相机图标；因此没有另裁切一张会丢失它们空间关系的局部图。
- Supporting responsive evidence: 新建页为 `/private/tmp/rhythm-meal-new-final-320x844.png` 与 `/private/tmp/rhythm-meal-new-final-768x1024.png`；草稿复核态为 `/private/tmp/rhythm-draft-fixture-390x844.png` 与 `/private/tmp/rhythm-draft-fixture-768x1024.png`；已保存态为 `/private/tmp/rhythm-saved-fixture-390x844.png`；恢复态为 `/private/tmp/rhythm-recovery-fixture-320x844.png` 与 `/private/tmp/rhythm-recovery-fixture-390x844.png`。全站页面的 `768 × 1024` 截图分别为 `/private/tmp/rhythm-today-768x1024.png`、`/private/tmp/rhythm-account-768x1024.png`、`/private/tmp/rhythm-privacy-768x1024.png`、`/private/tmp/rhythm-terms-768x1024.png`。临时 fixture route 已在验收后删除，不会随产品发布。

## 交互与状态覆盖

- 拍照页：餐次原生选择、进食时间、同意开关均已通过浏览器实际操作验证；没有选择文件、调用 AI、保存或同步，因此不会写入用户或 Google 数据。
- 复核页：草稿、已保存、恢复态均检查过一个 `main`、一个底部操作条、无全局导航、无横向溢出。恢复态中的编辑和 AI 操作处于锁定状态，主操作为“检查同步状态”。
- 响应式：新建页有 `320 × 844`、`390 × 844`、`768 × 1024` 截图；草稿复核页有 `390 × 844`、`768 × 1024` 截图；已保存态有 `390 × 844`，恢复态有 `320 × 844`、`390 × 844`。移动端操作条固定在安全区上方，平板宽度回到正常内容流，未见遮挡或水平滚动。
- 可访问性：原生表单控件保留名称和标签，键盘焦点可见；全局 `prefers-reduced-motion` 规则覆盖新加入的视觉过渡。浏览器控制层未能触发原生 `dialog` 的 Escape cancel 事件，但单元测试覆盖该 cancel handler；通过“关闭”按钮的真实操作确认焦点回到了“编辑此菜”。
- 浏览器控制台：该轮 UI 验收期间未发现 error 或 warn。开发服务器左下角的 Next 开发标识不属于产品界面，未计入比较。

## 必查保真表面

### 字体与排版

深墨色中文标题采用系统 CJK 字体栈、粗字重和紧凑字距；最终拍照标题下调到与参考相近的视觉等级，副标题维持低对比的鼠尾草绿。字段文字及固定操作保持可读的常规字距与行高；窄宽度未产生截断或异常换行。

### 间距、布局与表面

页面保留参考的暖白留白、纵向阅读节奏、圆角上传主区域、独立浮起的表单面与底部主操作。`320`、`390` 和 `768` 宽度都没有隐藏持久操作或横向溢出。草稿、保存和恢复页使用相同节奏而不将每个信息块堆成厚重的卡片框。

### 颜色与视觉 token

暖白底色、深绿墨色、灰绿说明色、浅鼠尾草上传面和柔和绿色主操作映射到全局 token；警告、同步和禁用状态仍保留可辨识的语义色与对比度。阴影和边框保持轻，避免干扰健康记录的主层级。

### 图片、图标与资产

参考图中的食物照片是该截图中的示例内容，而产品的对应位置必须是用户尚未选择照片时的上传状态。实现没有把该截图、假餐食图或 CSS 伪造图像当作用户数据；用户选择本地照片后才显示真实预览。相机、锁和状态图标均使用同一 Lucide 图标库，未以手工 SVG 或文字符号替代。

### 文案、控件与状态

“拍照，读懂这一餐”“拍照或上传照片”“我同意将这张照片发送给 AI 识别”和“开始识别”组成清晰的主路径。餐次和时间仍是现有协议要求的原生控件；复核页保留仅修改营养素、改食材重新计算、显式同步与恢复安全检查的既有语义。

## Findings

### 已修复

- [P2] 拍照页首屏的标题与上传区域比例偏离参考
  - Location: `src/ui/meals/meal-editor.module.css`，`.mealEditor__captureHeader`、`.mealEditor__captureSurface`。
  - Evidence: 首次实现截图 `/private/tmp/rhythm-meal-new-390x844.png` 中，标题过小、外层白卡包住上传与字段，上传区高达约 `312px`；归一化参考中标题和照片区更有呼吸感、后续字段是独立表面。
  - Impact: 首屏层级显得像通用表单，和用户锁定的柔和绿色记录页风格不一致。
  - Fix: 去除捕获流程的外层卡片处理，改为独立上传面和字段面；调整标题字级／字距，上传区从 `19.5rem` 收至 `17.5rem`；保留不伪造照片的隐私安全空状态。
  - Post-fix evidence: `/private/tmp/rhythm-meal-new-390x844-v4.png` 与 `/private/tmp/rhythm-reference-normalized-390x844.png` 同尺寸复查。标题、暖白留白、浅绿色主面、圆角字段、开关和底部绿色主操作现在形成一致的层级，无 P0/P1/P2 差异。

## Open Questions

- 参考图提供的是视觉方向，不是可作为用户餐食预览的独立原图资产；因此未在空状态展示食物照片。这是有意的隐私与真实性约束，而非待修复的图像缺失。
- Dashboard、账户和阅读页没有逐像素 source screenshot；它们以该图确定的颜色、排版、圆角和操作层级进行重设计，并已在 `768 × 1024` 浏览器截图中检查布局。

## Implementation Checklist

- [x] 将拍照入口、复核、保存、恢复、Dashboard、账户与阅读页统一为柔和绿色健康日记系统。
- [x] 在关键移动与平板视口检查布局、底部操作和横向溢出。
- [x] 保留原生表单和既有保存／同步协议，不生成或持久化示例图片。
- [x] 完成源图与最终 `390 × 844` 实现图的归一化视觉对照。
- [x] 清除临时视觉 fixture route。

## Follow-up Polish

- [P3] 若未来提供可授权的品牌标记或正式拍照空状态插画，可替换目前的文字品牌与中性上传面；不能使用参考截图中的餐食作为用户内容。

final result: passed
