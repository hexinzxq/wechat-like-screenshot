"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { AnnotationShape, AnnotationTool, Rect } from "@/types/capture";
import { clamp } from "@/lib/image";

type Point = { x: number; y: number };

export type AnnotationCanvasHandle = {
  exportSelection: () => string | null;
  addText: (text: { x: number; y: number; text: string; color: string; lineWidth: number }) => void;
  undo: () => void;
  clear: () => void;
};

type Props = {
  image: HTMLImageElement | null;
  imageDataUrl: string;
  selection: Rect | null;
  tool: AnnotationTool;
  color: string;
  lineWidth: number;
  onTextPoint: (point: Point) => void;
};

function drawArrowHead(ctx: CanvasRenderingContext2D, from: Point, to: Point, size: number) {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  ctx.beginPath();
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(to.x - size * Math.cos(angle - Math.PI / 6), to.y - size * Math.sin(angle - Math.PI / 6));
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(to.x - size * Math.cos(angle + Math.PI / 6), to.y - size * Math.sin(angle + Math.PI / 6));
  ctx.stroke();
}

function drawShape(ctx: CanvasRenderingContext2D, shape: AnnotationShape, offsetX = 0, offsetY = 0) {
  ctx.save();
  ctx.strokeStyle = shape.color;
  ctx.fillStyle = shape.color;
  ctx.lineWidth = shape.lineWidth;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  if (shape.type === "text") {
    ctx.font = `${shape.fontSize}px "Microsoft YaHei", sans-serif`;
    ctx.textBaseline = "top";
    ctx.fillText(shape.text, shape.x - offsetX, shape.y - offsetY);
    ctx.restore();
    return;
  }

  const points = shape.points.map((point) => ({
    x: point.x - offsetX,
    y: point.y - offsetY
  }));

  if (shape.type === "rect" && points.length >= 2) {
    const [start, end] = points;
    ctx.strokeRect(start.x, start.y, end.x - start.x, end.y - start.y);
  }

  if (shape.type === "ellipse" && points.length >= 2) {
    const [start, end] = points;
    ctx.beginPath();
    ctx.ellipse(
      (start.x + end.x) / 2,
      (start.y + end.y) / 2,
      Math.abs(end.x - start.x) / 2,
      Math.abs(end.y - start.y) / 2,
      0,
      0,
      Math.PI * 2
    );
    ctx.stroke();
  }

  if (shape.type === "arrow" && points.length >= 2) {
    const [start, end] = points;
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();
    drawArrowHead(ctx, start, end, Math.max(12, shape.lineWidth * 4));
  }

  if (shape.type === "pen" && points.length >= 2) {
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    points.slice(1).forEach((point) => ctx.lineTo(point.x, point.y));
    ctx.stroke();
  }

  ctx.restore();
}

function insideSelection(point: Point, selection: Rect) {
  return (
    point.x >= selection.x &&
    point.y >= selection.y &&
    point.x <= selection.x + selection.width &&
    point.y <= selection.y + selection.height
  );
}

function shapeId() {
  return `shape-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export const AnnotationCanvas = forwardRef<AnnotationCanvasHandle, Props>(function AnnotationCanvas(
  { image, imageDataUrl, selection, tool, color, lineWidth, onTextPoint },
  ref
) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [shapes, setShapes] = useState<AnnotationShape[]>([]);
  const [draft, setDraft] = useState<AnnotationShape | null>(null);
  const drawing = useRef(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const ratio = window.devicePixelRatio || 1;
    const width = window.innerWidth;
    const height = window.innerHeight;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    if (selection) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(selection.x, selection.y, selection.width, selection.height);
      ctx.clip();
      shapes.forEach((shape) => drawShape(ctx, shape));
      if (draft) drawShape(ctx, draft);
      ctx.restore();
    }
  }, [draft, selection, shapes]);

  useImperativeHandle(
    ref,
    () => ({
      exportSelection() {
        if (!selection || !image) return null;
        const viewportWidth = Math.max(1, window.innerWidth);
        const viewportHeight = Math.max(1, window.innerHeight);
        const scaleX = image.naturalWidth / viewportWidth;
        const scaleY = image.naturalHeight / viewportHeight;
        const sourceX = Math.round(selection.x * scaleX);
        const sourceY = Math.round(selection.y * scaleY);
        const sourceWidth = Math.max(1, Math.round(selection.width * scaleX));
        const sourceHeight = Math.max(1, Math.round(selection.height * scaleY));
        const canvas = document.createElement("canvas");
        canvas.width = sourceWidth;
        canvas.height = sourceHeight;
        const ctx = canvas.getContext("2d");
        if (!ctx) return null;
        ctx.drawImage(
          image,
          sourceX,
          sourceY,
          sourceWidth,
          sourceHeight,
          0,
          0,
          sourceWidth,
          sourceHeight
        );
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, sourceWidth, sourceHeight);
        ctx.clip();
        ctx.scale(scaleX, scaleY);
        shapes.forEach((shape) => drawShape(ctx, shape, selection.x, selection.y));
        ctx.restore();
        return canvas.toDataURL("image/png");
      },
      addText(text) {
        if (!text.text.trim()) return;
        setShapes((items) => [
          ...items,
          {
            id: shapeId(),
            type: "text",
            color: text.color,
            lineWidth: text.lineWidth,
            x: text.x,
            y: text.y,
            text: text.text.trim(),
            fontSize: 20
          }
        ]);
      },
      undo() {
        setShapes((items) => items.slice(0, -1));
      },
      clear() {
        setShapes([]);
      }
    }),
    [image, selection, shapes]
  );

  function pointerPoint(event: React.PointerEvent<HTMLCanvasElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: clamp(event.clientX - bounds.left, 0, bounds.width),
      y: clamp(event.clientY - bounds.top, 0, bounds.height)
    };
  }

  function handlePointerDown(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!selection || tool === "select") return;
    event.preventDefault();
    event.stopPropagation();
    const point = pointerPoint(event);
    if (!insideSelection(point, selection)) return;

    if (tool === "text") {
      onTextPoint(point);
      return;
    }

    event.currentTarget.setPointerCapture(event.pointerId);
    drawing.current = true;
    const base = {
      id: shapeId(),
      type: tool,
      color,
      lineWidth,
      points: [point, point]
    } as AnnotationShape;
    setDraft(base);
  }

  function handlePointerMove(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current || !draft || !selection || draft.type === "text") return;
    event.preventDefault();
    event.stopPropagation();
    const point = pointerPoint(event);
    const bounded = {
      x: clamp(point.x, selection.x, selection.x + selection.width),
      y: clamp(point.y, selection.y, selection.y + selection.height)
    };
    if (draft.type === "pen") {
      setDraft({ ...draft, points: [...draft.points, bounded] });
      return;
    }
    setDraft({ ...draft, points: [draft.points[0], bounded] });
  }

  function handlePointerUp(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.releasePointerCapture(event.pointerId);
    drawing.current = false;
    if (draft && draft.type !== "text") {
      const distance =
        draft.points.length >= 2
          ? Math.hypot(
              draft.points[draft.points.length - 1].x - draft.points[0].x,
              draft.points[draft.points.length - 1].y - draft.points[0].y
            )
          : 0;
      if (distance > 2) setShapes((items) => [...items, draft]);
    }
    setDraft(null);
  }

  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="capture-image" src={imageDataUrl} alt="" draggable={false} />
      <canvas
        ref={canvasRef}
        className="annotation-canvas"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      />
    </>
  );
});
