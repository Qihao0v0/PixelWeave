// Raw linear-memory API keeps browser/Worker integration independent of a JS runtime.
export function alloc(length: i32): usize { return __pin(changetype<usize>(new ArrayBuffer(length))); }
export function free(ptr: usize): void { __unpin(ptr); }
function diff(pixels: usize, a: i32, b: i32): f64 {
  let sum: f64 = 0;
  for (let c = 0; c < 3; c++) { const d = <f64>load<u8>(pixels + a * 4 + c) - <f64>load<u8>(pixels + b * 4 + c); sum += d * d; }
  return sum;
}
export function color(pixels: usize, out: usize, w: i32, h: i32, seed: i32, tolerance: f64, contiguous: bool): void {
  const n = w * h, limit = tolerance * tolerance * 3;
  if (!contiguous) {
    for (let i = 0; i < n; i++) store<u8>(out + i, load<u8>(pixels + i * 4 + 3) > 0 && diff(pixels, i, seed) <= limit ? 255 : 0);
    return;
  }
  const queue = new Int32Array(n); let head = 0, tail = 0;
  if (load<u8>(pixels + seed * 4 + 3) == 0) return;
  queue[tail++] = seed; store<u8>(out + seed, 255);
  while (head < tail) {
    const i = queue[head++], x = i % w, y = i / w;
    for (let d = 0; d < 4; d++) {
      const j = d == 0 ? i - 1 : d == 1 ? i + 1 : d == 2 ? i - w : i + w;
      if ((d == 0 && x == 0) || (d == 1 && x == w - 1) || (d == 2 && y == 0) || (d == 3 && y == h - 1)) continue;
      if (load<u8>(out + j) == 0 && load<u8>(pixels + j * 4 + 3) > 0 && diff(pixels, j, seed) <= limit) {
        store<u8>(out + j, 255); queue[tail++] = j;
      }
    }
  }
}
class Flow {
  head: Int32Array; to: Int32Array; next: Int32Array; cap: Float64Array; level: Int32Array; it: Int32Array; queue: Int32Array; edges: i32 = 0;
  constructor(n: i32, capacity: i32) {
    this.head = new Int32Array(n); this.to = new Int32Array(capacity); this.next = new Int32Array(capacity);
    this.cap = new Float64Array(capacity); this.level = new Int32Array(n); this.it = new Int32Array(n); this.queue = new Int32Array(n); this.head.fill(-1);
  }
  edge(a: i32, b: i32, c: f64, reverse: f64 = 0): void {
    let e = this.edges++; this.to[e] = b; this.cap[e] = c; this.next[e] = this.head[a]; this.head[a] = e;
    e = this.edges++; this.to[e] = a; this.cap[e] = reverse; this.next[e] = this.head[b]; this.head[b] = e;
  }
  bfs(s: i32, t: i32): bool {
    this.level.fill(-1); let start = 0, end = 0; this.queue[end++] = s; this.level[s] = 0;
    while (start < end) {
      const v = this.queue[start++];
      for (let e = this.head[v]; e != -1; e = this.next[e]) if (this.cap[e] > .000001 && this.level[this.to[e]] < 0) {
        this.level[this.to[e]] = this.level[v] + 1; this.queue[end++] = this.to[e];
      }
    }
    return this.level[t] >= 0;
  }
  dfs(v: i32, t: i32, f: f64): f64 {
    if (v == t) return f;
    while (this.it[v] != -1) {
      const e = this.it[v], u = this.to[e];
      if (this.cap[e] > .000001 && this.level[u] == this.level[v] + 1) {
        const d = this.dfs(u, t, Math.min(f, this.cap[e]));
        if (d > .000001) { this.cap[e] -= d; this.cap[e ^ 1] += d; return d; }
      }
      this.it[v] = this.next[e];
    }
    return 0;
  }
  solve(s: i32, t: i32): void {
    while (this.bfs(s, t)) { this.it.set(this.head); while (this.dfs(s, t, 1e12) > .000001) {} }
    // Last BFS is the source-side residual cut.
  }
}
export function graphCut(pixels: usize, prior: usize, seeds: usize, out: usize, w: i32, h: i32): void {
  const n = w * h, source = n, sink = n + 1;
  const fg = new Float64Array(512), bg = new Float64Array(512); let nf: f64 = 0, nb: f64 = 0, gradient: f64 = 0;
  for (let i = 0; i < n; i++) {
    const bin = (<i32>load<u8>(pixels + 4 * i) >> 5) * 64 + (<i32>load<u8>(pixels + 4 * i + 1) >> 5) * 8 + (<i32>load<u8>(pixels + 4 * i + 2) >> 5);
    const seed = load<u8>(seeds + i), p = load<u8>(prior + i);
    if (seed == 1 || (seed == 0 && p > 127)) { fg[bin] += seed == 1 ? 8 : 1; nf += seed == 1 ? 8 : 1; }
    if (seed == 2 || (seed == 0 && p <= 127)) { bg[bin] += seed == 2 ? 8 : 1; nb += seed == 2 ? 8 : 1; }
    if (i % w < w - 1) gradient += diff(pixels, i, i + 1);
    if (i / w < h - 1) gradient += diff(pixels, i, i + w);
  }
  const beta = 1 / Math.max(1, gradient / <f64>n), graph = new Flow(n + 2, n * 12 + 8);
  for (let i = 0; i < n; i++) {
    const bin = (<i32>load<u8>(pixels + 4 * i) >> 5) * 64 + (<i32>load<u8>(pixels + 4 * i + 1) >> 5) * 8 + (<i32>load<u8>(pixels + 4 * i + 2) >> 5);
    const seed = load<u8>(seeds + i); let costF = -Math.log((fg[bin] + .1) / (nf + 51.2)), costB = -Math.log((bg[bin] + .1) / (nb + 51.2));
    // Weak inertia preserves the current solution where colour evidence is ambiguous.
    if (load<u8>(prior + i) > 127) costB += .6; else costF += .6;
    if (seed == 1) { costF = 0; costB = 1e8; }
    if (seed == 2 || load<u8>(pixels + i * 4 + 3) == 0) { costF = 1e8; costB = 0; }
    graph.edge(source, i, costB); graph.edge(i, sink, costF);
    if (i % w < w - 1) graph.edge(i, i + 1, 5 * Math.exp(-diff(pixels, i, i + 1) * beta) + .02, 5 * Math.exp(-diff(pixels, i, i + 1) * beta) + .02);
    if (i / w < h - 1) graph.edge(i, i + w, 5 * Math.exp(-diff(pixels, i, i + w) * beta) + .02, 5 * Math.exp(-diff(pixels, i, i + w) * beta) + .02);
  }
  graph.solve(source, sink);
  for (let i = 0; i < n; i++) store<u8>(out + i, graph.level[i] >= 0 ? 255 : 0);
}
// Sampling matting: estimate F/B colours from definite trimap pixels and solve I=aF+(1-a)B.
// Only the unknown band is changed; alpha is not generated by blurring a binary mask.
export function matte(pixels: usize, trimap: usize, prior: usize, out: usize, w: i32, h: i32, radius: i32): void {
  const n = w * h, reach = Math.max(8, radius * 4);
  const fs = new Int32Array(16), bs = new Int32Array(16);
  for (let i = 0; i < n; i++) {
    const t = load<u8>(trimap + i);
    if (t != 128) { store<u8>(out + i, t); continue; }
    const x = i % w, y = i / w;
    let best: f64 = 1e30, alpha: f64 = <f64>load<u8>(prior + i) / 255;
    fs.fill(-1); bs.fill(-1);
    for (let d = 0; d < 16; d++) {
      const theta: f64 = <f64>d * Math.PI / 8, dx = Math.cos(theta), dy = Math.sin(theta);
      for (let r = 1; r <= reach; r += max<i32>(1, r / 12)) {
        const xx = x + <i32>Math.round(dx * r), yy = y + <i32>Math.round(dy * r);
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) break;
        const j = yy * w + xx, v = load<u8>(trimap + j);
        if (v == 255 && fs[d] < 0) fs[d] = j;
        if (v == 0 && bs[d] < 0) bs[d] = j;
        if (fs[d] >= 0 && bs[d] >= 0) break;
      }
    }
    for (let f = 0; f < 16; f++) if (fs[f] >= 0) for (let b = 0; b < 16; b++) if (bs[b] >= 0) {
      let numer: f64 = 0, denom: f64 = .0001;
      for (let c = 0; c < 3; c++) {
        const fv: f64 = load<u8>(pixels + fs[f] * 4 + c), bv: f64 = load<u8>(pixels + bs[b] * 4 + c), iv: f64 = load<u8>(pixels + i * 4 + c);
        numer += (iv - bv) * (fv - bv); denom += (fv - bv) * (fv - bv);
      }
      const a = Math.max(0, Math.min(1, numer / denom)); let error: f64 = 0;
      for (let c = 0; c < 3; c++) { const est = a * <f64>load<u8>(pixels + fs[f] * 4 + c) + (1 - a) * <f64>load<u8>(pixels + bs[b] * 4 + c) - <f64>load<u8>(pixels + i * 4 + c); error += est * est; }
      error += .02 * (<f64>Math.abs(fs[f] % w - x) + Math.abs(fs[f] / w - y) + Math.abs(bs[b] % w - x) + Math.abs(bs[b] / w - y));
      if (error < best) { best = error; alpha = a; }
    }
    store<u8>(out + i, <u8>Math.round(alpha * 255));
  }
}
