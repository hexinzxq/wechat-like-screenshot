# Excalidraw 绘图功能移植教程

这份文档只讲一件事：把本项目里的 Excalidraw 高级绘图能力，移植到另一个同样是 Tauri 2 + React + Next.js 的项目里。

你可以把它当成搬家清单。按顺序做，不需要先理解所有源码。

## 先说结论

最少需要搬这些东西：

```text
package.json 里的 @excalidraw/excalidraw 依赖
src/app/layout.tsx 里的 Excalidraw 样式导入
src/types/capture.ts 里的 AnnotationTool 增加 "excalidraw"
src/components/capture/ExcalidrawLayer.tsx
src/components/capture/AnnotationCanvas.tsx 里和 ExcalidrawLayer 相关的代码
src/app/overlay/overlay.css 里 .excalidraw-* 相关样式
src/app/overlay/page.tsx 里高级绘图按钮和工具栏定位逻辑
```

如果你只想最快跑起来，建议直接复制下面 3 个文件，再按文档改外层页面：

```text
src/components/capture/ExcalidrawLayer.tsx
src/components/capture/AnnotationCanvas.tsx
src/app/overlay/overlay.css
```

## 第 1 步：安装依赖

在你的新项目里执行：

```bash
npm install @excalidraw/excalidraw lucide-react
```

本项目当前用的是：

```json
"@excalidraw/excalidraw": "^0.18.1",
"lucide-react": "^0.468.0"
```

`lucide-react` 是工具栏图标库。如果你自己的项目已经有图标库，也可以把图标替换掉。

## 第 2 步：导入 Excalidraw 官方样式

打开你的：

```text
src/app/layout.tsx
```

加上这一行：

```tsx
import "@excalidraw/excalidraw/index.css";
```

推荐放在全局样式前面：

```tsx
import type { Metadata } from "next";
import "@excalidraw/excalidraw/index.css";
import "./globals.css";
```

不加这一行，Excalidraw 可能能渲染出来，但按钮、画布、文字、布局会乱。

## 第 3 步：复制 ExcalidrawLayer

把这个文件复制到你的项目：

```text
src/components/capture/ExcalidrawLayer.tsx
```

这个文件是 Excalidraw 的核心封装。它做了这些事：

- 用 `next/dynamic` 动态加载 Excalidraw，避免 Next.js 服务端渲染报错。
- 把 Excalidraw 限制在截图选区里面。
- 自己做一条简单工具栏，放矩形、菱形、圆形、箭头、直线、画笔、文字、橡皮。
- 隐藏 Excalidraw 原生 library、菜单、帮助图标、撤销重做按钮。
- 让绘图工具画完以后不要自动跳回选择工具。
- 暴露 `exportDrawing()`，让外层可以把 Excalidraw 内容合成到最终截图。
- 暴露 `undo()`、`clear()`，让截图工具栏的撤销和清空按钮可以控制 Excalidraw。

### 这个文件最重要的 ref 方法

```ts
export type ExcalidrawLayerHandle = {
  exportDrawing: () => Promise<{ canvas: HTMLCanvasElement; x: number; y: number } | null>;
  clear: () => void;
  undo: () => boolean;
  hasElements: () => boolean;
};
```

你只要记住：

- `exportDrawing()`：导出 Excalidraw 画出来的内容。
- `undo()`：撤销 Excalidraw 最后一个元素。
- `clear()`：清空 Excalidraw 所有内容。
- `hasElements()`：判断有没有 Excalidraw 内容。

## 第 4 步：你的类型里加上 excalidraw 工具

打开：

```text
src/types/capture.ts
```

找到 `AnnotationTool`，加上 `"excalidraw"`：

```ts
export type AnnotationTool =
  | "select"
  | "rect"
  | "ellipse"
  | "arrow"
  | "pen"
  | "text"
  | "excalidraw";
```

如果你的项目没有这个类型，就新建一个类似类型也行，关键是外层页面需要有一个 `tool` 状态能保存 `"excalidraw"`。

## 第 5 步：把 ExcalidrawLayer 接进 AnnotationCanvas

打开：

```text
src/components/capture/AnnotationCanvas.tsx
```

