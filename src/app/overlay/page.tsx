"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  ArrowUpRight,
  Circle,
  Clipboard,
  Eraser,
  MousePointer2,
  PenLine,
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
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
  const [tool, setTool] = useState<AnnotationTool>("select");
  const [color, setColor] = useState(COLORS[0]);
  const [lineWidth, setLineWidth] = useState(3);
  const [notice, setNotice] = useState("");
  const [textDraft, setTextDraft] = useState<{ x: number; y: number; value: string } | null>(null);
  const [imageFrame, setImageFrame] = useState<Rect | null>(null);
  const [longCapturing, setLongCapturing] = useState(false);
  const canvasRef = useRef<AnnotationCanvasHandle | null>(null);
  const textInputRef = useRef<HTMLInputElement | null>(null);

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

  async function presentCapture(payload: CapturePayload, options?: { longPreview?: boolean }) {
    setCapture(null);
    setImage(null);
    setSelection(null);
    setDragStart(null);
    setTool("select");
    setTextDraft(null);
    setImageFrame(null);
    setNotice("");
    canvasRef.current?.clear();

    const img = new Image();
    img.onload = async () => {
      const frame = options?.longPreview ? longPreviewFrame(img) : null;
      setImage(img);
      setCapture(payload);
      setImageFrame(frame);
      if (frame) setSelection(frame);
      const win = getCurrentWebviewWindow();
      await win.show();
      await win.setFocus();
      await lockWindow(payload);
    };
    img.src = payload.imageDataUrl;
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
      if (event.key === "Escape") closeOverlay();
    }
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, []);

  const toolbarStyle = useMemo(() => {
    if (!selection) return undefined;
    const top = Math.min(window.innerHeight - 48, selection.y + selection.height + 8);
    const maxLeft = Math.max(8, window.innerWidth - 640);
    const left = Math.min(maxLeft, Math.max(8, selection.x));
    return { left, top: Math.max(8, top) };
  }, [selection]);

  function point(event: React.PointerEvent<HTMLDivElement>) {
    return { x: event.clientX, y: event.clientY };
  }

  function beginSelect(event: React.PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    void lockWindow();
    if (tool !== "select") return;
    const current = point(event);
    if (imageFrame && !insideRect(current, imageFrame)) return;
    canvasRef.current?.clear();
    setTextDraft(null);
    setDragStart(current);
    setSelection({ x: current.x, y: current.y, width: 0, height: 0 });
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveSelect(event: React.PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    if (!dragStart || tool !== "select") return;
    const current = point(event);
    setSelection(normalizeRect(dragStart.x, dragStart.y, current.x, current.y));
  }

  function endSelect(event: React.PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    if (!dragStart) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    setDragStart(null);
    setSelection((rect) => (rect && rect.width > 8 && rect.height > 8 ? rect : null));
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
      setDragStart(null);
      setTool("select");
      setTextDraft(null);
      setImageFrame(null);
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

  async function startLongCapture() {
    if (!capture || !selection || imageFrame || longCapturing) return;
    commitTextDraft();
    canvasRef.current?.clear();
    setLongCapturing(true);
    setNotice("正在长截图...");

    const scaleX = capture.width / Math.max(1, window.innerWidth);
    const scaleY = capture.height / Math.max(1, window.innerHeight);
    const request = {
      sourceX: Math.max(0, Math.round(selection.x * scaleX)),
      sourceY: Math.max(0, Math.round(selection.y * scaleY)),
      sourceWidth: Math.max(80, Math.round(selection.width * scaleX)),
      sourceHeight: Math.max(80, Math.round(selection.height * scaleY)),
      maxSlices: 10
    };

    try {
      const longPayload = await invoke<CapturePayload>("capture_long_selection", { request });
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
      const win = getCurrentWebviewWindow();
      await win.show();
      await win.setFocus();
      await lockWindow();
      setNotice(String(error || "长截图失败"));
    } finally {
      setLongCapturing(false);
    }
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
        imageFrame={imageFrame}
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
          <div
            className="selection-box"
            style={{ left: selection.x, top: selection.y, width: selection.width, height: selection.height }}
          />
          <div
            className="toolbar"
            style={toolbarStyle}
            onPointerDown={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
          >
            <button className={tool === "select" ? "active" : ""} title="选择" onClick={() => setTool("select")}>
              <MousePointer2 size={17} />
            </button>
            <button className={tool === "rect" ? "active" : ""} title="矩形" onClick={() => setTool("rect")}>
              <RectangleHorizontal size={17} />
            </button>
            <button className={tool === "ellipse" ? "active" : ""} title="圆形" onClick={() => setTool("ellipse")}>
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
            <button title="长截图" disabled={longCapturing || !!imageFrame} onClick={startLongCapture}>
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

      {!selection && <div className="hint">拖拽框选截图区域，按 Esc 取消</div>}
      {notice && <div className="notice">{notice}</div>}
    </main>
  );
}
