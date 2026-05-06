export function dataUrlToBase64(dataUrl: string) {
  const comma = dataUrl.indexOf(",");
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function normalizeRect(x1: number, y1: number, x2: number, y2: number) {
  const x = Math.min(x1, x2);
  const y = Math.min(y1, y2);
  return {
    x,
    y,
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1)
  };
}
