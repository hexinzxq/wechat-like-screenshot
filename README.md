# 截图绘图功能移植说明

如果你只想移植 Excalidraw 高级绘图能力，请看：[Excalidraw 绘图功能移植教程](docs/excalidraw-migration-guide.md)。

如果你要移植长截图能力，请看：[长截图功能移植教程](docs/scroll-screenshot-migration-guide.md)。

如果你要了解 Windows 安装包如何处理 WebView2 Runtime，请看：[Windows WebView2 打包到安装包说明](docs/windows-webview2-bundling-guide.md)。

如果你要了解如何最终打出 Windows 安装程序版安装包，请看：[Windows 安装程序版打包流程](docs/windows-installer-packaging-guide.md)。

这份说明只讲一件事：如果你想把本项目里的截图标注/绘图功能移植到别的 React 项目里，应该拷哪些文件、看哪些方法、怎么最快跑起来。

项目整体是 Tauri + Next.js + React，但绘图功能本身主要在前端，和 Tauri 的关系不大。你要移植绘图能力时，优先看 `src/components/capture/AnnotationCanvas.tsx` 和 `src/app/overlay/page.tsx`。

## 先拷这些文件

最少需要拷这几个：

```text
src/components/capture/AnnotationCanvas.tsx
src/types/capture.ts
src/lib/image.ts
```

如果你想连同工具栏、选区、文字输入框、保存/复制按钮的交互一起搬走，再拷：

```text
src/app/overlay/page.tsx
src/app/overlay/overlay.css
```

## 每个文件是干什么的

### `src/types/capture.ts`

这里放绘图相关类型。

重点类型：

```ts
Rect
```

表示截图选区：

```ts
{
  x: number;
  y: number;
  width: number;
  height: number;
}
```

注意：这里的 `x/y` 是浏览器视口里的坐标，不是原始图片像素坐标。

```ts
AnnotationTool
```

表示当前工具：

```ts
"select" | "rect" | "ellipse" | "arrow" | "pen" | "text"
```

```ts
AnnotationShape
```

表示已经画上去的内容。矩形、圆形、箭头、画笔用 `points`，文字用 `x/y/text/fontSize`。

### `src/lib/image.ts`

这里是小工具函数。

重点方法：

```ts
normalizeRect(x1, y1, x2, y2)
```

把鼠标拖拽的起点和终点转换成标准矩形。比如你从右下往左上拖，它也会自动算出正确的 `x/y/width/height`。

```ts
clamp(value, min, max)
```

限制数值范围。绘图时用它把鼠标坐标限制在选区内部。

```ts
dataUrlToBase64(dataUrl)
```

把 `data:image/png;base64,...` 去掉前缀，只保留 base64。只有你要传给后端保存/复制时才需要。

## 核心组件：`AnnotationCanvas.tsx`

这是最重要的文件。它负责：

- 显示截图底图
- 在选区里绘制矩形、圆形、箭头、画笔
- 保存绘制记录
- 撤销
- 清空
- 导出最终图片
- 接收外部传入的文字并画到 canvas 上

### 组件需要的 props

```tsx
<AnnotationCanvas
  ref={canvasRef}
  image={image}
  imageDataUrl={capture.imageDataUrl}
  selection={selection}
  tool={tool}
  color={color}
  lineWidth={lineWidth}
  onTextPoint={(point) => {
    // 用户选择文字工具后，点击选区时会触发这里
  }}
/>
```

每个参数的意思：

```ts
image
```

已经加载好的 `HTMLImageElement`。导出截图时需要用它的 `naturalWidth/naturalHeight` 计算真实像素。

```ts
imageDataUrl
```

截图图片地址，通常是 `data:image/jpeg;base64,...` 或 `data:image/png;base64,...`。

```ts
selection
```

当前选区。没有选区时传 `null`。

```ts
tool
```

当前工具。比如 `"rect"` 画矩形，`"arrow"` 画箭头，`"text"` 输入文字。

```ts
color
```

当前颜色。

```ts
lineWidth
```

当前线宽。

```ts
onTextPoint
```

文字工具专用。用户选中文字工具后，在选区里点一下，组件不会自己创建输入框，而是把点击坐标传出去。外层页面负责显示输入框。

这样做的好处是：文字输入框不容易被 canvas 重绘干掉，移植到别的项目也更稳。

## 组件暴露的方法

