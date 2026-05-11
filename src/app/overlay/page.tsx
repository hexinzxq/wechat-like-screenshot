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
  Diamond,
  Eraser,
  MousePointer2,
  PenLine,
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

type ScrollCaptureRequest = {
  sourceX: number;
  sourceY: number;
  sourceWidth: number;
  sourceHeight: number;
  cursorX: number;
  cursorY: number;
  targetHwnd?: number | null;
};

type ScrollCaptureFrame = {
  imageDataUrl: string;
  width: number;
  height: number;
  targetHwnd: number;
};

type BitmapFrame = {
  canvas: HTMLCanvasElement;
  imageData: ImageData;
  width: number;
  height: number;
};

type ScrollSession = {
  request: ScrollCaptureRequest;
  targetHwnd: number;
  previous: BitmapFrame;
  stitched: HTMLCanvasElement;
  slices: number;
};

type ScrollProgress = {
  slices: number;
  width: number;
  height: number;
};

type ScrollMatch = {
  shift: number;
  fixedTop: number;
  fixedBottom: number;
  score: number;
  distinct: number;
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

function loadImage(dataUrl: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image load failed"));
    img.src = dataUrl;
  });
}

function canvasFrame(canvas: HTMLCanvasElement): BitmapFrame {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas context unavailable");
  return {
    canvas,
    imageData: ctx.getImageData(0, 0, canvas.width, canvas.height),
    width: canvas.width,
    height: canvas.height
  };
}

