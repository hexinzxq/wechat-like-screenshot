"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  ArrowUpRight,
  Circle,
  Clipboard,
  Diamond,
  Eraser,
  MousePointer2,
  PenLine,
  RectangleHorizontal,
  Save,
  Shapes,
  Type,
  Undo2,
  X
} from "lucide-react";
import { AnnotationCanvas, type AnnotationCanvasHandle } from "@/components/capture/AnnotationCanvas";
import { dataUrlToBase64, normalizeRect } from "@/lib/image";
import type { AnnotationTool, CapturePayload, Rect } from "@/types/capture";
import "./overlay.css";

const COLORS = ["#ff4d4f", "#32d296", "#ffd166", "#55a8ff", "#ffffff"];

const SCREEN_EDGE_GAP = 8;
const SELECTION_TOOLBAR_GAP = 8;
const TOOLBAR_STACK_GAP = 6;
const CAPTURE_TOOLBAR_HEIGHT = 52;
const EXCALIDRAW_TOOLBAR_WIDTH = 480;
const EXCALIDRAW_TOOLBAR_HEIGHT = 58;

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

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function insideRect(point: { x: number; y: number }, rect: Rect) {
  return (
    point.x >= rect.x &&
    point.y >= rect.y &&
    point.x <= rect.x + rect.width &&
    point.y <= rect.y + rect.height
  );
}