`AnnotationCanvas` 用 `ref` 暴露了几个方法。

先声明：

```tsx
const canvasRef = useRef<AnnotationCanvasHandle | null>(null);
```

### `exportSelection()`

```ts
const dataUrl = canvasRef.current?.exportSelection();
```

导出当前选区内的图片，包含截图底图和所有绘制内容。

返回值是：

```ts
data:image/png;base64,...
```

你可以拿它：

- 放到 `<img src={dataUrl} />`
- 下载成本地图片
- 传给后端保存
- 写入剪贴板

这个方法里面已经处理了 DPI/缩放问题：

```ts
const scaleX = image.naturalWidth / window.innerWidth;
const scaleY = image.naturalHeight / window.innerHeight;
```

所以用户看到的选区，和最后导出的真实图片区域能对上。

### `addText()`

```ts
canvasRef.current?.addText({
  x,
  y,
  text: "说明文字",
  color,
  lineWidth
});
```

把一段文字正式加入绘制内容。

外层页面一般这么用：

1. 用户点击文字工具
2. 用户点击选区里的某个位置
3. `AnnotationCanvas` 触发 `onTextPoint(point)`
4. 外层页面在 `point.x / point.y` 创建 `<input>`
5. 用户输入文字
6. 回车或失焦时调用 `addText()`

### `undo()`

```ts
canvasRef.current?.undo();
```

撤销最后一步绘制。

### `clear()`

```ts
canvasRef.current?.clear();
```

清空所有绘制内容。

如果用户重新框选了一个新区域，建议立刻调用这个方法，不然上一个选区画的东西会残留。

## 外层页面：`overlay/page.tsx`

这个文件不是纯绘图组件，而是一个完整截图页面示例。它包含：

- 截图图片加载
- 鼠标框选区域
- 工具栏
- 颜色选择
- 线宽选择
- 文字输入框
- 保存/复制/取消
- 重新框选时清空旧绘制

如果你只想移植绘图组件，可以不完整拷它。但如果你想快速做一个类似微信截图的交互，建议直接看这个文件。

### 选区相关方法

```ts
beginSelect()
moveSelect()
endSelect()
```

这三个方法负责鼠标拖拽框选。

关键点：

```ts
setSelection(normalizeRect(dragStart.x, dragStart.y, current.x, current.y));
```

不要自己手写宽高计算，直接用 `normalizeRect()`，能避免从右往左拖时选区错乱。

### 重新框选时清空绘制

在 `beginSelect()` 里有这句：

```ts
canvasRef.current?.clear();
```

意思是：只要用户开始重新框选，就清掉上一个选区里的绘制内容。

如果你移植后发现“上一个选区画的东西还在”，就检查你有没有加这句。

### 文字输入相关逻辑

外层页面里维护：

```ts
const [textDraft, setTextDraft] = useState<{
  x: number;
  y: number;
  value: string;
} | null>(null);
```

当 `AnnotationCanvas` 触发：

```ts
onTextPoint={(textPoint) => {
  commitTextDraft();
  setTextDraft({ x: textPoint.x, y: textPoint.y, value: "" });
}}
```

页面会在这个位置显示输入框：

```tsx
{textDraft && (
  <input
    ref={textInputRef}
    className="text-draft"
    style={{ left: textDraft.x, top: textDraft.y, color }}
    value={textDraft.value}
    onChange={(event) => setTextDraft({ ...textDraft, value: event.target.value })}
    onBlur={commitTextDraft}
    onKeyDown={(event) => {
      if (event.key === "Enter") commitTextDraft();
      if (event.key === "Escape") setTextDraft(null);
    }}
  />
)}
```

文字提交时调用：

```ts
canvasRef.current?.addText({
  x: textDraft.x,
  y: textDraft.y,
  text: value,
  color,
  lineWidth
});
```

### 保存/复制前先提交文字

保存和复制前都有：

```ts
commitTextDraft();
await new Promise((resolve) => window.requestAnimationFrame(resolve));
```

这两句很重要。

如果用户正在输入文字，还没有按回车，直接点保存，文字可能还没进入 canvas。先 `commitTextDraft()`，再等一帧，确保文字已经画进去，再 `exportSelection()`。

## CSS 必须一起带走的部分

如果你拷 `overlay/page.tsx`，也要拷 `overlay.css`。

尤其是这些 class：

```css
.capture-image
.annotation-canvas
.selection-box
.toolbar
.text-draft
.mask
```