### 5.1 引入组件和类型

```tsx
import { ExcalidrawLayer, type ExcalidrawLayerHandle } from "./ExcalidrawLayer";
```

### 5.2 增加 toolbarPlacement 类型

```ts
type ToolbarPlacement = {
  left: number;
  top: number;
  width: number;
  height: number;
};
```

### 5.3 Props 增加 excalidrawToolbar

```ts
type Props = {
  image: HTMLImageElement | null;
  imageDataUrl: string;
  showImage?: boolean;
  selection: Rect | null;
  tool: AnnotationTool;
  color: string;
  lineWidth: number;
  onTextPoint: (point: Point) => void;
  excalidrawToolbar?: ToolbarPlacement | null;
};
```

### 5.4 组件里创建 ref

```tsx
const excalidrawRef = useRef<ExcalidrawLayerHandle | null>(null);
```

### 5.5 普通 canvas 绘图时，跳过 Excalidraw 工具

你的普通绘图 canvas 应该有类似 `handlePointerDown` 的方法。里面加上这个判断：

```tsx
if (!selection || tool === "select" || tool === "excalidraw") return;
```

意思是：当用户选择高级绘图时，鼠标事件交给 Excalidraw，不要让普通 canvas 抢事件。

### 5.6 导出截图时，把 Excalidraw 画的东西合成进去

在 `exportSelection()` 里，普通标注画完之后，加上这段：

```tsx
const excalidrawDrawing = await excalidrawRef.current?.exportDrawing();
if (excalidrawDrawing) {
  ctx.drawImage(
    excalidrawDrawing.canvas,
    Math.round((excalidrawDrawing.x - clipped.x) * scaleX),
    Math.round((excalidrawDrawing.y - clipped.y) * scaleY),
    Math.round(excalidrawDrawing.canvas.width * scaleX),
    Math.round(excalidrawDrawing.canvas.height * scaleY)
  );
}
```

这段代码很重要。没有它，用户能看到 Excalidraw 画出来了，但复制/保存出来的图片里没有 Excalidraw 内容。

### 5.7 撤销和清空要带上 Excalidraw

`undo()` 建议这样写：

```tsx
undo() {
  if (tool === "excalidraw" && excalidrawRef.current?.undo()) {
    return;
  }
  if (!shapes.length && excalidrawRef.current?.undo()) {
    return;
  }
  setShapes((items) => items.slice(0, -1));
}
```

含义很简单：

- 当前就是 Excalidraw 工具时，优先撤销 Excalidraw。
- 普通标注没有内容时，也尝试撤销 Excalidraw。
- 否则撤销普通标注。

`clear()` 建议这样写：

```tsx
clear() {
  setShapes([]);
  excalidrawRef.current?.clear();
}
```

### 5.8 在 JSX 里挂上 ExcalidrawLayer

放在普通 `<canvas />` 后面：

```tsx
<ExcalidrawLayer
  ref={excalidrawRef}
  active={tool === "excalidraw"}
  selection={selection}
  toolbarPlacement={excalidrawToolbar}
/>
```

注意：`selection` 必须传当前截图选区。Excalidraw 的画布会按这个选区定位。

## 第 6 步：外层页面加高级绘图按钮

打开你的截图浮层页面，比如：

```text
src/app/overlay/page.tsx
```

### 6.1 tool 状态必须支持 excalidraw

```tsx
const [tool, setTool] = useState<AnnotationTool>("select");
```

### 6.2 工具栏里加按钮

```tsx
<button
  className={tool === "excalidraw" ? "active" : ""}
  title="高级绘图"
  onClick={() => setTool("excalidraw")}
>
  <Shapes size={17} />
</button>
```

记得导入图标：

```tsx
import { Shapes } from "lucide-react";
```

### 6.3 给 Excalidraw 工具栏计算位置

本项目是把 Excalidraw 工具栏放在截图工具栏下面，避免互相挡住。

你需要准备这几个常量：

