# 长截图功能移植教程

这份文档只讲一件事：把本项目里的“手动滚动长截图”能力，移植到另一个 `Tauri 2 + React + Next.js` 项目里。

当前项目的长截图设计是“微信式手动滚动”：用户先框选区域，点击长截图，然后自己滚动页面；程序每次滚轮滚动后采集一帧，把新内容拼到长图里，最后用户点完成，再进入普通截图编辑流程，可以继续画矩形、箭头、文字、Excalidraw 内容，并保存或复制。

> 重要：这里不讲自动滚动。之前自动滚动的问题很多，当前推荐移植的是手动滚动长截图。

## 你需要关注哪些文件

先看这 4 个文件，基本就够了。

| 文件 | 你要搬什么 |
| --- | --- |
| `src-tauri/src/main.rs` | Windows 原生采集、转发鼠标滚轮、识别目标窗口、裁剪屏幕区域 |
| `src/app/overlay/page.tsx` | 长截图状态、滚轮事件、拼接算法、实时预览、完成/取消流程 |
| `src/components/capture/AnnotationCanvas.tsx` | 让拼好的长图继续支持绘制、保存、复制 |
| `src/app/overlay/overlay.css` | 长截图模式下的工具栏和预览样式 |

如果你的新项目目录结构不一样，也没关系，按“功能块”搬，不要死记路径。

## 移植后的用户流程

你最终要实现的流程应该是这样：

1. 用户按截图快捷键。
2. 用户框选一块区域。
3. 用户点击工具栏里的“长截图”。
4. 截图窗口保持在屏幕上，只显示选区和长截图控制条。
5. 用户把鼠标放在选区里，手动滚轮向下或向上滚动。
6. 每滚一次，程序采集一帧并拼接到长图预览里。
7. 用户点击完成。
8. 拼好的长图回到普通截图编辑态。
9. 用户可以继续绘制、写文字、撤销、复制、保存或取消。

如果第 5 步不能滚动，说明原生滚轮转发或 overlay 鼠标穿透没接好，这是最常见的问题。

## 整体原理

长截图不是简单地把整个网页一次性截下来，因为 Windows 层面拿不到所有应用的完整滚动内容。

本项目采用的是“采集可见区域 + 滚轮推进 + 相似度拼接”：

1. 前端拿到用户选区。
2. Rust 记录选区中心点下面的真实窗口句柄。
3. 用户滚轮滚动时，前端拦截滚轮事件。
4. 前端调用 Rust 的 `step_scroll_capture`。
5. Rust 临时让截图 overlay 不吃鼠标事件。
6. Rust 把滚轮事件发给真实目标窗口。
7. Rust 等页面滚动稳定后，裁剪选区那块屏幕图像。
8. 前端对新帧和已有长图做相似度匹配。
9. 找到重叠区域后，只拼接新增内容。
10. 用户完成后，把拼好的长图交给普通绘图画布。

## 第一步：搬 Rust 后端能力

打开本项目的 `src-tauri/src/main.rs`，重点搬这些内容。

### 1. Windows 依赖

检查你的 `src-tauri/Cargo.toml`，需要有 `windows-sys`，并启用这些能力：

```toml
windows-sys = { version = "0.59", features = [
  "Win32_Foundation",
  "Win32_Graphics_Gdi",
  "Win32_UI_HiDpi",
  "Win32_UI_Input_KeyboardAndMouse",
  "Win32_UI_WindowsAndMessaging"
] }
```

如果你的项目已经有 `windows-sys`，只要补齐 `Win32_UI_Input_KeyboardAndMouse` 和 `Win32_UI_WindowsAndMessaging` 即可。

### 2. 搬数据结构

在 `src-tauri/src/main.rs` 里找到并搬走：

```rust
ScrollCaptureRequest
ScrollCaptureFrame
```

它们负责前后端通信。

`ScrollCaptureRequest` 里最关键的是：

| 字段 | 用途 |
| --- | --- |
| `x` | 选区左上角屏幕坐标 |
| `y` | 选区左上角屏幕坐标 |
| `width` | 选区宽度 |
| `height` | 选区高度 |
| `scale_factor` | 屏幕缩放比例 |
| `target_hwnd` | 目标窗口句柄，第一帧可以为空，后续必须带上 |

`ScrollCaptureFrame` 里最关键的是：

| 字段 | 用途 |
| --- | --- |
| `data_url` | Rust 裁剪出的 PNG 图片 |
| `target_hwnd` | 当前滚动目标窗口 |
| `width` | 图片宽度 |
| `height` | 图片高度 |
| `capture_x` | 实际采集的屏幕坐标 |
| `capture_y` | 实际采集的屏幕坐标 |