export default function OverlayPage() {
  const [capture, setCapture] = useState<CapturePayload | null>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [selection, setSelection] = useState<Rect | null>(null);
  const [hoverWindow, setHoverWindow] = useState<Rect | null>(null);
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
  const [tool, setTool] = useState<AnnotationTool>("select");
  const [color, setColor] = useState(COLORS[0]);
  const [lineWidth, setLineWidth] = useState(3);
  const [notice, setNotice] = useState("");
  const [textDraft, setTextDraft] = useState<{ x: number; y: number; value: string } | null>(null);
  const canvasRef = useRef<AnnotationCanvasHandle | null>(null);
  const textInputRef = useRef<HTMLInputElement | null>(null);
  const clickWindowRef = useRef<Rect | null>(null);

  async function lockWindow(payload = capture) {
    if (!payload) return;
    await invoke("lock_overlay_window", {
      width: payload.width,
      height: payload.height,
      originX: payload.originX,
      originY: payload.originY
    }).catch(() => undefined);
  }

  useEffect(() => {
    if (!textDraft) return;
    window.requestAnimationFrame(() => textInputRef.current?.focus());
  }, [textDraft]);

  async function presentCapture(payload: CapturePayload) {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("图片加载失败"));
      img.src = payload.imageDataUrl;
    });

    setCapture(payload);
    setImage(img);
    setSelection(null);
    setHoverWindow(null);
    setDragStart(null);
    clickWindowRef.current = null;
    setTool("select");
    setTextDraft(null);
    setNotice("");
    canvasRef.current?.clear();

    const win = getCurrentWebviewWindow();
    await win.show();
    await win.setFocus();
    await lockWindow(payload);
  }

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<CapturePayload>("capture-ready", async (event) => {
      await presentCapture(event.payload);
    }).then((dispose) => {
      unlisten = dispose;
      invoke<CapturePayload | null>("take_pending_capture")
        .then((payload) => {
          if (payload) void presentCapture(payload);
        })
        .catch(() => undefined);
    });
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    function escape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        void closeOverlay();
      }
    }
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, []);

  const toolbarLayout = useMemo<ToolbarLayout | undefined>(() => {
    if (!selection) return undefined;
    const captureToolbarWidth = 720;
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

  function point(event: React.PointerEvent<HTMLDivElement>) {
    return { x: event.clientX, y: event.clientY };
  }

  function viewportWindowRect(rect: Rect): Rect | null {
    if (!capture) return null;
    const scaleX = window.innerWidth / Math.max(1, capture.width);
    const scaleY = window.innerHeight / Math.max(1, capture.height);
    const x = Math.round(rect.x * scaleX);
    const y = Math.round(rect.y * scaleY);
    const width = Math.round(rect.width * scaleX);
    const height = Math.round(rect.height * scaleY);
    if (width < 12 || height < 12) return null;
    return {
      x: Math.max(0, x),
      y: Math.max(0, y),
      width: Math.min(window.innerWidth - Math.max(0, x), width),
      height: Math.min(window.innerHeight - Math.max(0, y), height)
    };
  }

  function windowCandidateAt(current: { x: number; y: number }) {
    if (!capture?.windows?.length || selection || dragStart || tool !== "select") {
      return null;
    }

    return (
      capture.windows
        .map(viewportWindowRect)
        .filter((rect): rect is Rect => rect !== null)
        .filter((rect) => insideRect(current, rect))
        .sort((a, b) => a.width * a.height - b.width * b.height)[0] ?? null
    );
  }

  function beginSelect(event: React.PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    if (tool !== "select") return;
    const current = point(event);
    void lockWindow();
    canvasRef.current?.clear();
    setTextDraft(null);
    clickWindowRef.current = hoverWindow ?? windowCandidateAt(current);
    setHoverWindow(null);
    setDragStart(current);
    setSelection({ x: current.x, y: current.y, width: 0, height: 0 });
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveSelect(event: React.PointerEvent<HTMLDivElement>) {
    const raw = point(event);
    if (!dragStart) {
      setHoverWindow(windowCandidateAt(raw));
      return;
    }

    event.preventDefault();
    if (!dragStart || tool !== "select") return;
    const current = raw;
    setSelection(normalizeRect(dragStart.x, dragStart.y, current.x, current.y));
  }

  function endSelect(event: React.PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    if (!dragStart) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    const raw = point(event);
    const distance = Math.hypot(raw.x - dragStart.x, raw.y - dragStart.y);
    const clickedWindow = distance <= 4 ? clickWindowRef.current : null;
    setDragStart(null);
    setSelection((rect) => {
      if (clickedWindow) return clickedWindow;
      if (rect && rect.width > 8 && rect.height > 8) return rect;
      return null;
    });
    clickWindowRef.current = null;
  }

  async function closeOverlay() {
    try {
      await invoke("finish_capture");
    } catch {
      const win = getCurrentWebviewWindow();
      await win.hide();
    } finally {
      setCapture(null);
      setImage(null);
      setSelection(null);
      setHoverWindow(null);
      setDragStart(null);
      clickWindowRef.current = null;
      setTool("select");
      setTextDraft(null);
      canvasRef.current?.clear();
    }
  }

  function commitTextDraft() {
    if (!textDraft) return;
    const value = textDraft.value.trim();
    if (value) {
      canvasRef.current?.addText({
        x: textDraft.x,
        y: textDraft.y,
        text: value,
        color,
        lineWidth
      });
    }
    setTextDraft(null);
  }

  async function saveSelection() {
    commitTextDraft();
    await new Promise((resolve) => window.requestAnimationFrame(resolve));
    const dataUrl = await canvasRef.current?.exportSelection();
    if (!dataUrl) return;
    await closeOverlay();
    await invoke<string | null>("save_png_base64", { pngBase64: dataUrlToBase64(dataUrl) });
  }

  async function copySelection() {
    commitTextDraft();
    await new Promise((resolve) => window.requestAnimationFrame(resolve));
    const dataUrl = await canvasRef.current?.exportSelection();
    if (!dataUrl) return;
    await closeOverlay();
    await invoke("copy_png_base64", { pngBase64: dataUrlToBase64(dataUrl) });
  }

  if (!capture) {
    return <div className="overlay-root idle" />;
  }

  return (
    <main
      className="overlay-root"
      onDragStart={(event) => event.preventDefault()}
      onContextMenu={(event) => event.preventDefault()}
      onPointerDown={beginSelect}
      onPointerMove={moveSelect}
      onPointerUp={endSelect}
    >
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

      {!selection && hoverWindow && (
        <div
          className="window-candidate-box"
          style={{ left: hoverWindow.x, top: hoverWindow.y, width: hoverWindow.width, height: hoverWindow.height }}
        />
      )}

      {selection && (
        <>
          <div className="mask top" style={{ height: selection.y }} />
          <div className="mask left" style={{ top: selection.y, width: selection.x, height: selection.height }} />
          <div
            className="mask right"
            style={{ top: selection.y, left: selection.x + selection.width, height: selection.height }}
          />
          <div className="mask bottom" style={{ top: selection.y + selection.height }} />
          <div
            className="selection-box"
            style={{ left: selection.x, top: selection.y, width: selection.width, height: selection.height }}
          />
          <div
            className="toolbar"
            style={toolbarLayout?.captureStyle}
            onPointerDown={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
          >
              <button className={tool === "select" ? "active" : ""} title="选择" onClick={() => setTool("select")}>
                <MousePointer2 size={17} />
              </button>
              <button className={tool === "rect" ? "active" : ""} title="矩形" onClick={() => setTool("rect")}>
                <RectangleHorizontal size={17} />
              </button>
              <button className={tool === "diamond" ? "active" : ""} title="菱形" onClick={() => setTool("diamond")}>
                <Diamond size={17} />
              </button>
              <button
                className={tool === "ellipse" ? "active" : ""}
                title="圆形"
                onClick={() => setTool("ellipse")}
              >
                <Circle size={17} />
              </button>
              <button className={tool === "arrow" ? "active" : ""} title="箭头" onClick={() => setTool("arrow")}>
                <ArrowUpRight size={17} />
              </button>
              <button className={tool === "pen" ? "active" : ""} title="画笔" onClick={() => setTool("pen")}>
                <PenLine size={17} />
              </button>
              <button className={tool === "text" ? "active" : ""} title="文字" onClick={() => setTool("text")}>
                <Type size={17} />
              </button>
              <button
                className={tool === "excalidraw" ? "active" : ""}
                title="高级绘图"
                onClick={() => setTool("excalidraw")}
              >
                <Shapes size={17} />
              </button>
              <div className="divider" />
              {COLORS.map((item) => (
                <button
                  key={item}
                  className="swatch"
                  style={{ color: item }}
                  title={item}
                  onClick={() => setColor(item)}
                >
                  <span style={{ background: item }} />
                </button>
              ))}
              <input
                className="line-width"
                type="range"
                min={1}
                max={10}
                value={lineWidth}
                onChange={(event) => setLineWidth(Number(event.target.value))}
                title="线宽"
              />
              <div className="divider" />
              <button title="撤销" onClick={() => canvasRef.current?.undo()}>
                <Undo2 size={17} />
              </button>
              <button title="清空标注" onClick={() => canvasRef.current?.clear()}>
                <Eraser size={17} />
              </button>
              <button title="复制" onClick={copySelection}>
                <Clipboard size={17} />
              </button>
              <button title="保存" onClick={saveSelection}>
                <Save size={17} />
              </button>
              <button title="取消" onClick={closeOverlay}>
                <X size={17} />
              </button>
          </div>
        </>
      )}

      {textDraft && (
        <input
          ref={textInputRef}
          className="text-draft"
          style={{ left: textDraft.x, top: textDraft.y, color }}
          value={textDraft.value}
          spellCheck={false}
          onChange={(event) => setTextDraft({ ...textDraft, value: event.target.value })}
          onBlur={commitTextDraft}
          onPointerDown={(event) => event.stopPropagation()}
          onPointerUp={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter") commitTextDraft();
            if (event.key === "Escape") setTextDraft(null);
          }}
        />
      )}

      {!selection && <div className="hint">移动鼠标识别窗口，单击选中窗口，拖动框选区域，按 Esc 取消</div>}
      {notice && (
        <div className="notice">{notice}</div>
      )}
    </main>
  );
}