async function frameFromDataUrl(dataUrl: string): Promise<BitmapFrame> {
  const img = await loadImage(dataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas context unavailable");
  ctx.drawImage(img, 0, 0);
  return canvasFrame(canvas);
}

function cloneCanvas(source: HTMLCanvasElement) {
  const canvas = document.createElement("canvas");
  canvas.width = source.width;
  canvas.height = source.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas context unavailable");
  ctx.drawImage(source, 0, 0);
  return canvas;
}

function previewDataUrl(canvas: HTMLCanvasElement) {
  const maxWidth = 220;
  const maxHeight = 520;
  const scale = Math.min(maxWidth / canvas.width, maxHeight / canvas.height, 1);
  const width = Math.max(1, Math.round(canvas.width * scale));
  const height = Math.max(1, Math.round(canvas.height * scale));
  const preview = document.createElement("canvas");
  preview.width = width;
  preview.height = height;
  const ctx = preview.getContext("2d");
  if (!ctx) return canvas.toDataURL("image/jpeg", 0.72);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(canvas, 0, 0, width, height);
  return preview.toDataURL("image/jpeg", 0.74);
}

function pixelDiff(dataA: ImageData, dataB: ImageData, x: number, yA: number, yB: number) {
  const indexA = (yA * dataA.width + x) * 4;
  const indexB = (yB * dataB.width + x) * 4;
  return (
    Math.abs(dataA.data[indexA] - dataB.data[indexB]) +
    Math.abs(dataA.data[indexA + 1] - dataB.data[indexB + 1]) +
    Math.abs(dataA.data[indexA + 2] - dataB.data[indexB + 2])
  ) / 3;
}

function sampledDiff(previous: ImageData, current: ImageData, previousY: number, currentY: number, height: number) {
  const width = Math.min(previous.width, current.width);
  const availableHeight = Math.min(height, previous.height - previousY, current.height - currentY);
  if (width <= 0 || availableHeight <= 0) return Number.POSITIVE_INFINITY;
  const stepX = Math.max(1, Math.floor(width / 52));
  const stepY = Math.max(1, Math.floor(availableHeight / 90));
  let total = 0;
  let count = 0;

  for (let y = 0; y < availableHeight; y += stepY) {
    for (let x = 0; x < width; x += stepX) {
      total += pixelDiff(previous, current, x, previousY + y, currentY + y);
      count += 1;
    }
  }

  return count ? total / count : Number.POSITIVE_INFINITY;
}

function sampledRowDiff(previous: ImageData, current: ImageData, previousY: number, currentY: number) {
  const width = Math.min(previous.width, current.width);
  if (width <= 0) return Number.POSITIVE_INFINITY;
  const stepX = Math.max(1, Math.floor(width / 48));
  let total = 0;
  let count = 0;

  for (let x = 0; x < width; x += stepX) {
    total += pixelDiff(previous, current, x, previousY, currentY);
    count += 1;
  }

  return count ? total / count : Number.POSITIVE_INFINITY;
}

function framesAreSimilar(previous: BitmapFrame, current: BitmapFrame) {
  if (previous.width !== current.width || previous.height !== current.height) return false;
  return sampledDiff(previous.imageData, current.imageData, 0, 0, previous.height) <= 3.2;
}

function fixedEdgeBands(previous: BitmapFrame, current: BitmapFrame) {
  const height = Math.min(previous.height, current.height);
  const maxBand = Math.min(Math.round(height * 0.28), 180);
  let fixedTop = 0;
  while (fixedTop < maxBand && sampledRowDiff(previous.imageData, current.imageData, fixedTop, fixedTop) <= 4.2) {
    fixedTop += 1;
  }

  let fixedBottom = 0;
  while (
    fixedBottom < maxBand &&
    sampledRowDiff(
      previous.imageData,
      current.imageData,
      height - fixedBottom - 1,
      height - fixedBottom - 1
    ) <= 4.2
  ) {
    fixedBottom += 1;
  }

  return { fixedTop, fixedBottom };
}

function findScrollMatch(previous: BitmapFrame, current: BitmapFrame, direction: "down" | "up"): ScrollMatch | null {
  if (previous.width !== current.width || previous.height !== current.height) return null;
  const height = previous.height;
  if (height < 60) return null;

  const { fixedTop, fixedBottom } = fixedEdgeBands(previous, current);
  const minShift = clamp(Math.round(height / 40), 8, 72);
  const maxShift = Math.min(Math.round(height * 0.88), height - fixedTop - fixedBottom - 24);
  if (maxShift <= minShift) return null;

  let bestShift = 0;
  let bestScore = Number.POSITIVE_INFINITY;
  let secondScore = Number.POSITIVE_INFINITY;
  const step = height > 900 ? 3 : 2;

  for (let shift = minShift; shift <= maxShift; shift += step) {
    const overlap = height - shift - fixedTop - fixedBottom;
    if (overlap < 32) continue;
    const previousY = direction === "down" ? shift + fixedTop : fixedTop;
    const currentY = direction === "down" ? fixedTop : shift + fixedTop;
    const score = sampledDiff(previous.imageData, current.imageData, previousY, currentY, overlap);
    if (score < bestScore) {
      secondScore = bestScore;
      bestScore = score;
      bestShift = shift;
    } else if (score < secondScore) {
      secondScore = score;
    }
  }

  if (!bestShift || !Number.isFinite(bestScore)) return null;
  const distinct = Math.max(0, secondScore - bestScore);
  const reliable = bestScore <= 11.5 && (distinct >= 0.32 || bestScore <= 5.8);
  if (!reliable) return null;
  return { shift: bestShift, fixedTop, fixedBottom, score: bestScore, distinct };
}

function appendFrame(stitched: HTMLCanvasElement, current: BitmapFrame, match: ScrollMatch) {
  const startY = clamp(current.height - match.fixedBottom - match.shift, match.fixedTop, current.height);
  const endY = clamp(current.height - match.fixedBottom, startY, current.height);
  const appendHeight = endY - startY;
  if (appendHeight <= 0) return stitched;

  const canvas = document.createElement("canvas");
  canvas.width = stitched.width;
  canvas.height = stitched.height + appendHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) return stitched;
  ctx.drawImage(stitched, 0, 0);
  ctx.drawImage(current.canvas, 0, startY, current.width, appendHeight, 0, stitched.height, stitched.width, appendHeight);
  return canvas;
}

function prependFrame(stitched: HTMLCanvasElement, current: BitmapFrame, match: ScrollMatch) {
  const startY = match.fixedTop;
  const prependHeight = clamp(match.shift, 0, current.height - match.fixedBottom - startY);
  if (prependHeight <= 0) return stitched;

  const canvas = document.createElement("canvas");
  canvas.width = stitched.width;
  canvas.height = stitched.height + prependHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) return stitched;
  ctx.drawImage(current.canvas, 0, startY, current.width, prependHeight, 0, 0, stitched.width, prependHeight);
  ctx.drawImage(stitched, 0, prependHeight);
  return canvas;
}