### 3. 搬 Tauri 命令

必须搬这两个命令：

```rust
#[tauri::command]
fn begin_scroll_capture(...)

#[tauri::command]
fn step_scroll_capture(...)
```

它们的职责不同：

| 方法 | 什么时候调用 | 做什么 |
| --- | --- | --- |
| `begin_scroll_capture` | 用户刚点击“长截图” | 识别选区下面的真实目标窗口，并裁剪当前可见区域 |
| `step_scroll_capture` | 用户每次滚轮滚动 | 把滚轮发给目标窗口，等待滚动稳定，再裁剪一帧 |

然后在 `invoke_handler` 里注册：

```rust
.invoke_handler(tauri::generate_handler![
  begin_scroll_capture,
  step_scroll_capture,
  // 你的其他命令
])
```

少注册任何一个，前端都会调用失败。

### 4. 搬 Rust 辅助方法

这些方法也要一起搬，不要只搬 Tauri 命令：

```rust
normalize_scroll_request
capture_scroll_region
capture_stable_scroll_region
crop_desktop_area
images_are_similar
sampled_diff
set_overlay_ignore_cursor
target_window_at
hwnd_to_isize
isize_to_hwnd
focus_hwnd
send_wheel_delta
```

它们分别负责：

| 方法 | 作用 |
| --- | --- |
| `normalize_scroll_request` | 修正选区坐标、尺寸和缩放 |
| `capture_scroll_region` | 裁剪屏幕上的选区区域 |
| `capture_stable_scroll_region` | 等滚动后的画面稳定下来再返回 |
| `crop_desktop_area` | 真正从桌面截图里裁切图片 |
| `images_are_similar` | 判断两帧是否几乎一样，避免重复拼接 |
| `sampled_diff` | 抽样计算图片差异 |
| `set_overlay_ignore_cursor` | 临时让截图窗口不拦截鼠标事件 |
| `target_window_at` | 根据选区中心点找到下面的真实窗口 |
| `focus_hwnd` | 把真实目标窗口激活 |
| `send_wheel_delta` | 用 Windows `SendInput` 发滚轮事件 |

### 5. 最容易搬错的地方

`step_scroll_capture` 必须能拿到 `AppHandle`，因为它要临时切换 overlay 的鼠标穿透状态。

正确流程是：

```rust
set_overlay_ignore_cursor(&app, true)?;
focus_hwnd(hwnd);
send_wheel_delta(scroll_delta_y)?;
let frame = capture_stable_scroll_region(...)?;
set_overlay_ignore_cursor(&app, false)?;
```

这个细节非常关键。

如果你不临时 `ignore_cursor_events = true`，滚轮会被截图 overlay 吃掉，真实页面不会滚。

如果你设置成 `true` 后忘了恢复成 `false`，工具栏会点不了，完成和取消也会失效。

## 第二步：搬前端长截图状态

打开 `src/app/overlay/page.tsx`。

先搬这些类型：

```ts
type ScrollCaptureRequest
type ScrollCaptureFrame
type BitmapFrame
type ScrollSession
type ScrollProgress
type ScrollMatch
```

它们分别表示：

| 类型 | 用途 |
| --- | --- |
| `ScrollCaptureRequest` | 传给 Rust 的选区参数 |
| `ScrollCaptureFrame` | Rust 返回的一帧图片 |
| `BitmapFrame` | 前端 canvas 里的图片帧 |
| `ScrollSession` | 当前长截图会话 |
| `ScrollProgress` | 预览上显示的尺寸、帧数等 |
| `ScrollMatch` | 拼接算法找到的重叠信息 |

## 第三步：搬前端图片工具方法

还是在 `src/app/overlay/page.tsx`，找到并搬这些函数：

```ts
nextPaint
loadImage
canvasFrame
frameFromDataUrl
cloneCanvas
previewDataUrl
pixelDiff
sampledDiff
sampledRowDiff
framesAreSimilar
fixedEdgeBands
findScrollMatch
appendFrame
prependFrame
fitImageFrame
```

新手可以这样理解：

