/// <reference lib="webworker" />
import { loadKernel } from './wasm';
import { runAlgorithm } from './algorithms';
import type { AlgorithmInput } from './types';
import { floodFill, type FillInput } from './pixels';
let kernel: ReturnType<typeof loadKernel> | null = null;
self.onmessage = async (event: MessageEvent<{ id: number; url: string; input: AlgorithmInput | FillInput }>) => {
  const { id, input, url } = event.data;
  try {
    if (input.kind === 'fill') {
      const result = floodFill(input);
      self.postMessage({ id, result }, { transfer: [result.pixels.buffer] }); return;
    }
    kernel ??= loadKernel(url).catch(error => { kernel = null; throw error; });
    const result = runAlgorithm(await kernel, input);
    self.postMessage({ id, result }, { transfer: [result.selection.buffer, ...(result.constraints ? [result.constraints.buffer] : [])] });
  } catch (error) { self.postMessage({ id, error: String(error) }); }
};
