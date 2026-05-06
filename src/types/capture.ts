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
};

export type AnnotationTool =
  | "select"
  | "rect"
  | "ellipse"
  | "arrow"
  | "pen"
  | "text";

export type AnnotationShape =
  | {
      id: string;
      type: "rect" | "ellipse" | "arrow" | "pen";
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