function fitImageFrame(width: number, height: number): Rect {
  const maxWidth = Math.max(160, window.innerWidth - 64);
  const maxHeight = Math.max(160, window.innerHeight - 116);
  const scale = Math.min(maxWidth / width, maxHeight / height, 1);
  const frameWidth = Math.max(1, Math.round(width * scale));
  const frameHeight = Math.max(1, Math.round(height * scale));
  return {
    x: Math.round((window.innerWidth - frameWidth) / 2),
    y: Math.max(18, Math.round((window.innerHeight - frameHeight) / 2) - 18),
    width: frameWidth,
    height: frameHeight
  };
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
  const [scrollMode, setScrollMode] = useState(false);
  const [scrollBusy, setScrollBusy] = useState(false);
  const [scrollPreviewUrl, setScrollPreviewUrl] = useState<string | null>(null);
  const [scrollProgress, setScrollProgress] = useState<ScrollProgress | null>(null);
  const canvasRef = useRef<AnnotationCanvasHandle | null>(null);
  const textInputRef = useRef<HTMLInputElement | null>(null);
  const selectionBeforeDragRef = useRef<Rect | null>(null);
  const clickWindowRef = useRef<Rect | null>(null);
  const scrollSessionRef = useRef<ScrollSession | null>(null);
  const scrollStepRunningRef = useRef(false);
  const pendingScrollDeltaRef = useRef(0);
  const pendingScrollFinishRef = useRef(false);

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

  async function presentCapture(
    payload: CapturePayload,
    options: { imageFrame?: Rect | null; notice?: string } = {}
  ) {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("图片加载失败"));
      img.src = payload.imageDataUrl;
    });

    setCapture(payload);
    setImage(img);
    setImageFrame(options.imageFrame ?? null);
    setSelection(options.imageFrame ?? null);
    setHoverWindow(null);
    setDragStart(null);
    selectionBeforeDragRef.current = null;
    clickWindowRef.current = null;
    setTool("select");
    setTextDraft(null);
    setScrollMode(false);
    setScrollBusy(false);
    setScrollPreviewUrl(null);
    setScrollProgress(null);
    scrollSessionRef.current = null;
    scrollStepRunningRef.current = false;
    pendingScrollDeltaRef.current = 0;
    pendingScrollFinishRef.current = false;
    setNotice(options.notice ?? "");
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
        if (scrollMode) {
          cancelScrollCapture();
          return;
        }
        void closeOverlay();
      }
    }
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [scrollMode]);

  const toolbarLayout = useMemo<ToolbarLayout | undefined>(() => {
    if (!selection) return undefined;
    const captureToolbarWidth = scrollMode ? 158 : 860;
    const hasExcalidrawToolbar = tool === "excalidraw" && !scrollMode;
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
  }, [selection, scrollMode, tool]);

  const scrollPreviewStyle = useMemo<CSSProperties | undefined>(() => {
    if (!selection) return undefined;
    const previewWidth = 184;
    const gap = 12;
    const rightLeft = selection.x + selection.width + gap;
    const left =
      rightLeft + previewWidth <= window.innerWidth - SCREEN_EDGE_GAP
        ? rightLeft
        : Math.max(SCREEN_EDGE_GAP, selection.x - previewWidth - gap);
    const top = clamp(selection.y, SCREEN_EDGE_GAP, Math.max(SCREEN_EDGE_GAP, window.innerHeight - 300));
    return { left, top };
  }, [selection]);

  function point(event: React.PointerEvent<HTMLDivElement>) {
    return { x: event.clientX, y: event.clientY };
  }

  function clampPointToRect(current: { x: number; y: number }, rect: Rect) {
    return {
      x: clamp(current.x, rect.x, rect.x + rect.width),
      y: clamp(current.y, rect.y, rect.y + rect.height)
    };
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
    if (!capture?.windows?.length || selection || dragStart || tool !== "select" || scrollMode || imageFrame) {
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
    if (scrollMode || tool !== "select") return;
    const raw = point(event);
    if (imageFrame && !insideRect(raw, imageFrame)) return;
    const current = imageFrame ? clampPointToRect(raw, imageFrame) : raw;
    void lockWindow();
    if (!imageFrame) canvasRef.current?.clear();
    setTextDraft(null);
    clickWindowRef.current = imageFrame ? null : hoverWindow ?? windowCandidateAt(current);
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
    if (scrollMode || !dragStart || tool !== "select") return;
    const current = imageFrame ? clampPointToRect(raw, imageFrame) : raw;
    setSelection(normalizeRect(dragStart.x, dragStart.y, current.x, current.y));
  }

  function endSelect(event: React.PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    if (scrollMode || !dragStart) return;
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
      setImageFrame(null);
      setScrollMode(false);
      setScrollBusy(false);
      setScrollPreviewUrl(null);
      setScrollProgress(null);
      scrollSessionRef.current = null;
      scrollStepRunningRef.current = false;
      pendingScrollDeltaRef.current = 0;
      pendingScrollFinishRef.current = false;
      selectionBeforeDragRef.current = null;
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

  function buildScrollRequest(): ScrollCaptureRequest | null {
    if (!capture || !selection) return null;
    const scaleX = capture.width / Math.max(1, window.innerWidth);
    const scaleY = capture.height / Math.max(1, window.innerHeight);
    const sourceX = Math.max(0, Math.round(selection.x * scaleX));
    const sourceY = Math.max(0, Math.round(selection.y * scaleY));
    const sourceWidth = Math.max(40, Math.round(selection.width * scaleX));
    const sourceHeight = Math.max(40, Math.round(selection.height * scaleY));
    return {
      sourceX,
      sourceY,
      sourceWidth,
      sourceHeight,
      cursorX: capture.originX + sourceX + Math.round(sourceWidth / 2),
      cursorY: capture.originY + sourceY + Math.round(sourceHeight / 2),
      targetHwnd: null
    };
  }

  function cropInitialScrollFrame(request: ScrollCaptureRequest): BitmapFrame | null {
    if (!image) return null;
    const canvas = document.createElement("canvas");
    canvas.width = request.sourceWidth;
    canvas.height = request.sourceHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(
      image,
      request.sourceX,
      request.sourceY,
      request.sourceWidth,
      request.sourceHeight,
      0,
      0,
      request.sourceWidth,
      request.sourceHeight
    );
    return canvasFrame(canvas);
  }

  async function startScrollCapture() {
    if (!capture || !selection || imageFrame || scrollMode || scrollBusy) return;
    const request = buildScrollRequest();
    const initialFrame = request ? cropInitialScrollFrame(request) : null;
    if (!request || !initialFrame) return;

    commitTextDraft();
    canvasRef.current?.clear();
    setHoverWindow(null);
    setTool("select");
    setScrollMode(true);
    setScrollBusy(true);
    setScrollPreviewUrl(previewDataUrl(initialFrame.canvas));
    setScrollProgress({ slices: 1, width: initialFrame.width, height: initialFrame.height });
    setNotice("长截图中：在选区内滚轮滚动，完成后点勾");
    pendingScrollDeltaRef.current = 0;
    pendingScrollFinishRef.current = false;
    scrollStepRunningRef.current = false;

    try {
      await nextPaint();
      const frame = await invoke<ScrollCaptureFrame>("begin_scroll_capture", { request });
      scrollSessionRef.current = {
        request: { ...request, targetHwnd: frame.targetHwnd },
        targetHwnd: frame.targetHwnd,
        previous: initialFrame,
        stitched: cloneCanvas(initialFrame.canvas),
        slices: 1
      };
    } catch (error) {
      setScrollMode(false);
      setScrollPreviewUrl(null);
      setScrollProgress(null);
      setNotice(String(error || "长截图启动失败"));
      scrollSessionRef.current = null;
    } finally {
      setScrollBusy(false);
    }
  }

  async function stitchScrollFrame(dataUrl: string, deltaY: number) {
    const session = scrollSessionRef.current;
    if (!session) return false;
    const current = await frameFromDataUrl(dataUrl);
    if (framesAreSimilar(session.previous, current)) {
      session.previous = current;
      setNotice("这一屏没有滚动出新内容，可以继续滚动或点勾完成");
      return false;
    }

    const direction = deltaY < 0 ? "up" : "down";
    const match = findScrollMatch(session.previous, current, direction);
    if (!match) {
      session.previous = current;
      setNotice("这一屏没有找到可靠拼接点，已跳过以避免拼错");
      return false;
    }

    session.stitched =
      direction === "up" ? prependFrame(session.stitched, current, match) : appendFrame(session.stitched, current, match);
    session.previous = current;
    session.slices += 1;
    setScrollPreviewUrl(previewDataUrl(session.stitched));
    setScrollProgress({ slices: session.slices, width: session.stitched.width, height: session.stitched.height });
    setNotice(`长截图中：已采集 ${session.slices} 屏，继续滚动或点勾完成`);
    return true;
  }

  function takePendingScrollDelta() {
    const pending = pendingScrollDeltaRef.current;
    if (!pending) return 0;
    const direction = pending < 0 ? -1 : 1;
    const delta = direction * clamp(Math.abs(pending), 80, 240);
    pendingScrollDeltaRef.current = 0;
    return delta;
  }

  function queueScrollCapture(deltaY: number) {
    if (!scrollMode || !scrollSessionRef.current) return;
    const direction = deltaY < 0 ? -1 : 1;
    const normalized = direction * clamp(Math.abs(deltaY || 120), 80, 240);
    if (scrollStepRunningRef.current) {
      pendingScrollDeltaRef.current = clamp(pendingScrollDeltaRef.current + normalized, -480, 480);
      return;
    }
    void runScrollCaptureStep(normalized);
  }

  async function runScrollCaptureStep(deltaY: number) {
    const session = scrollSessionRef.current;
    if (!session || scrollStepRunningRef.current) return;
    scrollStepRunningRef.current = true;
    setScrollBusy(true);
    try {
      const frame = await invoke<ScrollCaptureFrame>("step_scroll_capture", {
        request: { ...session.request, targetHwnd: session.targetHwnd },
        scrollDeltaY: Math.round(deltaY)
      });
      session.targetHwnd = frame.targetHwnd;
      session.request.targetHwnd = frame.targetHwnd;
      await stitchScrollFrame(frame.imageDataUrl, deltaY);
    } catch (error) {
      setNotice(String(error || "长截图采集失败"));
    } finally {
      scrollStepRunningRef.current = false;
      setScrollBusy(false);
      if (pendingScrollFinishRef.current) {
        pendingScrollFinishRef.current = false;
        window.setTimeout(() => void finishScrollCapture(), 0);
        return;
      }
      const pendingDelta = takePendingScrollDelta();
      if (pendingDelta && scrollMode) {
        window.setTimeout(() => void runScrollCaptureStep(pendingDelta), 16);
      }
    }
  }

  async function finishScrollCapture() {
    const session = scrollSessionRef.current;
    if (!capture || !session) return;
    if (scrollStepRunningRef.current) {
      pendingScrollFinishRef.current = true;
      setNotice("正在完成当前采集，马上生成长图");
      return;
    }

    const dataUrl = session.stitched.toDataURL("image/png");
    const img = await loadImage(dataUrl);
    const frame = fitImageFrame(img.naturalWidth, img.naturalHeight);
    await presentCapture(
      {
        imageDataUrl: dataUrl,
        width: capture.width,
        height: capture.height,
        originX: capture.originX,
        originY: capture.originY,
        windows: []
      },
      {
        imageFrame: frame,
        notice: "长截图完成，可以继续标注、复制或保存"
      }
    );
  }

  function cancelScrollCapture() {
    pendingScrollDeltaRef.current = 0;
    pendingScrollFinishRef.current = false;
    scrollStepRunningRef.current = false;
    scrollSessionRef.current = null;
    setScrollMode(false);
    setScrollBusy(false);
    setScrollPreviewUrl(null);
    setScrollProgress(null);
    setNotice("");
  }

  function handleWheel(event: React.WheelEvent<HTMLElement>) {
    if (!scrollMode || !selection) return;
    const current = { x: event.clientX, y: event.clientY };
    if (!insideRect(current, selection)) return;
    event.preventDefault();
    event.stopPropagation();
    queueScrollCapture(event.deltaY || 120);
  }

  if (!capture) {
    return <div className="overlay-root idle" />;
  }

  return (
    <main
      className={`overlay-root${scrollMode ? " scroll-mode" : ""}`}
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
        showImage={!scrollMode}
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
              <button className={tool === "diamond" ? "active" : ""} title="鑿卞舰" onClick={() => setTool("diamond")}>
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
              <button title="长截图" disabled={!!imageFrame || scrollBusy} onClick={startScrollCapture}>
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
              <button className="scroll-control" title="补采一帧" disabled={scrollBusy} onClick={() => queueScrollCapture(120)}>
                <ScrollText size={17} />
              </button>
              <button className="scroll-control" title="完成长截图" onClick={finishScrollCapture}>
                <Check size={17} />
              </button>
              <button className="scroll-control" title="取消长截图" onClick={cancelScrollCapture}>
                <X size={17} />
              </button>
          </div>
        </>
      )}

      {scrollMode && scrollPreviewUrl && (
        <div className="scroll-preview" style={scrollPreviewStyle}>
          <div className="scroll-preview-title">实时预览</div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={scrollPreviewUrl} alt="" draggable={false} />
          <div className="scroll-preview-meta">
            {scrollProgress ? `${scrollProgress.slices} 屏 · ${scrollProgress.height}px` : ""}
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
        <div className="notice">{notice}</div>
      )}
    </main>
  );
}