| 方法 | 作用 |
| --- | --- |
| `nextPaint` | 等浏览器绘制一帧，减少闪烁和时序问题 |
| `loadImage` | 把 data URL 变成图片对象 |
| `canvasFrame` | 把图片画到 canvas 里 |
| `frameFromDataUrl` | 把 Rust 返回的 data URL 变成可拼接帧 |
| `cloneCanvas` | 复制 canvas，避免直接修改旧状态 |
| `previewDataUrl` | 生成右侧长图预览 |
| `pixelDiff` | 比较两个像素差异 |
| `sampledDiff` | 抽样比较两块画面差异 |
| `sampledRowDiff` | 按行比较重叠区域差异 |
| `framesAreSimilar` | 判断这一帧是不是重复帧 |
| `fixedEdgeBands` | 排除顶部/底部固定栏干扰 |
| `findScrollMatch` | 找到新帧和旧长图的重叠位置 |
| `appendFrame` | 向下滚动时，把新内容拼到底部 |
| `prependFrame` | 向上滚动时，把新内容拼到顶部 |
| `fitImageFrame` | 完成后把长图等比放回屏幕可见区域 |

### 向下滚动和向上滚动不要写反

这是之前最容易出错的地方。

| 用户滚轮方向 | 真实含义 | 拼接方式 |
| --- | --- | --- |
| 向下滚动 | 看页面下面的新内容 | `appendFrame`，新增内容拼到长图底部 |
| 向上滚动 | 看页面上面的旧内容 | `prependFrame`，新增内容拼到长图顶部 |

如果你发现“下面的内容跑到了上面”，基本就是这里写反了。

## 第四步：搬 React state 和 ref

在 `src/app/overlay/page.tsx` 组件里，找到这些状态并搬到你的 overlay 组件中：

```ts
const [imageFrame, setImageFrame] = useState<Rect | null>(null);
const [scrollMode, setScrollMode] = useState(false);
const [scrollBusy, setScrollBusy] = useState(false);
const [scrollPreviewUrl, setScrollPreviewUrl] = useState<string | null>(null);
const [scrollProgress, setScrollProgress] = useState<ScrollProgress | null>(null);
```

还要搬这些 ref：

```ts
const selectionBeforeDragRef = useRef<Rect | null>(null);
const scrollSessionRef = useRef<ScrollSession | null>(null);
const scrollStepRunningRef = useRef(false);
const pendingScrollDeltaRef = useRef(0);
const pendingScrollFinishRef = useRef(false);
```

这些 ref 是为了处理滚轮连续触发。

不要每次滚轮都并发调用 Rust，否则会出现：

- 拼接顺序乱掉。
- 画面重复。
- 长图接缝错位。
- 程序看起来卡死。

当前实现是排队处理滚轮：如果上一帧还没采完，新的滚轮增量先记下来，等上一帧完成后再处理。

## 第五步：搬前端核心流程方法

继续在 `src/app/overlay/page.tsx`，找到并搬这些函数：

```ts
presentCapture
buildScrollRequest
cropInitialScrollFrame
startScrollCapture
stitchScrollFrame
takePendingScrollDelta
queueScrollCapture
runScrollCaptureStep
finishScrollCapture
cancelScrollCapture
handleWheel
```

### 每个方法到底干什么

| 方法 | 作用 |
| --- | --- |
| `presentCapture` | 把普通截图或长截图放进编辑状态 |
| `buildScrollRequest` | 根据当前选区生成 Rust 需要的参数 |
| `cropInitialScrollFrame` | 从最开始那张全屏截图里裁剪第一帧 |
| `startScrollCapture` | 进入长截图模式 |
| `stitchScrollFrame` | 把 Rust 返回的新帧拼到长图里 |
| `takePendingScrollDelta` | 取出排队中的滚轮距离 |
| `queueScrollCapture` | 收到滚轮后排队采集 |
| `runScrollCaptureStep` | 真正调用 Rust 采集一帧 |
| `finishScrollCapture` | 用户点击完成，把长图交给编辑画布 |
| `cancelScrollCapture` | 用户取消长截图，回到普通截图状态 |
| `handleWheel` | 长截图模式下拦截滚轮 |

### `handleWheel` 是长截图能不能滚的关键

你的 overlay 最外层要绑定：

```tsx
<main
  className={`overlay-root${scrollMode ? " scroll-mode" : ""}`}
  onWheel={handleWheel}
>
```

`handleWheel` 里必须做三件事：

1. 只在 `scrollMode === true` 时处理。
2. 判断鼠标是否在选区内。
3. 调用 `queueScrollCapture(event.deltaY)`。

同时它要 `preventDefault()`，因为滚轮的真实发送交给 Rust 来做。

## 第六步：搬工具栏按钮

普通截图工具栏里要加一个“长截图”按钮。

本项目用的是 `ScrollText` 图标：

```tsx
<button
  className="tool-icon"
  type="button"
  title="长截图"
  onClick={startScrollCapture}
>
  <ScrollText size={17} />
  <span>长截图</span>
</button>
```

