import type { Asset, DocumentState, Layer, Point, View } from './types';
import { localToWorld, worldToLocal } from './geometry';
import { alphaBounds } from './pixels';
export function canvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  if (!c.getContext('2d')) throw new Error('浏览器无法创建画布'); return c;
}
export function alphaCanvas(mask: Uint8Array, w: number, h: number, color = [255, 255, 255], opacity = 1, maxSide = Infinity): HTMLCanvasElement {
  const ratio = Math.min(1, maxSide / Math.max(w, h)), dw = Math.max(1, Math.round(w * ratio)), dh = Math.max(1, Math.round(h * ratio));
  const c = canvas(dw, dh), data = c.getContext('2d')!.createImageData(dw, dh);
  for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
    const i = y * dw + x;
    const sx = Math.min(w - 1, Math.max(0, (x + .5) * w / dw - .5)), sy = Math.min(h - 1, Math.max(0, (y + .5) * h / dh - .5));
    const x0 = Math.floor(sx), y0 = Math.floor(sy), x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1), fx = sx - x0, fy = sy - y0;
    const alpha = (mask[y0 * w + x0] * (1 - fx) + mask[y0 * w + x1] * fx) * (1 - fy) + (mask[y1 * w + x0] * (1 - fx) + mask[y1 * w + x1] * fx) * fy;
    data.data[i * 4] = color[0]; data.data[i * 4 + 1] = color[1]; data.data[i * 4 + 2] = color[2]; data.data[i * 4 + 3] = Math.round(alpha * opacity);
  }
  c.getContext('2d')!.putImageData(data, 0, 0); return c;
}
export class Renderer {
  private layers = new Map<string, { mask: Uint8Array | null; enabled: boolean; asset: string; image: HTMLCanvasElement }>();
  private overlay: { mask: Uint8Array; image: HTMLCanvasElement } | null = null;
  private viewport: { x: number; y: number; width: number; height: number; zoom: number } | null = null;
  constructor(public assets: Map<string, Asset>) {}
  invalidate(id?: string): void {
    if (this.overlay) { this.overlay.image.width = 0; this.overlay = null; }
    if (id) { const cached = this.layers.get(id); if (cached) cached.image.width = 0; this.layers.delete(id); }
  }
  image(l: Layer, full = false): HTMLCanvasElement {
    const previous = this.layers.get(l.id);
    if (!full && previous && previous.mask === l.mask && previous.enabled === l.maskEnabled && previous.asset === l.asset) return previous.image;
    const a = this.assets.get(l.asset); if (!a) throw new Error('图层原图丢失');
    const ratio = full ? 1 : Math.min(1, 2048 / Math.max(l.width, l.height));
    const c = canvas(Math.max(1, Math.round(l.width * ratio)), Math.max(1, Math.round(l.height * ratio))), ctx = c.getContext('2d')!;
    ctx.drawImage(a.bitmap, 0, 0, c.width, c.height);
    if (l.mask && l.maskEnabled) { const mask = alphaCanvas(l.mask, l.width, l.height, [255, 255, 255], 1, full ? Infinity : 2048); ctx.globalCompositeOperation = 'destination-in'; ctx.drawImage(mask, 0, 0, c.width, c.height); mask.width = 0; }
    if (full) return c;
    if (previous) previous.image.width = 0;
    this.layers.set(l.id, { mask: l.mask, enabled: l.maskEnabled, asset: l.asset, image: c }); return c;
  }
  layer(ctx: CanvasRenderingContext2D, l: Layer, full = false): void {
    if (!l.visible) return;
    ctx.save(); const t = l.transform; ctx.translate(t.x, t.y); ctx.rotate(t.angle); ctx.scale(t.sx, t.sy); ctx.globalAlpha = l.opacity;
    const viewport = this.viewport;
    // Zoomed views draw original pixels only in the visible source rectangle.
    // Large layers keep small preview caches without sacrificing precision when zooming in.
    if (!full && viewport && Math.max(l.width, l.height) > 2048 && viewport.zoom * Math.max(Math.abs(t.sx), Math.abs(t.sy)) > 2048 / Math.max(l.width, l.height)) {
      const { x, y, width, height } = viewport;
      const corners = [{ x, y }, { x: x + width, y }, { x, y: y + height }, { x: x + width, y: y + height }].map(p => worldToLocal(p, t));
      const left = Math.max(0, Math.floor(Math.min(...corners.map(p => p.x))) - 1), top = Math.max(0, Math.floor(Math.min(...corners.map(p => p.y))) - 1);
      const right = Math.min(l.width, Math.ceil(Math.max(...corners.map(p => p.x))) + 1), bottom = Math.min(l.height, Math.ceil(Math.max(...corners.map(p => p.y))) + 1);
      const w = right - left, h = bottom - top, asset = this.assets.get(l.asset);
      if (w > 0 && h > 0 && asset) {
        if (!l.mask || !l.maskEnabled) ctx.drawImage(asset.bitmap, left, top, w, h, left, top, w, h);
        else {
          const region = canvas(w, h), sub = region.getContext('2d')!, mask = new Uint8Array(w * h);
          sub.drawImage(asset.bitmap, left, top, w, h, 0, 0, w, h);
          for (let row = 0; row < h; row++) mask.set(l.mask.subarray((top + row) * l.width + left, (top + row) * l.width + right), row * w);
          const alpha = alphaCanvas(mask, w, h); sub.globalCompositeOperation = 'destination-in'; sub.drawImage(alpha, 0, 0); alpha.width = 0;
          ctx.drawImage(region, left, top); region.width = 0;
        }
      }
      ctx.restore(); return;
    }
    const image = this.image(l, full); ctx.drawImage(image, 0, 0, l.width, l.height); if (full) image.width = 0; ctx.restore();
  }
  compose(ctx: CanvasRenderingContext2D, doc: DocumentState, full = false): void {
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, doc.width, doc.height); ctx.clip();
    for (const l of doc.layers) this.layer(ctx, l, full); ctx.restore();
  }
  draw(target: HTMLCanvasElement, doc: DocumentState, view: View, handles: boolean, path: Point[] = [], preview?: Uint8Array | null): void {
    const ctx = target.getContext('2d')!, dpr = window.devicePixelRatio || 1, rect = target.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width * dpr)), height = Math.max(1, Math.round(rect.height * dpr));
    if (target.width !== width || target.height !== height) { target.width = width; target.height = height; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, rect.width, rect.height);
    ctx.translate(view.x, view.y); ctx.scale(view.zoom, view.zoom);
    this.viewport = { x: -view.x / view.zoom, y: -view.y / view.zoom, width: rect.width / view.zoom, height: rect.height / view.zoom, zoom: view.zoom };
    if (view.background === 'transparent') {
      const tile = canvas(16, 16), t = tile.getContext('2d')!; t.fillStyle = '#fff'; t.fillRect(0, 0, 16, 16); t.fillStyle = '#ddd'; t.fillRect(0, 0, 8, 8); t.fillRect(8, 8, 8, 8);
      ctx.fillStyle = ctx.createPattern(tile, 'repeat')!;
    } else ctx.fillStyle = view.background;
    ctx.fillRect(0, 0, doc.width, doc.height); this.compose(ctx, doc);
    ctx.strokeStyle = '#888'; ctx.lineWidth = 1 / view.zoom; ctx.strokeRect(0, 0, doc.width, doc.height);
    const l = doc.layers.find(l => l.id === doc.active), mask = preview === undefined ? l?.selection : preview;
    if (l && mask) {
      if (this.overlay?.mask !== mask) { if (this.overlay) this.overlay.image.width = 0; this.overlay = { mask, image: alphaCanvas(mask, l.width, l.height, [0, 120, 240], .35, 2048) }; }
      ctx.save(); const t = l.transform; ctx.translate(t.x, t.y); ctx.rotate(t.angle); ctx.scale(t.sx, t.sy); ctx.drawImage(this.overlay.image, 0, 0, l.width, l.height); ctx.restore();
    }
    if (l && handles) {
      const corners = this.handles(l), r = 4 / view.zoom;
      ctx.beginPath(); corners.slice(0, 4).forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.closePath(); ctx.strokeStyle = '#146dcc'; ctx.stroke();
      ctx.beginPath(); const top = localToWorld({ x: l.width / 2, y: 0 }, l.transform); ctx.moveTo(top.x, top.y); ctx.lineTo(corners[4].x, corners[4].y); ctx.stroke();
      ctx.fillStyle = '#fff'; for (const p of corners) { ctx.fillRect(p.x - r, p.y - r, r * 2, r * 2); ctx.strokeRect(p.x - r, p.y - r, r * 2, r * 2); }
    }
    if (path.length) {
      ctx.beginPath(); path.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.strokeStyle = '#146dcc'; ctx.lineWidth = 1.5 / view.zoom; ctx.stroke();
    }
    const live = new Set(doc.layers.map(l => l.id));
    for (const [id, c] of this.layers) if (!live.has(id)) { c.image.width = 0; this.layers.delete(id); }
  }
  handles(l: Layer): Point[] {
    const points = [{ x: 0, y: 0 }, { x: l.width, y: 0 }, { x: l.width, y: l.height }, { x: 0, y: l.height }].map(p => localToWorld(p, l.transform));
    const top = localToWorld({ x: l.width / 2, y: 0 }, l.transform), center = localToWorld({ x: l.width / 2, y: l.height / 2 }, l.transform);
    const d = Math.max(1, Math.hypot(top.x - center.x, top.y - center.y));
    points.push({ x: top.x + (top.x - center.x) / d * 28, y: top.y + (top.y - center.y) / d * 28 }); return points;
  }
  async export(doc: DocumentState, type: string, quality: number, background: string): Promise<Blob> {
    const c = canvas(doc.width, doc.height), ctx = c.getContext('2d')!;
    if (type === 'image/jpeg') { ctx.fillStyle = background; ctx.fillRect(0, 0, doc.width, doc.height); }
    this.compose(ctx, doc, true);
    try { return await new Promise<Blob>((resolve, reject) => c.toBlob(blob => blob ? resolve(blob) : reject(new Error('图片导出失败，可能超出设备画布限制')), type, quality)); }
    finally { c.width = 0; }
  }
  transparentBounds(doc: DocumentState): ReturnType<typeof alphaBounds> {
    const c = canvas(doc.width, doc.height);
    try {
      const ctx = c.getContext('2d')!; this.compose(ctx, doc, true);
      let left = doc.width, top = doc.height, right = 0, bottom = 0;
      // Read strips to avoid allocating another full-resolution RGBA buffer.
      for (let y = 0; y < doc.height; y += 128) {
        const height = Math.min(128, doc.height - y);
        const bounds = alphaBounds(ctx.getImageData(0, y, doc.width, height).data, doc.width, height);
        if (!bounds) continue;
        left = Math.min(left, bounds.x); top = Math.min(top, y + bounds.y);
        right = Math.max(right, bounds.x + bounds.width); bottom = Math.max(bottom, y + bounds.y + bounds.height);
      }
      return right > left && bottom > top ? { x: left, y: top, width: right - left, height: bottom - top } : null;
    } finally { c.width = 0; }
  }
  async merge(layers: Layer[]): Promise<{ blob: Blob; bitmap: ImageBitmap; x: number; y: number }> {
    if (layers.length < 2) throw new Error('至少需要两个可见图层');
    const corners = layers.flatMap(l => [{ x: 0, y: 0 }, { x: l.width, y: 0 }, { x: 0, y: l.height }, { x: l.width, y: l.height }].map(p => localToWorld(p, l.transform)));
    const x = Math.floor(Math.min(...corners.map(p => p.x))), y = Math.floor(Math.min(...corners.map(p => p.y)));
    const width = Math.max(1, Math.ceil(Math.max(...corners.map(p => p.x))) - x), height = Math.max(1, Math.ceil(Math.max(...corners.map(p => p.y))) - y);
    if (!Number.isFinite(width + height) || width > 16384 || height > 16384) throw new Error('合并结果超出支持的尺寸，请先调整图层大小或位置');
    const c = canvas(width, height);
    try {
      const ctx = c.getContext('2d')!; ctx.translate(-x, -y);
      // Do not clip to the document: off-canvas pixels must survive the merge.
      for (const l of layers) this.layer(ctx, l, true);
      const blob = await new Promise<Blob>((resolve, reject) => c.toBlob(blob => blob ? resolve(blob) : reject(new Error('合并失败，可能超出设备画布限制')), 'image/png'));
      return { blob, bitmap: await createImageBitmap(blob), x, y };
    } finally { c.width = 0; }
  }
  dispose(): void { for (const c of this.layers.values()) c.image.width = 0; this.layers.clear(); if (this.overlay) this.overlay.image.width = 0; }
}
