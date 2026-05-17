"use client";

import { invoke } from "@tauri-apps/api/core";
import { useRef, useState } from "react";
import type { RefObject, WheelEvent } from "react";
import type { AnnotationCanvasHandle } from "@/components/capture/AnnotationCanvas";
import type { AnnotationTool, CapturePayload, Rect } from "@/types/capture";

export type ScrollCaptureRequest = {
  sourceX: number;
  sourceY: number;
  sourceWidth: number;
  sourceHeight: number;
  cursorX: number;
  cursorY: number;
  targetHwnd?: number | null;
};

export type ScrollCaptureFrame = {
  imageDataUrl: string;
  width: number;
  height: number;
  targetHwnd: number;
};

export type BitmapFrame = {
  canvas: HTMLCanvasElement;
  imageData: ImageData;
  width: number;
  height: number;
};

export type ScrollSession = {
  request: ScrollCaptureRequest;
  targetHwnd: number;
  previous: BitmapFrame;
  stitched: HTMLCanvasElement;
  slices: number;
};

export type ScrollProgress = {
  slices: number;
  width: number;
  height: number;
};

export type ScrollMatch = {
  shift: number;
  fixedTop: number;
  fixedBottom: number;
  score: number;
  distinct: number;
};

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function isPointInsideRect(point: { x: number; y: number }, rect: Rect) {
  return (
    point.x >= rect.x &&
    point.y >= rect.y &&
    point.x <= rect.x + rect.width &&
    point.y <= rect.y + rect.height
  );
}

export function nextPaint() {
  return new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()));
  });
}

export function loadImage(dataUrl: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image load failed"));
    img.src = dataUrl;
  });
}

export function canvasFrame(canvas: HTMLCanvasElement): BitmapFrame {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas context unavailable");
  return {
    canvas,
    imageData: ctx.getImageData(0, 0, canvas.width, canvas.height),
    width: canvas.width,
    height: canvas.height
  };
}

export async function frameFromDataUrl(dataUrl: string): Promise<BitmapFrame> {
  const img = await loadImage(dataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas context unavailable");
  ctx.drawImage(img, 0, 0);
  return canvasFrame(canvas);
}

export function cloneCanvas(source: HTMLCanvasElement) {
  const canvas = document.createElement("canvas");
  canvas.width = source.width;
  canvas.height = source.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas context unavailable");
  ctx.drawImage(source, 0, 0);
  return canvas;
}

export function previewDataUrl(canvas: HTMLCanvasElement) {
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

export function buildScrollCaptureRequest(
  capture: CapturePayload,
  selection: Rect,
  viewportWidth: number,
  viewportHeight: number
): ScrollCaptureRequest {
  const scaleX = capture.width / Math.max(1, viewportWidth);
  const scaleY = capture.height / Math.max(1, viewportHeight);
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

export function cropInitialScrollFrame(
  image: HTMLImageElement,
  request: ScrollCaptureRequest
): BitmapFrame | null {
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

export function normalizeScrollDelta(deltaY: number) {
  if (!deltaY) return 0;
  const direction = deltaY < 0 ? -1 : 1;
  return direction * clamp(Math.abs(deltaY), 80, 240);
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

export function framesAreSimilar(previous: BitmapFrame, current: BitmapFrame) {
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

export function findScrollMatch(previous: BitmapFrame, current: BitmapFrame, direction: "down" | "up"): ScrollMatch | null {
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

export function appendFrame(stitched: HTMLCanvasElement, current: BitmapFrame, match: ScrollMatch) {
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

export function prependFrame(stitched: HTMLCanvasElement, current: BitmapFrame, match: ScrollMatch) {
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

export function fitImageFrame(
  width: number,
  height: number,
  viewportWidth = window.innerWidth,
  viewportHeight = window.innerHeight
): Rect {
  const maxWidth = Math.max(160, viewportWidth - 64);
  const maxHeight = Math.max(160, viewportHeight - 116);
  const scale = Math.min(maxWidth / width, maxHeight / height, 1);
  const frameWidth = Math.max(1, Math.round(width * scale));
  const frameHeight = Math.max(1, Math.round(height * scale));
  return {
    x: Math.round((viewportWidth - frameWidth) / 2),
    y: Math.max(18, Math.round((viewportHeight - frameHeight) / 2) - 18),
    width: frameWidth,
    height: frameHeight
  };
}

type PresentCaptureOptions = {
  imageFrame?: Rect | null;
  notice?: string;
};

type UseScrollScreenshotOptions = {
  capture: CapturePayload | null;
  image: HTMLImageElement | null;
  selection: Rect | null;
  imageFrame: Rect | null;
  canvasRef: RefObject<AnnotationCanvasHandle | null>;
  commitTextDraft: () => void;
  presentCapture: (payload: CapturePayload, options?: PresentCaptureOptions) => Promise<void>;
  setHoverWindow: (rect: Rect | null) => void;
  setNotice: (notice: string) => void;
  setTool: (tool: AnnotationTool) => void;
};

export function useScrollScreenshot({
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
}: UseScrollScreenshotOptions) {
  const [scrollMode, setScrollMode] = useState(false);
  const [scrollBusy, setScrollBusy] = useState(false);
  const [scrollPreviewUrl, setScrollPreviewUrl] = useState<string | null>(null);
  const [scrollProgress, setScrollProgress] = useState<ScrollProgress | null>(null);
  const scrollSessionRef = useRef<ScrollSession | null>(null);
  const scrollStepRunningRef = useRef(false);
  const pendingScrollDeltaRef = useRef(0);
  const pendingScrollFinishRef = useRef(false);

  function resetScrollCaptureState(notice?: string) {
    pendingScrollDeltaRef.current = 0;
    pendingScrollFinishRef.current = false;
    scrollStepRunningRef.current = false;
    scrollSessionRef.current = null;
    setScrollMode(false);
    setScrollBusy(false);
    setScrollPreviewUrl(null);
    setScrollProgress(null);
    if (notice !== undefined) setNotice(notice);
  }

  async function startScrollCapture() {
    if (!capture || !selection || !image || imageFrame || scrollMode || scrollBusy) return;
    const request = buildScrollCaptureRequest(capture, selection, window.innerWidth, window.innerHeight);
    const initialFrame = cropInitialScrollFrame(image, request);
    if (!initialFrame) return;

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
      resetScrollCaptureState(String(error || "长截图启动失败"));
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
    const delta = normalizeScrollDelta(pending);
    pendingScrollDeltaRef.current = 0;
    return delta;
  }

  function queueScrollCapture(deltaY: number) {
    if (!scrollMode || !scrollSessionRef.current) return;
    const normalized = normalizeScrollDelta(deltaY);
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
    resetScrollCaptureState("");
  }

  function handleScrollWheel(event: WheelEvent<HTMLElement>) {
    if (!scrollMode || !selection) return;
    const current = { x: event.clientX, y: event.clientY };
    if (!isPointInsideRect(current, selection)) return;
    event.preventDefault();
    event.stopPropagation();
    queueScrollCapture(event.deltaY || 120);
  }

  return {
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
  };
}