进入长截图模式后，普通工具按钮要隐藏，只显示长截图控制按钮：

```tsx
{scrollMode ? (
  <div className="scroll-control">
    <button type="button" onClick={() => queueScrollCapture(0)}>
      补采一帧
    </button>
    <button type="button" onClick={finishScrollCapture}>
      完成长截图
    </button>
    <button type="button" onClick={cancelScrollCapture}>
      取消长截图
    </button>
  </div>
) : null}
```

这里有个细节：`补采一帧` 会调用 `queueScrollCapture(0)`，它不滚动，只重新采当前画面。用户慢慢滚动时，如果某一帧漏了，可以补一下。

## 第七步：搬长图实时预览

长截图模式下，用户需要看到当前拼出来的长图。

本项目在 overlay 里加了：

```tsx
{scrollMode && scrollPreviewUrl ? (
  <aside className="scroll-preview">
    <div className="scroll-preview-title">长截图预览</div>
    <div className="scroll-preview-meta">
      {scrollProgress?.frames ?? 1} 帧 · {scrollProgress?.width ?? 0} × {scrollProgress?.height ?? 0}
    </div>
    <img src={scrollPreviewUrl} alt="" />
  </aside>
) : null}
```

预览不是装饰，它是判断拼接是否正常的核心反馈。

如果你移植后发现拼接不对，第一眼就看这个预览。

## 第八步：搬 CSS

打开 `src/app/overlay/overlay.css`，搬这些样式块：

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

核心目标只有两个：

1. 长截图模式下，普通绘图工具不要抢操作。
2. 长图完成后，拼好的长图要作为一张图片放回编辑画布。

## 第九步：改 AnnotationCanvas

长截图完成后，画布里显示的不是原来的全屏截图，而是一张新生成的长图。

所以 `src/components/capture/AnnotationCanvas.tsx` 必须支持 `imageFrame`。

### 1. 给 props 加字段

```ts
imageFrame?: Rect | null;
```

### 2. 渲染截图图片时支持 framed 图片

长图完成后会被放在一个新的位置和尺寸里，所以图片元素要支持 `left/top/width/height`：

```tsx
<img
  className={`capture-image${imageFrame ? " framed" : ""}`}
  src={image}
  style={
    imageFrame
      ? {
          left: imageFrame.x,
          top: imageFrame.y,
          width: imageFrame.width,
          height: imageFrame.height,
        }
      : undefined
  }
/>
```

### 3. 导出时使用 imageFrame

普通截图导出的是选区。

长截图导出的是这张长图本身。

所以导出方法里要有类似逻辑：

```ts
const frame = imageFrame ?? {
  x: 0,
  y: 0,
  width: window.innerWidth,
  height: window.innerHeight,
};
```

如果你不改这里，会出现：

- 保存出来的图位置不对。
- 复制出来只有一部分。
- 绘制内容和底图错位。
- 完成长截图后工具栏不见了或无法继续编辑。

## 第十步：完成长截图时必须回到编辑态

`finishScrollCapture` 最后必须调用类似逻辑：

```ts
presentCapture(dataUrl, {
  imageFrame: fitImageFrame(session.canvas.width, session.canvas.height),
});
```

这样用户点完成后，应该看到：

1. 长图显示在屏幕可见区域内。
2. 普通截图工具栏重新出现。
3. 可以继续绘制。
4. 可以复制。
5. 可以保存。
6. 可以取消退出截图。

如果用户点完成后工具栏消失，说明你没有正确退出 `scrollMode`，或者没有用 `presentCapture` 重新进入编辑态。

## 最小移植顺序

照这个顺序搬，最不容易乱：

1. 先搬 Rust 的 `ScrollCaptureRequest`、`ScrollCaptureFrame`。
2. 再搬 Rust 的 `begin_scroll_capture` 和 `step_scroll_capture`。
3. 再搬 Rust 的辅助方法。
4. 注册 Tauri invoke handler。
5. 搬前端类型和图片工具方法。
6. 搬前端长截图 state/ref。
7. 搬 `startScrollCapture`、`handleWheel`、`queueScrollCapture`、`runScrollCaptureStep`。
8. 搬 `stitchScrollFrame`、`appendFrame`、`prependFrame`。
9. 搬 `finishScrollCapture` 和 `cancelScrollCapture`。
10. 搬 toolbar 按钮和 scroll preview。
11. 改 `AnnotationCanvas` 支持 `imageFrame`。
12. 最后搬 CSS。

每搬完一段就运行一次，不要一次性全搬完再调。