```ts
const SCREEN_EDGE_GAP = 8;
const SELECTION_TOOLBAR_GAP = 8;
const TOOLBAR_STACK_GAP = 6;
const CAPTURE_TOOLBAR_HEIGHT = 52;
const EXCALIDRAW_TOOLBAR_WIDTH = 480;
const EXCALIDRAW_TOOLBAR_HEIGHT = 58;
```

再准备工具栏布局类型：

```ts
type ToolbarPlacement = {
  left: number;
  top: number;
  width: number;
  height: number;
};

type ToolbarLayout = {
  captureStyle: CSSProperties;
  excalidrawToolbar: ToolbarPlacement | null;
};
```

然后照着本项目的 `toolbarLayout` 逻辑搬：

```tsx
const toolbarLayout = useMemo<ToolbarLayout | undefined>(() => {
  if (!selection) return undefined;
  const captureToolbarWidth = 640;
  const hasExcalidrawToolbar = tool === "excalidraw";
  const stackWidth = Math.max(captureToolbarWidth, hasExcalidrawToolbar ? EXCALIDRAW_TOOLBAR_WIDTH : 0);
  const stackHeight =
    CAPTURE_TOOLBAR_HEIGHT +
    (hasExcalidrawToolbar ? TOOLBAR_STACK_GAP + EXCALIDRAW_TOOLBAR_HEIGHT : 0);
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const spaceAbove = selection.y;
  const spaceBelow = viewportHeight - selection.y - selection.height;
  const preferBelow = spaceBelow >= stackHeight + SELECTION_TOOLBAR_GAP || spaceBelow >= spaceAbove;
  const rawStackTop = preferBelow
    ? selection.y + selection.height + SELECTION_TOOLBAR_GAP
    : selection.y - stackHeight - SELECTION_TOOLBAR_GAP;
  const maxStackTop = Math.max(SCREEN_EDGE_GAP, viewportHeight - stackHeight - SCREEN_EDGE_GAP);
  const stackTop = clamp(rawStackTop, SCREEN_EDGE_GAP, maxStackTop);
  const centerX = selection.x + selection.width / 2;
  const maxStackLeft = Math.max(SCREEN_EDGE_GAP, viewportWidth - stackWidth - SCREEN_EDGE_GAP);
  const stackLeft = clamp(centerX - stackWidth / 2, SCREEN_EDGE_GAP, maxStackLeft);
  const captureLeft = stackLeft + (stackWidth - captureToolbarWidth) / 2;
  const excalidrawLeft = stackLeft + (stackWidth - EXCALIDRAW_TOOLBAR_WIDTH) / 2;

  return {
    captureStyle: {
      left: Math.round(captureLeft),
      top: Math.round(stackTop)
    },
    excalidrawToolbar: hasExcalidrawToolbar
      ? {
          left: Math.round(excalidrawLeft),
          top: Math.round(stackTop + CAPTURE_TOOLBAR_HEIGHT + TOOLBAR_STACK_GAP),
          width: EXCALIDRAW_TOOLBAR_WIDTH,
          height: EXCALIDRAW_TOOLBAR_HEIGHT
        }
      : null
  };
}, [selection, tool]);
```

这个逻辑的作用：

- 工具栏优先放在选区下面。
- 下面放不下就放上面。
- 左右不能跑出屏幕。
- Excalidraw 工具栏始终跟截图工具栏成一组，不会压到选区里。

### 6.4 传给 AnnotationCanvas

```tsx
<AnnotationCanvas
  ref={canvasRef}
  image={image}
  imageDataUrl={capture.imageDataUrl}
  showImage
  selection={selection}
  tool={tool}
  color={color}
  lineWidth={lineWidth}
  onTextPoint={(textPoint) => {
    commitTextDraft();
    setTextDraft({ x: textPoint.x, y: textPoint.y, value: "" });
  }}
  excalidrawToolbar={toolbarLayout?.excalidrawToolbar ?? null}
/>
```

## 第 7 步：复制 CSS

从本项目的：

```text
src/app/overlay/overlay.css
```

复制这些样式到你的截图浮层 CSS：

