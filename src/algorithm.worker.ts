/// <reference lib="webworker" />
import { loadKernel } from './wasm';
import { runAlgorithm } from './algorithms';
import type { AlgorithmInput } from './types';
let kernel: ReturnType<typeof loadKernel> | null = null;
self.onmessage = async (event: MessageEvent<{ id: number; url: string; input: AlgorithmInput }>) => {
  const { id, input, url } = event.data;
  try {
    kernel ??= loadKernel(url).catch(error => { kernel = null; throw error; });
    const result = runAlgorithm(await kernel, input);
    self.postMessage({ id, result }, { transfer: [result.selection.buffer, ...(result.constraints ? [result.constraints.buffer] : [])] });
  } catch (error) { self.postMessage({ id, error: String(error) }); }
};
