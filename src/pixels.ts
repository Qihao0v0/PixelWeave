export interface FillInput {
  kind: 'fill'; width: number; height: number; pixels: Uint8ClampedArray;
  x: number; y: number; color: number[]; tolerance: number;
  selection: Uint8Array | null; mask: Uint8Array | null;
}

// Four-connected fill; fully transparent pixels compare without their hidden RGB.
export function floodFill(input: FillInput): { pixels: Uint8ClampedArray; changed: boolean } {
  const { width: w, height: h, pixels: source, selection, mask, color } = input;
  const pixels = source.slice(), n = w * h, x = Math.floor(input.x), y = Math.floor(input.y);
  if (x < 0 || y < 0 || x >= w || y >= h) return { pixels, changed: false };
  const seed = y * w + x, offset = seed * 4, tolerance = Math.max(0, Math.min(255, input.tolerance));
  const visited = new Uint8Array(n), queue = new Int32Array(n);
  let head = 0, tail = 0, changed = false;
  const visit = (i: number) => {
    if (visited[i]) return;
    visited[i] = 1;
    if ((selection && !selection[i]) || (mask && !mask[i])) return;
    const j = i * 4;
    if (Math.abs(source[j + 3] - source[offset + 3]) > tolerance) return;
    if ((source[j + 3] || source[offset + 3]) &&
        Math.max(Math.abs(source[j] - source[offset]), Math.abs(source[j + 1] - source[offset + 1]), Math.abs(source[j + 2] - source[offset + 2])) > tolerance) return;
    queue[tail++] = i;
  };
  visit(seed);
  while (head < tail) {
    const i = queue[head++], j = i * 4, coverage = (selection?.[i] ?? 255) / 255;
    const alpha = coverage + source[j + 3] / 255 * (1 - coverage);
    for (let c = 0; c < 3; c++) pixels[j + c] = (color[c] * coverage + source[j + c] * source[j + 3] / 255 * (1 - coverage)) / alpha;
    pixels[j + 3] = alpha * 255;
    if (!changed) for (let c = 0; c < 4; c++) if (pixels[j + c] !== source[j + c]) changed = true;
    if (i % w) visit(i - 1);
    if (i % w < w - 1) visit(i + 1);
    if (i >= w) visit(i - w);
    if (i < n - w) visit(i + w);
  }
  return { pixels, changed };
}

export function alphaBounds(pixels: Uint8ClampedArray, width: number, height: number): { x: number; y: number; width: number; height: number } | null {
  let left = width, top = height, right = -1, bottom = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (pixels[(y * width + x) * 4 + 3] === 0) continue;
    left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = y;
  }
  return right < 0 ? null : { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}