```text
.excalidraw-layer
.excalidraw-layer.active
.excalidraw-layer *
.excalidraw-layer .excalidraw
.excalidraw-layer.active .App-toolbar
.excalidraw-tool-strip
.excalidraw-tool-strip button
.excalidraw-context-menu
.excalidraw-context-menu button
.excalidraw-layer [aria-label*="library" i]
.excalidraw-layer [aria-label="Menu"]
.excalidraw-layer:not(.active) [class*="layer-ui"]
.excalidraw-loading
```

最关键的是这几类：

### 7.1 让 Excalidraw 只在选区里接收鼠标

```css
.excalidraw-layer {
  position: absolute;
  z-index: 6;
  overflow: visible;
  pointer-events: none;
}

.excalidraw-layer.active {
  pointer-events: auto;
}
```

没有这个，可能会出现：

- 没选高级绘图时，Excalidraw 抢走普通截图框选事件。
- 点普通工具栏没反应。
- 鼠标拖动不画图。

### 7.2 隐藏 Excalidraw 原生工具栏

```css
.excalidraw-layer.active .App-toolbar {
  display: none !important;
}
```

本项目自己做了 `excalidraw-tool-strip`，所以不显示原生工具栏。

### 7.3 隐藏 library、菜单、help

```css
.excalidraw-layer [aria-label*="library" i],
.excalidraw-layer [title*="library" i],
.excalidraw-layer [data-testid*="library" i],
.excalidraw-layer .library-button,
.excalidraw-layer .LibraryMenu,
.excalidraw-layer .LibraryMenuItems {
  display: none !important;
}
```

菜单和帮助图标同理。本项目已经写好，可以直接复制。

### 7.4 工具栏必须高 z-index

```css
.excalidraw-tool-strip {
  position: fixed;
  z-index: 12;
  pointer-events: auto;
}
```

如果 z-index 太低，会被截图遮罩、选区框、Excalidraw canvas 盖住，表现就是工具栏点不了。

## 第 8 步：右键菜单汉化

本项目没有使用 Excalidraw 原生右键菜单，而是在 `ExcalidrawLayer.tsx` 里自己做了一个：

```tsx
<div className="excalidraw-context-menu">
  <button type="button" onClick={() => setExcalidrawTool(EXCALIDRAW_TOOLS[0])}>
    选择工具
  </button>
  <button type="button" onClick={undoExcalidraw}>
    撤销上一步
  </button>
  <button type="button" onClick={deleteSelectedElements}>
    删除选中
  </button>
  <button type="button" onClick={() => setContextMenu(null)}>
    关闭菜单
  </button>
  <button type="button" className="danger" onClick={...}>
    清空绘图
  </button>
</div>
```

如果你复制过去后中文乱码，优先检查文件编码，确保文件是 UTF-8。

## 第 9 步：保存和复制时怎么拿最终图片

外层页面不要直接找 Excalidraw DOM 截图。

正确方式是只调用：

```tsx
const dataUrl = await canvasRef.current?.exportSelection();
```

因为 `AnnotationCanvas.exportSelection()` 已经做了三件事：

1. 截取选区内的底图。
2. 合成普通矩形、圆形、箭头、画笔、文字。
3. 合成 Excalidraw 的绘制内容。

拿到的 `dataUrl` 就是最终图片：

```text
data:image/png;base64,...
```

你的保存按钮、复制按钮都应该用这个结果。

## 第 10 步：最小可跑示例

外层页面大概长这样：

```tsx
const [tool, setTool] = useState<AnnotationTool>("select");
const [selection, setSelection] = useState<Rect | null>(null);
const [color, setColor] = useState("#ff4d4f");
const [lineWidth, setLineWidth] = useState(3);
const canvasRef = useRef<AnnotationCanvasHandle | null>(null);

async function save() {
  const dataUrl = await canvasRef.current?.exportSelection();
  if (!dataUrl) return;
  // 这里写你的保存逻辑
}

return (
  <>
    <AnnotationCanvas
      ref={canvasRef}
      image={image}
      imageDataUrl={imageDataUrl}
      showImage
      selection={selection}
      tool={tool}
      color={color}
      lineWidth={lineWidth}
      onTextPoint={(point) => {
        // 这里显示文字输入框
      }}
      excalidrawToolbar={toolbarLayout?.excalidrawToolbar ?? null}
    />

    <button onClick={() => setTool("excalidraw")}>高级绘图</button>
    <button onClick={() => canvasRef.current?.undo()}>撤销</button>
    <button onClick={() => canvasRef.current?.clear()}>清空</button>
    <button onClick={save}>保存</button>
  </>
);
```

