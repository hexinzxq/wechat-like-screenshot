"use client";

import dynamic from "next/dynamic";
import { forwardRef, useImperativeHandle, useRef, useState } from "react";
import type { CSSProperties } from "react";
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
  toolbarPlacement?: { left: number; top: number; width: number; height: number } | null;
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

function toolbarStyle(selection: Rect, placement?: Props["toolbarPlacement"]) {
  if (placement) {
    return {
      "--excalidraw-toolbar-left": `${Math.round(placement.left)}px`,
      "--excalidraw-toolbar-top": `${Math.round(placement.top)}px`
    } as CSSProperties;
  }

  const viewportWidth = typeof window === "undefined" ? 1 : window.innerWidth;
  const viewportHeight = typeof window === "undefined" ? 1 : window.innerHeight;
  const toolbarWidth = 460;
  const toolbarHeight = 56;
  const gap = 10;
  const centerX = selection.x + selection.width / 2;
  const targetCenterX = clamp(centerX, toolbarWidth / 2 + 8, Math.max(toolbarWidth / 2 + 8, viewportWidth - toolbarWidth / 2 - 8));
  const hasMoreSpaceAbove = selection.y >= viewportHeight - selection.y - selection.height;
  let offsetY = hasMoreSpaceAbove ? -(toolbarHeight + gap) : selection.height + gap;

  const toolbarTop = selection.y + offsetY;
  if (toolbarTop < 8) {
    offsetY += 8 - toolbarTop;
  } else if (toolbarTop + toolbarHeight > viewportHeight - 8) {
    offsetY -= toolbarTop + toolbarHeight - (viewportHeight - 8);
  }

  return {
    "--excalidraw-toolbar-left": `${Math.round(targetCenterX - toolbarWidth / 2)}px`,
    "--excalidraw-toolbar-top": `${Math.round(selection.y + offsetY)}px`
  } as CSSProperties;
}

export const ExcalidrawLayer = forwardRef<ExcalidrawLayerHandle, Props>(function ExcalidrawLayer(
  { active, selection, toolbarPlacement },
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
  frameRef.current = selection;

  return (
    <div
      className={`excalidraw-layer${active ? " active" : ""}`}
      style={{
        left: selection.x,
        top: selection.y,
        width: selection.width,
        height: selection.height,
        ...toolbarStyle(selection, toolbarPlacement)
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
