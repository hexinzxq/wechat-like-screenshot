"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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

type LongCaptureProgress = {
  slices: number;
  width: number;
  height: number;
  changed: boolean;
  finished: boolean;
};

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
  const canvasRef = useRef<AnnotationCanvasHandle | null>(null);
  const textInputRef = useRef<HTMLInputElement | null>(null);
  const selectionBeforeDragRef = useRef<Rect | null>(null);

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
    setDragStart(null);
    selectionBeforeDragRef.current = null;
    setTool("select");
    setTextDraft(null);
    setImageFrame(frame);
    setLongMode(false);
    setLongBusy(false);
    setLongSnapshotting(false);
    setAutoLongCapture(false);
    setLongProgress(null);
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
      void stepLongCapture(120);
    }, 80);
    return () => window.clearTimeout(timer);
  }, [longMode, autoLongCapture, longBusy]);

  const toolbarStyle = useMemo(() => {
    if (!selection) return undefined;
    const top = Math.min(window.innerHeight - 48, selection.y + selection.height + 8);
    const maxLeft = Math.max(8, window.innerWidth - (longMode ? 190 : 640));
    const left = Math.min(maxLeft, Math.max(8, selection.x));
    return { left, top: Math.max(8, top) };
  }, [selection, longMode]);

  function point(event: React.PointerEvent<HTMLDivElement>) {
    return { x: event.clientX, y: event.clientY };
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
    selectionBeforeDragRef.current = selection;
    setDragStart(current);
    setSelection({ x: current.x, y: current.y, width: 0, height: 0 });
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveSelect(event: React.PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    if (longMode || !dragStart || tool !== "select") return;
    const raw = point(event);
    const current = imageFrame ? clampPointToRect(raw, imageFrame) : raw;
    setSelection(normalizeRect(dragStart.x, dragStart.y, current.x, current.y));
  }

  function endSelect(event: React.PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    if (longMode || !dragStart) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    setDragStart(null);
    setSelection((rect) => {
      if (rect && rect.width > 8 && rect.height > 8) return rect;
      return imageFrame ? selectionBeforeDragRef.current ?? imageFrame : null;
    });
    selectionBeforeDragRef.current = null;
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
      setDragStart(null);
      setTool("select");
      setTextDraft(null);
      setImageFrame(null);
      setLongMode(false);
      setLongBusy(false);
      setLongSnapshotting(false);
      setAutoLongCapture(false);
      setLongProgress(null);
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
    const dataUrl = canvasRef.current?.exportSelection();
    if (!dataUrl) return;
    await closeOverlay();
    await invoke<string | null>("save_png_base64", { pngBase64: dataUrlToBase64(dataUrl) });
  }

  async function copySelection() {
    commitTextDraft();
    await new Promise((resolve) => window.requestAnimationFrame(resolve));
    const dataUrl = canvasRef.current?.exportSelection();
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
      maxSlices: 60
    };
  }

  async function startLongCapture() {
    if (!capture || !selection || imageFrame || longBusy) return;
    const request = buildLongCaptureRequest();
    if (!request) return;

    commitTextDraft();
    canvasRef.current?.clear();
    setLongMode(true);
    setAutoLongCapture(false);
    setLongProgress(null);
    setTool("select");
    setNotice("长截图中：滚动选区继续，点完成结束");
    setLongBusy(true);
    setLongSnapshotting(true);

    try {
      await nextPaint();
      const progress = await invoke<LongCaptureProgress>("begin_long_capture_selection", { request });
      setLongProgress(progress);
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

  async function stepLongCapture(scrollDeltaY = 120) {
    if (!longMode || longBusy) return;
    setLongBusy(true);
    try {
      await nextPaint();
      const progress = await invoke<LongCaptureProgress>("step_long_capture", {
        scrollDeltaY: Math.round(scrollDeltaY)
      });
      setLongProgress(progress);
      if (!progress.changed) {
        setNotice("没有检测到可靠的新内容，可以点完成结束");
      } else {
        const direction = scrollDeltaY < 0 ? "上方" : "下方";
        setNotice(`长截图中：已采集${direction}内容，共 ${progress.slices} 屏`);
      }
      if (progress.finished) setAutoLongCapture(false);
    } catch (error) {
      setAutoLongCapture(false);
      setNotice(String(error || "长截图采集失败"));
    } finally {
      setLongBusy(false);
    }
  }

  async function finishLongCapture() {
    if (!capture || !longMode || longBusy) return;
    setLongBusy(true);
    setAutoLongCapture(false);
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
    await invoke("cancel_long_capture").catch(() => undefined);
    setLongMode(false);
    setLongBusy(false);
    setLongSnapshotting(false);
    setAutoLongCapture(false);
    setLongProgress(null);
    setNotice("");
  }

  function handleWheel(event: React.WheelEvent<HTMLElement>) {
    if (!longMode || !selection) return;
    const current = { x: event.clientX, y: event.clientY };
    if (!insideRect(current, selection)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.deltaY < 0) {
      void stepLongCapture(event.deltaY);
      return;
    }
    void stepLongCapture(event.deltaY || 120);
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
      />

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
              style={toolbarStyle}
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
                    onClick={() => setAutoLongCapture((value) => !value)}
                  >
                    {autoLongCapture ? <Pause size={17} /> : <Play size={17} />}
                  </button>
                  <button title="采集下一屏" disabled={longBusy} onClick={() => stepLongCapture(120)}>
                    <ScrollText size={17} />
                  </button>
                  <button title="完成长截图" disabled={longBusy} onClick={finishLongCapture}>
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

      {!selection && <div className="hint">拖拽框选截图区域，按 Esc 取消</div>}
      {notice && (
        <div className="notice">
          {notice}
          {longMode && longProgress ? ` · ${longProgress.height}px` : ""}
        </div>
      )}
    </main>
  );
}
