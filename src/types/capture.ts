export type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type CapturePayload = {
  imageDataUrl: string;
  width: number;
  height: number;
  originX: number;
  originY: number;
  windows?: Rect[];
};

export type AnnotationTool =
  | "select"
  | "rect"
  | "diamond"
  | "ellipse"
  | "arrow"
  | "pen"
  | "text"
  | "excalidraw";

export type AnnotationShape =
  | {
      id: string;
      type: "rect" | "diamond" | "ellipse" | "arrow" | "pen";
      color: string;
      lineWidth: number;
      points: Array<{ x: number; y: number }>;
    }
  | {
      id: string;
      type: "text";
      color: string;
      lineWidth: number;
      x: number;
      y: number;
      text: string;
      fontSize: number;
    };
