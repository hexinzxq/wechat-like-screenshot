"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  ArrowUpRight,
  Check,
  Circle,
  Clipboard,
  Eraser,
  MousePointer2,
  Pause,
  PenLine,
  Play,
  RectangleHorizontal,
  Save,
  Shapes,
  ScrollText,
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

type LongCaptureProgress = {
  slices: number;
  width: number;
  height: number;
  changed: boolean;
  finished: boolean;
  previewImageDataUrl?: string | null;
};

type PendingLongAction = "finish" | "cancel" | null;

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

function nextPaint() {
  return new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()));
  });
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
  const [imageFrame, setImageFrame] = useState<Rect | null>(null);
  const [longMode, setLongMode] = useState(false);
  const [longBusy, setLongBusy] = useState(false);
  const [longSnapshotting, setLongSnapshotting] = useState(false);
  const [autoLongCapture, setAutoLongCapture] = useState(false);
  const [longProgress, setLongProgress] = useState<LongCaptureProgress | null>(null);
  const [longPreviewUrl, setLongPreviewUrl] = useState<string | null>(null);
  const canvasRef = useRef<AnnotationCanvasHandle | null>(null);
  const textInputRef = useRef<HTMLInputElement | null>(null);
  const selectionBeforeDragRef = useRef<Rect | null>(null);
  const clickWindowRef = useRef<Rect | null>(null);
  const pendingLongDeltaRef = useRef(0);
  const pendingLongActionRef = useRef<PendingLongAction>(null);
  const longStepRunningRef = useRef(false);

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

  function longPreviewFrame(img: HTMLImageElement): Rect {
    const maxWidth = Math.max(160, window.innerWidth - 64);
    const maxHeight = Math.max(160, window.innerHeight - 120);
    const scale = Math.min(maxWidth / img.naturalWidth, maxHeight / img.naturalHeight, 1);
    const width = Math.max(1, Math.round(img.naturalWidth * scale));
    const height = Math.max(1, Math.round(img.naturalHeight * scale));
    return {
      x: Math.round((window.innerWidth - width) / 2),
      y: Math.max(24, Math.round((window.innerHeight - height) / 2) - 18),
      width,
      height
    };
  }

  function clampPointToRect(point: { x: number; y: number }, rect: Rect) {
    return {
      x: Math.min(rect.x + rect.width, Math.max(rect.x, point.x)),
      y: Math.min(rect.y + rect.height, Math.max(rect.y, point.y))
    };
  }

  async function presentCapture(payload: CapturePayload, options?: { longPreview?: boolean }) {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("图片加载失败"));
      img.src = payload.imageDataUrl;
    });

    const frame = options?.longPreview ? longPreviewFrame(img) : null;
    setCapture(payload);
    setImage(img);
    setSelection(frame);
    setHoverWindow(null);
    setDragStart(null);
    selectionBeforeDragRef.current = null;
    clickWindowRef.current = null;
    setTool("select");
    setTextDraft(null);
    setImageFrame(frame);
    setLongMode(false);
    setLongBusy(false);
    setLongSnapshotting(false);
    setAutoLongCapture(false);
    setLongProgress(null);
    setLongPreviewUrl(null);
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
        if (longMode) {
          void cancelLongCapture();
          return;
        }
        void closeOverlay();
      }
    }
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [longMode]);

  useEffect(() => {
    if (!longMode || !autoLongCapture || longBusy) return;
    const timer = window.setTimeout(() => {
      queueLongCaptureStep(96);
    }, 180);
    return () => window.clearTimeout(timer);
  }, [longMode, autoLongCapture, longBusy]);

  const toolbarLayout = useMemo<ToolbarLayout | undefined>(() => {
    if (!selection) return undefined;
    const captureToolbarWidth = longMode ? 190 : 680;
    const hasExcalidrawToolbar = tool === "excalidraw" && !longMode;
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
  }, [selection, longMode, tool]);

  const longPreviewStyle = useMemo(() => {
    if (!selection) return undefined;
    const previewWidth = 184;
    const gap = 12;
    const rightLeft = selection.x + selection.width + gap;
    const left =
      rightLeft + previewWidth <= window.innerWidth - 8
        ? rightLeft
        : Math.max(8, selection.x - previewWidth - gap);
    const top = Math.min(window.innerHeight - 300, Math.max(8, selection.y));
    return { left, top: Math.max(8, top) };
  }, [selection]);

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
    if (!capture?.windows?.length || selection || dragStart || tool !== "select" || longMode || imageFrame) {
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
    if (longMode || tool !== "select") return;
    const raw = point(event);
    if (imageFrame && !insideRect(raw, imageFrame)) return;
    const current = imageFrame ? clampPointToRect(raw, imageFrame) : raw;
    void lockWindow();
    if (!imageFrame) canvasRef.current?.clear();
    setTextDraft(null);
    clickWindowRef.current = hoverWindow ?? windowCandidateAt(raw);
    setHoverWindow(null);
    selectionBeforeDragRef.current = selection;
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
    if (longMode || !dragStart || tool !== "select") return;
    const current = imageFrame ? clampPointToRect(raw, imageFrame) : raw;
    setSelection(normalizeRect(dragStart.x, dragStart.y, current.x, current.y));
  }

  function endSelect(event: React.PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    if (longMode || !dragStart) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    const raw = point(event);
    const distance = Math.hypot(raw.x - dragStart.x, raw.y - dragStart.y);
    const clickedWindow = distance <= 4 && !imageFrame ? clickWindowRef.current : null;
    setDragStart(null);
    setSelection((rect) => {
      if (clickedWindow) return clickedWindow;
      if (rect && rect.width > 8 && rect.height > 8) return rect;
      return imageFrame ? selectionBeforeDragRef.current ?? imageFrame : null;
    });
    selectionBeforeDragRef.current = null;
    clickWindowRef.current = null;
  }

  async function closeOverlay() {
    try {
      await invoke("cancel_long_capture").catch(() => undefined);
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
      setImageFrame(null);
      setLongMode(false);
      setLongBusy(false);
      setLongSnapshotting(false);
      setAutoLongCapture(false);
      setLongProgress(null);
      setLongPreviewUrl(null);
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

  function buildLongCaptureRequest() {
    if (!capture || !selection) return null;
    const scaleX = capture.width / Math.max(1, window.innerWidth);
    const scaleY = capture.height / Math.max(1, window.innerHeight);
    return {
      sourceX: Math.max(0, Math.round(selection.x * scaleX)),
      sourceY: Math.max(0, Math.round(selection.y * scaleY)),
      sourceWidth: Math.max(80, Math.round(selection.width * scaleX)),
      sourceHeight: Math.max(80, Math.round(selection.height * scaleY)),
      maxSlices: 120
    };
  }

  async function startLongCapture() {
    if (!capture || !selection || imageFrame || longBusy) return;
    const request = buildLongCaptureRequest();
    if (!request) return;

    commitTextDraft();
    canvasRef.current?.clear();
    setHoverWindow(null);
    setLongMode(true);
    setAutoLongCapture(false);
    pendingLongDeltaRef.current = 0;
    pendingLongActionRef.current = null;
    longStepRunningRef.current = false;
    setLongProgress(null);
    setLongPreviewUrl(null);
    setTool("select");
    setNotice("长截图中：滚动选区继续，点完成结束");
    setLongBusy(true);
    setLongSnapshotting(true);

    try {
      await nextPaint();
      const progress = await invoke<LongCaptureProgress>("begin_long_capture_selection", { request });
      setLongProgress(progress);
      if (progress.previewImageDataUrl) setLongPreviewUrl(progress.previewImageDataUrl);
    } catch (error) {
      const win = getCurrentWebviewWindow();
      await win.show();
      await win.setFocus();
      await lockWindow();
      setLongMode(false);
      setNotice(String(error || "长截图失败"));
    } finally {
      setLongSnapshotting(false);
      setLongBusy(false);
    }
  }

  async function runLongCaptureStep(scrollDeltaY = 120) {
    if (!longMode || longStepRunningRef.current) return;
    longStepRunningRef.current = true;
    setLongBusy(true);
    try {
      const progress = await invoke<LongCaptureProgress>("step_long_capture", {
        scrollDeltaY: Math.round(scrollDeltaY)
      });
      setLongProgress(progress);
      if (progress.previewImageDataUrl) setLongPreviewUrl(progress.previewImageDataUrl);
      if (!progress.changed) {
        setNotice("本次没有采集到可靠新内容，自动滚动会继续尝试");
      } else {
        const direction = scrollDeltaY < 0 ? "上方" : "下方";
        setNotice(`长截图中：已采集${direction}内容，共 ${progress.slices} 屏`);
      }
      if (progress.finished) {
        setAutoLongCapture(false);
        setNotice("已达到长截图保护上限，可以点完成生成长图");
      }
    } catch (error) {
      setAutoLongCapture(false);
      const message = String(error || "长截图采集失败");
      if (!pendingLongActionRef.current && !message.includes("已停止")) {
        setNotice(message);
      }
    } finally {
      longStepRunningRef.current = false;
      setLongBusy(false);
      const pendingAction = pendingLongActionRef.current;
      pendingLongActionRef.current = null;
      if (pendingAction === "finish") {
        window.setTimeout(() => void finishLongCapture(), 0);
        return;
      }
      if (pendingAction === "cancel") {
        window.setTimeout(() => void cancelLongCapture(), 0);
        return;
      }
      const pendingDelta = pendingLongDeltaRef.current;
      pendingLongDeltaRef.current = 0;
      if (pendingDelta && longMode && !autoLongCapture) {
        window.setTimeout(() => queueLongCaptureStep(pendingDelta), 20);
      }
    }
  }

  function queueLongCaptureStep(scrollDeltaY = 120) {
    if (!longMode) return;
    if (longStepRunningRef.current) {
      pendingLongDeltaRef.current += scrollDeltaY;
      pendingLongDeltaRef.current = Math.max(-720, Math.min(720, pendingLongDeltaRef.current));
      return;
    }
    void runLongCaptureStep(scrollDeltaY);
  }

  function pauseLongCapture() {
    pendingLongDeltaRef.current = 0;
    void invoke("request_long_capture_stop").catch(() => undefined);
    setAutoLongCapture(false);
    setNotice("已暂停自动滚动");
  }

  async function finishLongCapture() {
    if (!capture || !longMode) return;
    pendingLongDeltaRef.current = 0;
    setAutoLongCapture(false);
    if (longStepRunningRef.current) {
      pendingLongActionRef.current = "finish";
      void invoke("request_long_capture_stop").catch(() => undefined);
      setNotice("正在完成当前采集帧，马上生成长图");
      return;
    }
    setLongBusy(true);
    try {
      const longPayload = await invoke<CapturePayload>("finish_long_capture");
      await presentCapture(
        {
          ...longPayload,
          width: capture.width,
          height: capture.height,
          originX: capture.originX,
          originY: capture.originY
        },
        { longPreview: true }
      );
      setNotice("长截图完成，可以继续标注、复制或保存");
    } catch (error) {
      setNotice(String(error || "长截图结束失败"));
    } finally {
      setLongBusy(false);
    }
  }

  async function cancelLongCapture() {
    pendingLongDeltaRef.current = 0;
    pendingLongActionRef.current = null;
    setAutoLongCapture(false);
    if (longStepRunningRef.current) {
      pendingLongActionRef.current = "cancel";
      void invoke("cancel_long_capture").catch(() => undefined);
      setNotice("正在停止长截图");
      return;
    }
    longStepRunningRef.current = false;
    await invoke("cancel_long_capture").catch(() => undefined);
    setLongMode(false);
    setLongBusy(false);
    setLongSnapshotting(false);
    setAutoLongCapture(false);
    setLongProgress(null);
    setLongPreviewUrl(null);
    setNotice("");
  }

  function handleWheel(event: React.WheelEvent<HTMLElement>) {
    if (!longMode || !selection) return;
    const current = { x: event.clientX, y: event.clientY };
    if (!insideRect(current, selection)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.deltaY < 0) {
      queueLongCaptureStep(event.deltaY);
      return;
    }
    queueLongCaptureStep(event.deltaY || 120);
  }

  if (!capture) {
    return <div className="overlay-root idle" />;
  }

  return (
    <main
      className={`overlay-root${longMode ? " long-mode" : ""}`}
      onDragStart={(event) => event.preventDefault()}
      onContextMenu={(event) => event.preventDefault()}
      onPointerDown={beginSelect}
      onPointerMove={moveSelect}
      onPointerUp={endSelect}
      onWheel={handleWheel}
    >
      <AnnotationCanvas
        ref={canvasRef}
        image={image}
        imageDataUrl={capture.imageDataUrl}
        imageFrame={imageFrame}
        showImage={!longMode}
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
          {!longSnapshotting && (
            <div
              className="selection-box"
              style={{ left: selection.x, top: selection.y, width: selection.width, height: selection.height }}
            />
          )}
          {!longSnapshotting && (
            <div
              className="toolbar"
              style={toolbarLayout?.captureStyle}
              onPointerDown={(event) => event.stopPropagation()}
              onPointerUp={(event) => event.stopPropagation()}
              onWheel={(event) => event.stopPropagation()}
            >
              {longMode ? (
                <>
                  <button
                    className={autoLongCapture ? "active" : ""}
                    title={autoLongCapture ? "停止自动滚动" : "自动滚动"}
                    disabled={longBusy && !autoLongCapture}
                    onClick={() => {
                      if (autoLongCapture) {
                        pauseLongCapture();
                      } else {
                        pendingLongDeltaRef.current = 0;
                        pendingLongActionRef.current = null;
                        setAutoLongCapture(true);
                      }
                    }}
                  >
                    {autoLongCapture ? <Pause size={17} /> : <Play size={17} />}
                  </button>
                  <button title="采集下一屏" disabled={longBusy} onClick={() => queueLongCaptureStep(120)}>
                    <ScrollText size={17} />
                  </button>
                  <button title="完成长截图" onClick={finishLongCapture}>
                    <Check size={17} />
                  </button>
                  <button title="取消长截图" onClick={cancelLongCapture}>
                    <X size={17} />
                  </button>
                </>
              ) : (
                <>
                  <button className={tool === "select" ? "active" : ""} title="选择" onClick={() => setTool("select")}>
                    <MousePointer2 size={17} />
                  </button>
                  <button className={tool === "rect" ? "active" : ""} title="矩形" onClick={() => setTool("rect")}>
                    <RectangleHorizontal size={17} />
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
                  <button title="长截图" disabled={longBusy || !!imageFrame} onClick={startLongCapture}>
                    <ScrollText size={17} />
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
                </>
              )}
            </div>
          )}
        </>
      )}

      {longMode && longPreviewUrl && (
        <div className="long-preview" style={longPreviewStyle}>
          <div className="long-preview-title">实时预览</div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={longPreviewUrl} alt="" draggable={false} />
          <div className="long-preview-meta">
            {longProgress ? `${longProgress.slices} 屏 · ${longProgress.height}px` : ""}
          </div>
        </div>
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
        <div className="notice">
          {notice}
          {longMode && longProgress ? ` · ${longProgress.height}px` : ""}
        </div>
      )}
    </main>
  );
}
