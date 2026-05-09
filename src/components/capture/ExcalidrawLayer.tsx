"use client";

import dynamic from "next/dynamic";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { Rect } from "@/types/capture";

type ExcalidrawAPI = {
  getSceneElements: () => readonly any[];
  getAppState: () => Record<string, any>;
  getFiles: () => Record<string, any>;
  updateScene: (scene: { elements?: readonly any[]; appState?: Record<string, any> }) => void;
};

export type ExcalidrawLayerHandle = {
  exportDrawing: () => Promise<{ canvas: HTMLCanvasElement; x: number; y: number } | null>;
  clear: () => void;
  hasElements: () => boolean;
};

type Props = {
  active: boolean;
  selection: Rect | null;
};

type ViewportSize = {
  width: number;
  height: number;
};

const Excalidraw = dynamic(
  async () => {
    const module = await import("@excalidraw/excalidraw");
    return module.Excalidraw;
  },
  {
    ssr: false,
    loading: () => <div className="excalidraw-loading">加载高级绘图...</div>
  }
) as any;

function visibleElements(elements: readonly any[]) {
  return elements.filter((element) => !element.isDeleted);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function editorFrame(selection: Rect, viewport: ViewportSize): Rect {
  const width = Math.min(viewport.width, Math.max(selection.width + 520, 720));
  const height = Math.min(viewport.height, Math.max(selection.height + 360, 460));
  const spareX = Math.max(0, width - selection.width);
  const preferredLeft = selection.x - spareX / 2;
  const preferredTop = selection.y - Math.min(190, Math.max(80, height - selection.height - 120));

  return {
    x: Math.round(clamp(preferredLeft, 0, Math.max(0, viewport.width - width))),
    y: Math.round(clamp(preferredTop, 0, Math.max(0, viewport.height - height))),
    width: Math.round(width),
    height: Math.round(height)
  };
}

export const ExcalidrawLayer = forwardRef<ExcalidrawLayerHandle, Props>(function ExcalidrawLayer(
  { active, selection },
  ref
) {
  const apiRef = useRef<ExcalidrawAPI | null>(null);
  const elementsRef = useRef<readonly any[]>([]);
  const appStateRef = useRef<Record<string, any>>({});
  const filesRef = useRef<Record<string, any>>({});
  const elementCountRef = useRef(0);
  const lastDrawingToolRef = useRef<Record<string, any> | null>(null);
  const restoringToolRef = useRef(false);
  const frameRef = useRef<Rect | null>(null);
  const [hasElements, setHasElements] = useState(false);
  const [viewport, setViewport] = useState<ViewportSize>(() => ({
    width: typeof window === "undefined" ? 1 : Math.max(1, window.innerWidth),
    height: typeof window === "undefined" ? 1 : Math.max(1, window.innerHeight)
  }));

  useEffect(() => {
    function updateViewport() {
      setViewport({
        width: Math.max(1, window.innerWidth),
        height: Math.max(1, window.innerHeight)
      });
    }

    updateViewport();
    window.addEventListener("resize", updateViewport);
    return () => window.removeEventListener("resize", updateViewport);
  }, []);

  function isDrawingTool(activeTool: Record<string, any> | undefined) {
    if (!activeTool) return false;
    return !["selection", "hand", "eraser"].includes(activeTool.type);
  }

  function rememberDrawingTool(activeTool: Record<string, any> | undefined) {
    if (!isDrawingTool(activeTool)) return;
    lastDrawingToolRef.current = {
      ...activeTool,
      locked: true
    };
  }

  function keepDrawingToolLocked(appState: Record<string, any>, elementCount: number) {
    const activeTool = appState.activeTool;
    if (!activeTool || restoringToolRef.current) return;

    if (isDrawingTool(activeTool)) {
      rememberDrawingTool(activeTool);
      if (!activeTool.locked) {
        apiRef.current?.updateScene({
          appState: {
            activeTool: {
              ...activeTool,
              locked: true
            }
          }
        });
      }
      return;
    }

    const addedElement = elementCount > elementCountRef.current;
    if (activeTool.type === "selection" && addedElement && lastDrawingToolRef.current) {
      restoringToolRef.current = true;
      window.requestAnimationFrame(() => {
        apiRef.current?.updateScene({
          appState: {
            activeTool: lastDrawingToolRef.current
          }
        });
        restoringToolRef.current = false;
      });
    }
  }

  useImperativeHandle(
    ref,
    () => ({
      async exportDrawing() {
        const elements = visibleElements(apiRef.current?.getSceneElements() ?? elementsRef.current);
        if (!elements.length) return null;

        const [{ exportToCanvas, getCommonBounds }] = await Promise.all([
          import("@excalidraw/excalidraw")
        ]);
        const [minX, minY] = getCommonBounds(elements as never);
        const frame = frameRef.current;
        const canvas = await exportToCanvas({
          elements: elements as never,
          files: apiRef.current?.getFiles() ?? filesRef.current,
          appState: {
            ...appStateRef.current,
            exportBackground: false,
            viewBackgroundColor: "transparent",
            selectedElementIds: {},
            collaborators: new Map()
          },
          exportPadding: 0
        });

        return { canvas, x: (frame?.x ?? 0) + minX, y: (frame?.y ?? 0) + minY };
      },
      clear() {
        elementsRef.current = [];
        setHasElements(false);
        apiRef.current?.updateScene({ elements: [] });
      },
      hasElements() {
        return hasElements;
      }
    }),
    [hasElements]
  );

  if (!selection || (!active && !hasElements)) return null;
  const frame = editorFrame(selection, viewport);
  frameRef.current = frame;

  return (
    <div
      className={`excalidraw-layer${active ? " active" : ""}`}
      style={{
        left: frame.x,
        top: frame.y,
        width: frame.width,
        height: frame.height
      }}
    >
      <Excalidraw
        excalidrawAPI={(api: any) => {
          apiRef.current = api;
        }}
        initialData={{
          appState: {
            viewBackgroundColor: "transparent",
            currentItemStrokeColor: "#ff4d4f",
            currentItemBackgroundColor: "transparent",
            currentItemStrokeWidth: 2,
            scrollX: 0,
            scrollY: 0,
            zoom: { value: 1 },
            activeTool: {
              type: "selection",
              customType: null,
              locked: true,
              lastActiveTool: null
            },
            theme: "dark"
          }
        } as any}
        onChange={(elements: readonly any[], appState: Record<string, any>, files: Record<string, any>) => {
          const elementCount = visibleElements(elements).length;
          keepDrawingToolLocked(appState, elementCount);
          elementsRef.current = elements;
          appStateRef.current = appState;
          filesRef.current = files;
          elementCountRef.current = elementCount;
          setHasElements(elementCount > 0);
        }}
        onPointerDown={(activeTool: Record<string, any>) => {
          rememberDrawingTool(activeTool);
        }}
        UIOptions={{
          canvasActions: {
            changeViewBackgroundColor: false,
            clearCanvas: false,
            export: false,
            loadScene: false,
            saveAsImage: false,
            saveToActiveFile: false,
            toggleTheme: false
          },
          tools: {
            image: false
          },
          welcomeScreen: false
        }}
      />
    </div>
  );
});