## 常见问题

### 1. 点了 Excalidraw 工具，但拖动不画图

优先检查：

- `.excalidraw-layer.active { pointer-events: auto; }` 有没有。
- 普通 canvas 的 `handlePointerDown` 有没有在 `tool === "excalidraw"` 时 return。
- Excalidraw 外层是不是被别的遮罩盖住了。
- 工具栏按钮有没有 `event.stopPropagation()`。

### 2. 画一个图形后，工具自动跳回选择工具

检查 `ExcalidrawLayer.tsx` 里的这几个方法有没有完整复制：

```text
rememberDrawingTool()
keepDrawingToolLocked()
setExcalidrawTool()
```

另外，`EXCALIDRAW_TOOLS` 里的绘图工具要设置：

```ts
locked: true
```

### 3. 工具栏点不了

一般是 CSS 层级或事件问题：

- `.excalidraw-tool-strip` 要 `position: fixed`。
- `.excalidraw-tool-strip` 要 `z-index: 12` 或更高。
- `.excalidraw-tool-strip` 要 `pointer-events: auto`。
- 工具栏事件要 `stopPropagation()`，避免触发外层截图框选。

### 4. 保存出来没有 Excalidraw 内容

检查 `AnnotationCanvas.exportSelection()` 里有没有调用：

```tsx
const excalidrawDrawing = await excalidrawRef.current?.exportDrawing();
```

并且有没有 `ctx.drawImage(excalidrawDrawing.canvas, ...)`。

### 5. Excalidraw 跑到选区外面了

检查 JSX：

```tsx
<ExcalidrawLayer selection={selection} />
```

以及 `.excalidraw-layer` 是否用的是：

```tsx
style={{
  left: selection.x,
  top: selection.y,
  width: selection.width,
  height: selection.height
}}
```

### 6. 工具栏挡住选区，选区太小时没法画

不要把 Excalidraw 工具栏放在选区里面。参考本项目 `page.tsx` 的 `toolbarLayout`，把截图工具栏和 Excalidraw 工具栏作为一组，动态放到选区上方或下方。

### 7. Next.js 报 window/document 不存在

Excalidraw 必须动态导入：

```tsx
const Excalidraw = dynamic(
  async () => {
    const module = await import("@excalidraw/excalidraw");
    return module.Excalidraw;
  },
  { ssr: false }
);
```

不要在服务端直接 import 渲染组件。

## 最推荐的移植顺序

按这个顺序来，最不容易乱：

1. 安装 `@excalidraw/excalidraw`。
2. 在 `layout.tsx` 导入 `@excalidraw/excalidraw/index.css`。
3. 复制 `ExcalidrawLayer.tsx`。
4. 给 `AnnotationTool` 加 `"excalidraw"`。
5. 把 `ExcalidrawLayer` 接进 `AnnotationCanvas.tsx`。
6. 在 `exportSelection()` 里合成 Excalidraw 画布。
7. 在外层页面加高级绘图按钮。
8. 复制 `.excalidraw-*` CSS。
9. 启动项目，先测试“能不能拖动绘制”。
10. 再测试撤销、清空、保存、复制。

## 快速验收清单

移植完以后，逐项检查：

- 能打开截图浮层。
- 能框选区域。
- 点“高级绘图”后，Excalidraw 工具栏出现。
- 选择矩形后，鼠标按下拖动能画矩形。
- 画完矩形后，工具不会自动跳回选择工具。
- 选择箭头、圆形、画笔、文字都能画。
- 截图工具栏的撤销能撤销 Excalidraw 内容。
- 清空按钮能清空 Excalidraw 内容。
- 复制/保存出来的图片包含 Excalidraw 内容。
- 选区很小时，工具栏不会压在选区里，也不会跑出屏幕。

完成这些，Excalidraw 迁移就算基本成功。
