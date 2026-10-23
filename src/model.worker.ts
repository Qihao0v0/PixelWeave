/// <reference lib="webworker" />
import { AutoProcessor, SamModel, RawImage, env } from '@huggingface/transformers';
env.allowLocalModels = false;
env.backends.onnx.wasm!.numThreads = 1;
// Vite copies the runtime alongside the lazily loaded worker, avoiding a CDN dependency.
const revision = '5850ab45f587c112167512ffef949107115e26a0';
let model: any = null, processor: any = null, embeddings: any = null, imageKey = '', prepared: any = null;
const disposeTensors = (value: any): void => { if (value?.dispose) value.dispose(); else if (value && typeof value === 'object') Object.values(value).forEach(disposeTensors); };
async function load(): Promise<void> {
  if (model) return;
  const progress_callback = (data: unknown) => self.postMessage({ progress: data });
  model = await SamModel.from_pretrained('Xenova/slimsam-77-uniform', { revision, dtype: 'q8', device: 'wasm', progress_callback });
  processor = await AutoProcessor.from_pretrained('Xenova/slimsam-77-uniform', { revision, progress_callback });
}
let queue = Promise.resolve();
self.onmessage = event => {
  queue = queue.then(async () => {
    const { id, action, pixels, width, height, key, points, labels } = event.data;
    try {
      if (event.data.runtime) env.backends.onnx.wasm!.wasmPaths = event.data.runtime;
      await load();
      if (action === 'load') { self.postMessage({ id, result: true }); return; }
      const image = new RawImage(new Uint8ClampedArray(pixels), width, height, 4);
      const inputs = await processor(image, { input_points: [points.map((p: { x: number; y: number }) => [p.x, p.y])], input_labels: [labels] });
      if (key !== imageKey || !embeddings) {
        disposeTensors(embeddings); disposeTensors(prepared);
        embeddings = await model.get_image_embeddings(inputs); imageKey = key; prepared = { original_sizes: inputs.original_sizes, reshaped_input_sizes: inputs.reshaped_input_sizes };
      }
      const outputs = await model({ ...embeddings, input_points: inputs.input_points, input_labels: inputs.input_labels });
      const masks = await processor.post_process_masks(outputs.pred_masks, inputs.original_sizes, inputs.reshaped_input_sizes);
      const scores = outputs.iou_scores.data as Float32Array; let best = 0;
      for (let i = 1; i < scores.length; i++) if (scores[i] > scores[best]) best = i;
      const mask = Uint8Array.from((masks[0].data as Uint8Array).subarray(best * width * height, (best + 1) * width * height), v => v ? 255 : 0);
      disposeTensors(outputs); disposeTensors(masks); disposeTensors(inputs.pixel_values); disposeTensors(inputs.input_points); disposeTensors(inputs.input_labels);
      self.postMessage({ id, result: mask }, { transfer: [mask.buffer] });
    } catch (error) { self.postMessage({ id, error: String(error) }); }
  });
};
