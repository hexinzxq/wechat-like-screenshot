# 长截图功能迁移说明

这份文档讲的是新版长截图迁移方式：长截图后端集中在一个 Rust 文件里，前端基础逻辑集中在一个 TypeScript 文件里。你迁移到别的 `Tauri 2 + React + Next.js` 项目时，优先复制这两个文件。

## 先看结论

你真正需要重点迁移的是这两个文件：

```text
src-tauri/src/scroll_capture.rs
src/lib/scrollScreenshot.ts
```

然后在这些文件里做少量接线：

```text
src-tauri/src/main.rs
src/app/overlay/page.tsx
src/components/capture/AnnotationCanvas.tsx
src/app/overlay/overlay.css
```

最核心的一句话：

> Rust 长截图能力看 `scroll_capture.rs`，前端长截图基础能力看 `scrollScreenshot.ts`，不要再去 `main.rs` 和页面里到处找拼接算法。

## 文件职责

| 文件 | 职责 |
| --- | --- |
| `src-tauri/src/scroll_capture.rs` | Windows 目标窗口识别、临时鼠标穿透、滚轮转发、屏幕区域裁剪、稳定帧采集 |
| `src/lib/scrollScreenshot.ts` | 长截图前端类型、初始帧裁剪、相似度匹配、向上/向下拼接、实时预览、`useScrollScreenshot` hook |
| `src-tauri/src/main.rs` | 只负责 `mod scroll_capture;`，并把命令注册到 `invoke_handler` |
| `src/app/overlay/page.tsx` | 只负责把长截图 hook 接到截图页面和工具栏 |
| `src/components/capture/AnnotationCanvas.tsx` | 让拼好的长图继续支持绘制、复制、保存 |
| `src/app/overlay/overlay.css` | 长截图模式下的工具栏和实时预览样式 |

## 后端怎么迁移

### 1. 复制 Rust 文件

把本项目这个文件复制到你的 Tauri 项目：

```text
src-tauri/src/scroll_capture.rs
```

这个文件里已经包含长截图后端需要的基础代码：

- `ScrollCaptureRequest`
- `ScrollCaptureFrame`
- `begin_scroll_capture`
- `step_scroll_capture`
- `capture_desktop_image`
- `capture_stable_scroll_region`
- `set_overlay_ignore_cursor`
- `target_window_at`
- `send_wheel_delta`

也就是说，长截图相关 Rust 逻辑不要再散落在 `main.rs` 里。

### 2. 检查 Cargo.toml

你的 `src-tauri/Cargo.toml` 里需要有这些依赖或特性：

```toml
base64 = "0.22"
image = "0.24"
screenshots = "0.8"
serde = { version = "1", features = ["derive"] }

windows-sys = { version = "0.59", features = [
  "Win32_Foundation",
  "Win32_Graphics_Gdi",
  "Win32_UI_HiDpi",
  "Win32_UI_Input_KeyboardAndMouse",
  "Win32_UI_WindowsAndMessaging"
] }
```

如果你的项目已经有 `windows-sys`，重点确认补上这两个：

```text
Win32_UI_Input_KeyboardAndMouse
Win32_UI_WindowsAndMessaging
```

少了它们，Rust 不能转发鼠标滚轮。

### 3. main.rs 引入模块

在 `src-tauri/src/main.rs` 顶部加：

```rust
mod scroll_capture;
```

再加命令导入：

```rust
use scroll_capture::{begin_scroll_capture, step_scroll_capture};
```

### 4. main.rs 注册命令

在 `invoke_handler` 里加：

```rust
.invoke_handler(tauri::generate_handler![
    // 你的其他命令
    begin_scroll_capture,
    step_scroll_capture
])
```

前端会通过这两个名字调用：

```ts
invoke("begin_scroll_capture", { request })
invoke("step_scroll_capture", { request, scrollDeltaY })
```

### 5. 必须保留 overlay 窗口名称

`scroll_capture.rs` 里会找这个窗口：

```rust
app.get_webview_window("overlay")
```

所以你的截图窗口如果不叫 `overlay`，要么改窗口名，要么改 `scroll_capture.rs` 里的这处名字。

## 前端怎么迁移

### 1. 复制前端基础文件

