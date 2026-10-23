import { mkdir, copyFile, readdir } from 'node:fs/promises';
// Only the browser WASM runtime is shipped; native Node ONNX binaries are never deployed.
await mkdir('public/ort', { recursive: true });
const source = 'node_modules/onnxruntime-web/dist';
for (const name of await readdir(source)) if (/^ort-wasm-simd-threaded(\.jsep)?\.(wasm|mjs)$/.test(name)) await copyFile(`${source}/${name}`, `public/ort/${name}`);
