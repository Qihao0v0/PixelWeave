export interface Kernel {
  memory: WebAssembly.Memory; alloc(n: number): number; free(p: number): void; __collect(): void;
  color(pixels: number, out: number, w: number, h: number, seed: number, tolerance: number, contiguous: number): void;
  graphCut(pixels: number, prior: number, seeds: number, out: number, w: number, h: number): void;
  matte(pixels: number, trimap: number, prior: number, out: number, w: number, h: number, radius: number): void;
}
export async function loadKernel(url: string | URL): Promise<Kernel> {
  const response = await fetch(url); if (!response.ok) throw new Error('无法加载计算模块');
  const { instance } = await WebAssembly.instantiate(await response.arrayBuffer(), { env: { abort: () => { throw new Error('计算内存不足或算法输入无效'); } } });
  return instance.exports as unknown as Kernel;
}
export function withBuffers<T>(k: Kernel, buffers: Uint8Array[], fn: (pointers: number[]) => T): T {
  const pointers: number[] = [];
  try {
    for (const buffer of buffers) {
      const p = k.alloc(buffer.byteLength); pointers.push(p);
      new Uint8Array(k.memory.buffer, p, buffer.byteLength).set(buffer);
    }
    return fn(pointers);
  } finally { pointers.forEach(p => k.free(p)); k.__collect(); }
}
