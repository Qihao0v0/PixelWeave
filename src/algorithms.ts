import type { AlgorithmInput, AlgorithmOutput } from './types';
import { stroke } from './geometry';
import { withBuffers, type Kernel } from './wasm';

export function makeTrimap(mask: Uint8Array, w: number, h: number, radius: number, constraints?: Uint8Array | null): Uint8Array {
  const n = w * h, distance = new Uint16Array(n).fill(65535), queue = new Int32Array(n); let start = 0, end = 0;
  for (let i = 0; i < n; i++) {
    const inside = mask[i] > 127;
    if ((i % w && (mask[i - 1] > 127) !== inside) || (i >= w && (mask[i - w] > 127) !== inside) || (i % w < w - 1 && (mask[i + 1] > 127) !== inside) || (i < n - w && (mask[i + w] > 127) !== inside)) {
      distance[i] = 0; queue[end++] = i;
    }
  }
  while (start < end) {
    const i = queue[start++], d = distance[i] + 1;
    if (d > radius) continue;
    for (const j of [i % w ? i - 1 : -1, i % w < w - 1 ? i + 1 : -1, i >= w ? i - w : -1, i < n - w ? i + w : -1])
      if (j >= 0 && d < distance[j]) { distance[j] = d; queue[end++] = j; }
  }
  return mask.map((v, i) => constraints?.[i] === 1 ? 255 : constraints?.[i] === 2 ? 0 : distance[i] <= radius ? 128 : v > 127 ? 255 : 0);
}

export function runAlgorithm(k: Kernel, input: AlgorithmInput): AlgorithmOutput {
  const { width: w, height: h, pixels, points, tolerance, radius } = input, n = w * h;
  if (!Number.isInteger(w) || !Number.isInteger(h) || n <= 0 || pixels.length !== n * 4) throw new Error('图片数据无效');
  if (input.kind === 'color' || input.kind === 'wand') {
    const p = points[0];
    if (!p || p.x < 0 || p.x >= w || p.y < 0 || p.y >= h) return { selection: new Uint8Array(n) };
    return withBuffers(k, [new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength), new Uint8Array(n)], ([src, out]) => {
      k.color(src, out, w, h, Math.floor(p.y) * w + Math.floor(p.x), tolerance, input.kind === 'wand' ? 1 : 0);
      return { selection: new Uint8Array(k.memory.buffer, out, n).slice() };
    });
  }
  if (input.kind === 'refine') {
    const prior = input.selection ?? new Uint8Array(n), trimap = makeTrimap(prior, w, h, radius, input.constraints);
    return withBuffers(k, [new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength), trimap, prior, new Uint8Array(n)], ([src, tri, old, out]) => {
      k.matte(src, tri, old, out, w, h, radius);
      return { selection: new Uint8Array(k.memory.buffer, out, n).slice() };
    });
  }
  const constraints = input.constraints?.slice() ?? new Uint8Array(n);
  stroke(constraints, w, h, points, radius, input.subtract ? 2 : 1);
  // Bound the changed region around the new stroke; frozen outer pixels preserve previous edits.
  const padding = Math.max(96, radius * 5);
  const x0 = Math.max(0, Math.floor(Math.min(...points.map(p => p.x)) - padding));
  const y0 = Math.max(0, Math.floor(Math.min(...points.map(p => p.y)) - padding));
  const x1 = Math.min(w, Math.ceil(Math.max(...points.map(p => p.x)) + padding));
  const y1 = Math.min(h, Math.ceil(Math.max(...points.map(p => p.y)) + padding));
  const rw = x1 - x0, rh = y1 - y0;
  if (rw <= 0 || rh <= 0) return { selection: input.selection?.slice() ?? new Uint8Array(n), constraints };
  const scale = Math.min(1, 192 / Math.max(rw, rh)), sw = Math.max(1, Math.round(rw * scale)), sh = Math.max(1, Math.round(rh * scale));
  const small = new Uint8Array(sw * sh * 4), prior = new Uint8Array(sw * sh), seeds = new Uint8Array(sw * sh);
  const touched = new Uint8Array(n); stroke(touched, w, h, points, radius);
  for (let yy = 0; yy < sh; yy++) for (let xx = 0; xx < sw; xx++) {
    const i = yy * sw + xx, x = Math.min(w - 1, x0 + Math.floor((xx + .5) / scale)), y = Math.min(h - 1, y0 + Math.floor((yy + .5) / scale)), j = y * w + x;
    small.set(pixels.subarray(j * 4, j * 4 + 4), i * 4); prior[i] = input.selection?.[j] ?? 0; seeds[i] = constraints[j];
    if (!seeds[i] && (xx === 0 || yy === 0 || xx === sw - 1 || yy === sh - 1)) seeds[i] = prior[i] > 127 ? 1 : 2;
  }
  // Thin strokes must survive downsampling.
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (touched[y * w + x]) {
    seeds[Math.min(sh - 1, Math.floor((y - y0) * scale)) * sw + Math.min(sw - 1, Math.floor((x - x0) * scale))] = input.subtract ? 2 : 1;
  }
  const result = withBuffers(k, [small, prior, seeds, new Uint8Array(sw * sh)], ([src, old, seed, out]) => {
    k.graphCut(src, old, seed, out, sw, sh); return new Uint8Array(k.memory.buffer, out, sw * sh).slice();
  });
  const selection = input.selection?.slice() ?? new Uint8Array(n);
  // Guided upsampling: choose the nearby low-res label with the closest source colour.
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const j = y * w + x;
    if (constraints[j]) { selection[j] = constraints[j] === 1 ? 255 : 0; continue; }
    const xx = Math.min(sw - 1, Math.floor((x - x0) * scale)), yy = Math.min(sh - 1, Math.floor((y - y0) * scale));
    let best = Infinity, label = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const sx = xx + dx, sy = yy + dy; if (sx < 0 || sy < 0 || sx >= sw || sy >= sh) continue;
      const i = sy * sw + sx;
      const score = (small[i * 4] - pixels[j * 4]) ** 2 + (small[i * 4 + 1] - pixels[j * 4 + 1]) ** 2 + (small[i * 4 + 2] - pixels[j * 4 + 2]) ** 2 + (dx * dx + dy * dy) * 8;
      if (score < best) { best = score; label = result[i]; }
    }
    selection[j] = pixels[j * 4 + 3] ? label : 0;
  }
  return { selection, constraints };
}