## 必测清单

移植后按下面顺序测试：

1. 普通截图还能启动。
2. 框选区域后，工具栏里能看到“长截图”。
3. 点击“长截图”后，截图窗口没有关闭。
4. 鼠标放到选区里，滚轮向下，真实页面能滚动。
5. 长图预览高度变大。
6. 向下滚动时，新内容拼到底部。
7. 向上滚动时，新内容拼到顶部。
8. 点击“补采一帧”不会乱拼重复内容。
9. 点击“完成长截图”后，普通工具栏回来。
10. 完成后可以画矩形、箭头、文字、Excalidraw。
11. 完成后可以复制。
12. 完成后可以保存。
13. 点击取消可以退出截图状态。
14. 多次进入长截图，不会复用上一次的旧画面。

## 常见问题排查

### 1. 长截图模式下完全滚不动

优先检查 `step_scroll_capture`。

必须满足：

- 它拿到了 `AppHandle`。
- 它调用了 `set_overlay_ignore_cursor(&app, true)`。
- 它调用了 `send_wheel_delta(scroll_delta_y)`。
- 采集结束后恢复 `set_overlay_ignore_cursor(&app, false)`。

如果漏了第一条或第二条，滚轮会被 overlay 吃掉。

### 2. 工具栏点不了

优先检查 `set_overlay_ignore_cursor` 是否恢复成 `false`。

临时穿透只能发生在 Rust 转发滚轮那一小段时间里，不能整个长截图期间都穿透。

### 3. 向下滚动没有拼到底部

检查 `stitchScrollFrame` 里对 `deltaY` 的判断。

通常：

```ts
if (deltaY >= 0) {
  appendFrame(...)
} else {
  prependFrame(...)
}
```

如果符号反了，长图顺序一定乱。

### 4. 向上滚动拼接处有乱像素

重点检查：

- `findScrollMatch` 是否按正确方向匹配。
- `prependFrame` 是否只把新增顶部内容拼进去。
- 有没有把固定标题栏、底部栏也算进相似度。

本项目的 `fixedEdgeBands` 就是为了减少固定栏干扰。

### 5. 拼了很多重复内容

检查 `framesAreSimilar`。

如果当前帧和上一帧几乎一样，就不要拼。

重复内容通常有三个原因：

- 页面其实没滚动成功。
- 滚动太少，新旧画面几乎一样。
- 相似度阈值太宽，误认为找到了重叠区域。

### 6. 拼接处很糊

通常是滚动还没停稳就截图了。

检查 Rust 的 `capture_stable_scroll_region`：

- 需要等待一小段时间。
- 需要连续比较几次画面。
- 画面差异足够小之后再返回。

不要滚轮刚发出去就立刻截图。

### 7. 完成长截图后不能绘制

检查 `finishScrollCapture` 是否调用了 `presentCapture`。

检查 `AnnotationCanvas` 是否支持 `imageFrame`。

长图完成后，它应该变成普通截图编辑态，而不是继续留在长截图模式。

### 8. 保存或复制出来的位置不对

检查 `AnnotationCanvas` 的导出逻辑。

导出时必须知道长图被显示在哪里，也就是 `imageFrame`。

### 9. 采集到了截图工具栏自己

说明采集时机或 overlay 穿透处理不对。

本项目的策略是：

- 第一帧优先从已有全屏截图里裁剪。
- 后续帧在 Rust 转发滚轮后采集选区区域。
- 长截图模式下普通工具栏隐藏，只保留控制条和预览。

### 10. 有些软件就是滚不动

少数窗口可能不接受模拟滚轮，或者权限级别不一致。

比如目标程序是管理员权限运行，而截图程序不是管理员权限，这时 Windows 可能会拦截输入。

测试时先用浏览器、资源管理器、普通文档窗口验证。

## 不建议一起移植的东西

这些不要一开始就做：

- 自动滚动。
- 滚动速度控制。
- 惯性滚动。
- 全页面智能识别。
- 多窗口跨应用滚动。

先把手动滚动做稳定，再考虑增强。

## 快速验收标准

只要满足下面 5 条，就说明移植基本成功：

1. 点击长截图后，选区里的真实页面可以被鼠标滚轮滚动。
2. 每次滚动后，右侧预览会同步变长。
3. 向下滚动不会把内容拼到上面。
4. 向上滚动不会把内容拼到下面。
5. 点完成后能继续绘制、复制、保存、取消。

这 5 条里第 1 条最重要。滚不动时不要先改拼接算法，先修 Rust 滚轮转发和 overlay 鼠标穿透。