把这个文件复制过去：

```text
src/lib/scrollScreenshot.ts
```

这个文件里已经集中放了长截图前端基础能力：

- 长截图类型定义
- 选区转 Rust 请求
- 初始帧裁剪
- data URL 转 canvas frame
- 相似度判断
- 固定顶部/底部区域排除
- 向下滚动拼到底部
- 向上滚动拼到顶部
- 实时预览图生成
- `useScrollScreenshot` hook

迁移时优先看这个文件，不要从页面里一点点扣算法。

### 2. overlay 页面接入 hook

在你的截图页面里导入：

```ts
import { clamp, isPointInsideRect, useScrollScreenshot } from "@/lib/scrollScreenshot";
```

然后在组件里接入：

```ts
const {
  scrollMode,
  scrollBusy,
  scrollPreviewUrl,
  scrollProgress,
  startScrollCapture,
  queueScrollCapture,
  finishScrollCapture,
  cancelScrollCapture,
  handleScrollWheel,
  resetScrollCaptureState
} = useScrollScreenshot({
  capture,
  image,
  selection,
  imageFrame,
  canvasRef,
  commitTextDraft,
  presentCapture,
  setHoverWindow,
  setNotice,
  setTool
});
```

这里每个参数的意思：

| 参数 | 说明 |
| --- | --- |
| `capture` | 当前整屏截图数据 |
| `image` | 已加载的整屏截图图片 |
| `selection` | 用户框选区域 |
| `imageFrame` | 长图完成后显示在画布里的位置 |
| `canvasRef` | 标注画布 ref |
| `commitTextDraft` | 提交当前文字输入 |
| `presentCapture` | 把图片切回普通截图编辑态 |
| `setHoverWindow` | 清理窗口识别高亮 |
| `setNotice` | 显示提示 |
| `setTool` | 切换当前工具 |

### 3. 绑定滚轮事件

截图 overlay 的最外层元素要绑定：

```tsx
<main
  className={`overlay-root${scrollMode ? " scroll-mode" : ""}`}
  onWheel={handleScrollWheel}
>
```

长截图能不能滚，关键就在这里。

用户滚轮进入前端后，`handleScrollWheel` 会判断鼠标是否在选区内，然后调用 Rust 的 `step_scroll_capture` 去真实转发滚轮。

### 4. 工具栏加长截图按钮

普通工具栏里加：

```tsx
<button title="长截图" disabled={!!imageFrame || scrollBusy} onClick={startScrollCapture}>
  <ScrollText size={17} />
</button>
```

长截图模式下保留这三个控制按钮：

```tsx
<button className="scroll-control" title="补采一帧" disabled={scrollBusy} onClick={() => queueScrollCapture(0)}>
  <ScrollText size={17} />
</button>
<button className="scroll-control" title="完成长截图" onClick={finishScrollCapture}>
  <Check size={17} />
</button>
<button className="scroll-control" title="取消长截图" onClick={cancelScrollCapture}>
  <X size={17} />
</button>
```

注意：补采一帧传 `0`，表示不滚动，只重新采当前选区。

### 5. 添加实时预览

在 overlay 里渲染：

```tsx
{scrollMode && scrollPreviewUrl && (
  <div className="scroll-preview" style={scrollPreviewStyle}>
    <div className="scroll-preview-title">实时预览</div>
    <img src={scrollPreviewUrl} alt="" draggable={false} />
    <div className="scroll-preview-meta">
      {scrollProgress ? `${scrollProgress.slices} 屏 · ${scrollProgress.height}px` : ""}
    </div>
  </div>
)}
```

实时预览很重要。拼接是否正确，用户能马上看到。

### 6. 页面重置时清理长截图状态

普通截图刷新、关闭、完成长图后，要调用：

```ts
resetScrollCaptureState("")
```

否则容易出现上一次长截图的预览或状态残留。

## AnnotationCanvas 必须支持 imageFrame

长截图完成后，生成的是一张新长图，不再是原来的整屏截图。

所以 `AnnotationCanvas` 要支持：

```ts
imageFrame?: Rect | null;
```

显示图片时，长图要按 `imageFrame` 定位：

