import type { Point, Transform, Combine } from './types';
export function localToWorld(p: Point, t: Transform): Point {
  const c = Math.cos(t.angle), s = Math.sin(t.angle);
  return { x: t.x + c * p.x * t.sx - s * p.y * t.sy, y: t.y + s * p.x * t.sx + c * p.y * t.sy };
}
export function worldToLocal(p: Point, t: Transform): Point {
  const c = Math.cos(t.angle), s = Math.sin(t.angle), x = p.x - t.x, y = p.y - t.y;
  return { x: (c * x + s * y) / t.sx, y: (-s * x + c * y) / t.sy };
}
export function combineMasks(base: Uint8Array | null, next: Uint8Array, mode: Combine): Uint8Array {
  const out = new Uint8Array(next.length);
  for (let i = 0; i < out.length; i++) {
    const a = base?.[i] ?? 0, b = next[i];
    out[i] = mode === 'replace' ? b : mode === 'add' ? Math.max(a, b) : mode === 'subtract' ? Math.round(a * (1 - b / 255)) : Math.min(a, b);
  }
  return out;
}
export function multiplyMasks(a: Uint8Array | null, b: Uint8Array): Uint8Array {
  return b.map((v, i) => Math.round(v * (a?.[i] ?? 255) / 255));
}
export function stamp(mask: Uint8Array, w: number, h: number, p: Point, radius: number, value: number): void {
  const r = Math.max(.5, radius), r2 = r * r;
  for (let y = Math.max(0, Math.floor(p.y - r)); y < Math.min(h, Math.ceil(p.y + r)); y++)
    for (let x = Math.max(0, Math.floor(p.x - r)); x < Math.min(w, Math.ceil(p.x + r)); x++)
      if ((x + .5 - p.x) ** 2 + (y + .5 - p.y) ** 2 <= r2) mask[y * w + x] = value;
}
export function stroke(mask: Uint8Array, w: number, h: number, points: Point[], radius: number, value = 255): void {
  for (let i = 0; i < points.length; i++) {
    const a = points[Math.max(0, i - 1)], b = points[i], n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / Math.max(.5, radius / 3)));
    for (let j = 0; j <= n; j++) stamp(mask, w, h, { x: a.x + (b.x - a.x) * j / n, y: a.y + (b.y - a.y) * j / n }, radius, value);
  }
}
export function polygonMask(w: number, h: number, points: Point[]): Uint8Array {
  const out = new Uint8Array(w * h);
  if (points.length < 3) return out;
  const lo = Math.max(0, Math.floor(Math.min(...points.map(p => p.y)))), hi = Math.min(h - 1, Math.ceil(Math.max(...points.map(p => p.y))));
  for (let y = lo; y <= hi; y++) {
    const xs: number[] = [];
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const a = points[i], b = points[j], scan = y + .5;
      if ((a.y > scan) !== (b.y > scan)) xs.push(a.x + (scan - a.y) * (b.x - a.x) / (b.y - a.y));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2)
      for (let x = Math.max(0, Math.ceil(xs[k] - .5)); x <= Math.min(w - 1, Math.floor(xs[k + 1] - .5)); x++) out[y * w + x] = 255;
  }
  return out;
}
export function bounds(mask: Uint8Array, w: number): { x: number; y: number; width: number; height: number } | null {
  let minX = w, minY = mask.length / w, maxX = -1, maxY = -1;
  for (let i = 0; i < mask.length; i++) if (mask[i]) {
    const x = i % w, y = Math.floor(i / w); minX = Math.min(x, minX); minY = Math.min(y, minY); maxX = Math.max(x, maxX); maxY = Math.max(y, maxY);
  }
  return maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}