最关键的是层级：

```css
.annotation-canvas {
  z-index: 4;
}

.selection-box {
  z-index: 5;
}

.toolbar {
  z-index: 8;
}

.text-draft {
  z-index: 9;
}
```

文字输入框必须比 canvas 和工具栏层级更高，否则会点不到或看不见。

## 最小移植步骤

### 第一步：拷文件

拷：

```text
src/components/capture/AnnotationCanvas.tsx
src/types/capture.ts
src/lib/image.ts
```

如果要完整截图页，再拷：

```text
src/app/overlay/page.tsx
src/app/overlay/overlay.css
```

### 第二步：修路径别名

本项目用了：

```ts
@/types/capture
@/lib/image
```

如果你的项目没有 `@` 别名，要改成相对路径，例如：

```ts
../../types/capture
../../lib/image
```

或者在你的 `tsconfig.json` 里配置：

```json
{
  "compilerOptions": {
    "paths": {
      "@/*": ["./src/*"]
    }
  }
}
```

### 第三步：准备截图图片

你需要给组件一张图片：

```ts
const img = new Image();
img.onload = () => setImage(img);
img.src = imageDataUrl;
```

然后传给组件：

```tsx
<AnnotationCanvas
  image={image}
  imageDataUrl={imageDataUrl}
  selection={selection}
  tool={tool}
  color={color}
  lineWidth={lineWidth}
  onTextPoint={...}
/>
```

### 第四步：做工具栏

工具栏本质就是改这些状态：

```ts
setTool("rect");
setTool("ellipse");
setTool("arrow");
setTool("pen");
setTool("text");
setColor("#ff4d4f");
setLineWidth(3);
```

不需要调用 canvas 内部方法。

只有撤销、清空、保存时才用 ref：

```ts
canvasRef.current?.undo();
canvasRef.current?.clear();
canvasRef.current?.exportSelection();
```

## 最容易踩坑的地方

### 坑 1：文字工具点了没反应

检查三件事：

1. `AnnotationCanvas` 是否传了 `onTextPoint`
2. 外层页面是否渲染了 `.text-draft` 输入框
3. `.text-draft` 的 `z-index` 是否比 canvas 高

### 坑 2：重新选区后旧绘制还在

在开始重新框选时调用：

```ts
canvasRef.current?.clear();
```

### 坑 3：导出的图和看到的选区对不上

不要直接用 `selection.x/y/width/height` 去裁原图。

必须按图片真实尺寸换算：

```ts
const scaleX = image.naturalWidth / window.innerWidth;
const scaleY = image.naturalHeight / window.innerHeight;
```

`AnnotationCanvas.exportSelection()` 已经处理好了，建议直接用它。

### 坑 4：保存时正在输入的文字丢失

保存前先：

```ts
commitTextDraft();
await new Promise((resolve) => window.requestAnimationFrame(resolve));
```

再：

```ts
canvasRef.current?.exportSelection();
```

### 坑 5：工具栏点击导致重新框选

工具栏要阻止事件冒泡：

```tsx
onPointerDown={(event) => event.stopPropagation()}
onPointerUp={(event) => event.stopPropagation()}
```

否则点工具栏时，外层选区容器可能会以为你又开始框选了。

## 只想要绘图，不要截图怎么办

可以。

你只需要把任意图片当成底图传进去：

```tsx
<AnnotationCanvas
  image={image}
  imageDataUrl="/demo.png"
  selection={{ x: 0, y: 0, width: window.innerWidth, height: window.innerHeight }}
  tool={tool}
  color={color}
  lineWidth={lineWidth}
  onTextPoint={handleTextPoint}
/>
```

也就是说，这个组件不关心图片是不是屏幕截图。它只关心：

- 有一张图片
- 有一个选区
- 当前是什么工具
- 当前颜色和线宽是多少

## 推荐迁移顺序

最稳的顺序是：

1. 先拷 `capture.ts` 和 `image.ts`
2. 再拷 `AnnotationCanvas.tsx`
3. 在你的页面里先把一张固定图片显示出来
4. 写死一个全屏 `selection`
5. 测试矩形、圆形、箭头、画笔
6. 再接入你自己的选区逻辑
7. 最后再接文字输入和保存/复制

不要一上来就把截图、托盘、快捷键、保存、复制全搬过去。先让绘图组件在普通页面里跑通，后面会轻松很多。