```tsx
<img
  className={`capture-image${imageFrame ? " framed" : ""}`}
  src={imageDataUrl}
  style={
    imageFrame
      ? {
          left: imageFrame.x,
          top: imageFrame.y,
          width: imageFrame.width,
          height: imageFrame.height
        }
      : undefined
  }
/>
```

导出时也要用 `imageFrame`。否则保存、复制、绘制内容会错位。

## CSS 需要搬哪些

从 `src/app/overlay/overlay.css` 里迁移这些块：

```css
.capture-image.framed
.toolbar .scroll-control
.scroll-mode .toolbar > button
.scroll-mode .toolbar > input
.scroll-mode .toolbar > .divider
.scroll-mode .toolbar > .scroll-control
.scroll-preview
.scroll-preview-title
.scroll-preview-meta
.scroll-preview img
```

目标是：

1. 长截图模式隐藏普通绘图按钮。
2. 长截图模式只显示补采、完成、取消。
3. 实时预览不挡住选区和工具栏。
4. 长图完成后可以继续标注。

## 最小迁移顺序

照这个顺序做，最不容易乱：

1. 复制 `src-tauri/src/scroll_capture.rs`。
2. 在 `main.rs` 加 `mod scroll_capture;`。
3. 在 `main.rs` 导入并注册 `begin_scroll_capture`、`step_scroll_capture`。
4. 检查 `Cargo.toml` 的 `windows-sys` features。
5. 复制 `src/lib/scrollScreenshot.ts`。
6. 在 overlay 页面接入 `useScrollScreenshot`。
7. 给 overlay 根节点绑定 `onWheel={handleScrollWheel}`。
8. 工具栏加“长截图、补采一帧、完成、取消”按钮。
9. 加实时预览 UI。
10. 确认 `AnnotationCanvas` 支持 `imageFrame`。
11. 复制 CSS。
12. 跑 `npm run build` 和 `cargo check`。

## 必须测试

迁移后按下面顺序测：

1. 普通截图能启动。
2. 框选区域后能点“长截图”。
3. 进入长截图后，截图窗口不会关闭。
4. 鼠标放在选区内，滚轮向下，真实页面能滚。
5. 向下滚动时，新内容拼到长图底部。
6. 鼠标向上滚，真实页面能向上滚。
7. 向上滚动时，新内容拼到长图顶部。
8. 点“补采一帧”不会强制滚动。
9. 点“完成长截图”后回到普通编辑态。
10. 完成后可以继续绘制、复制、保存、取消。
11. 再次进入长截图，不会残留上一次的预览或画面。

## 常见问题

### 1. 还是没法滚动

先检查 `src-tauri/src/scroll_capture.rs` 里的 `step_scroll_capture`。

必须有这个顺序：

```rust
set_overlay_ignore_cursor(&app, true)?;
focus_hwnd(target_hwnd);
send_wheel_delta(scroll_delta_y);
let image = capture_stable_scroll_region(&request)?;
set_overlay_ignore_cursor(&app, false)?;
```

如果不临时让 overlay 鼠标穿透，滚轮会被截图窗口吃掉，真实页面不会动。

### 2. 工具栏点不了

说明 `set_overlay_ignore_cursor(&app, false)` 没恢复。

鼠标穿透只能在 Rust 转发滚轮那一小段时间打开，不能整个长截图期间一直打开。

### 3. 向下滚动拼到上面了

检查方向：

```ts
const direction = deltaY < 0 ? "up" : "down";
```

向下滚动要走 `appendFrame`，向上滚动要走 `prependFrame`。

### 4. 拼接重复内容很多

优先看：

```ts
framesAreSimilar(...)
findScrollMatch(...)
```

如果页面没真的滚动成功，新帧和旧帧几乎一样，就不要拼。

### 5. 长图完成后不能继续画

检查 `presentCapture` 和 `AnnotationCanvas`。

完成长截图后，必须把长图作为新的 `imageDataUrl` 放回普通截图编辑态，并传入 `imageFrame`。

### 6. 上一次长截图内容残留

检查所有关闭、完成、重新展示截图的地方，有没有调用：

```ts
resetScrollCaptureState("")
```

## 当前项目已验证

本项目当前重构后已跑过：

```text
npm run build
cargo check
```

两个都通过。
