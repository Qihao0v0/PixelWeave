import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { combineMasks, localToWorld, multiplyMasks, polygonMask, worldToLocal } from '../src/geometry';
import { emptyDocument, History, mergeTargets, newLayer, replaceMergedLayers, selectionToLayer, snapshot } from '../src/document';
import { makeTrimap, runAlgorithm } from '../src/algorithms';
import type { AlgorithmInput } from '../src/types';
import type { Kernel } from '../src/wasm';

const wasm = await WebAssembly.instantiate(await readFile(new URL('../public/core.wasm', import.meta.url)), { env: { abort: () => { throw new Error('WASM abort'); } } });
const kernel = wasm.instance.exports as unknown as Kernel;
test('merge targets skip hidden layers and replacement preserves hidden order and undo', () => {
  const doc = emptyDocument(), bottom = newLayer('a', 'bottom', 10, 10), hidden = newLayer('b', 'hidden', 10, 10), top = newLayer('c', 'top', 10, 10), upperHidden = newLayer('d', 'upper hidden', 10, 10);
  hidden.visible = upperHidden.visible = false; doc.layers = [bottom, hidden, top, upperHidden]; doc.active = top.id;
  assert.deepEqual(mergeTargets(doc, 'down'), [bottom, top]); assert.deepEqual(mergeTargets(doc, 'visible'), [bottom, top]);
  const before = snapshot(doc), history = new History(), merged = newLayer('merged', 'merged', 10, 10); history.push(doc, 'merge');
  replaceMergedLayers(doc, mergeTargets(doc, 'visible'), merged);
  assert.deepEqual(doc.layers.map(l => l.id), [hidden.id, merged.id, upperHidden.id]); assert.equal(doc.active, merged.id);
  assert.deepEqual(history.undo(doc), before);
  doc.active = hidden.id; assert.deepEqual(mergeTargets(doc, 'down'), []);
  doc.active = bottom.id; assert.deepEqual(mergeTargets(doc, 'down'), []);
});
function image(w = 80, h = 60): AlgorithmInput {
  const pixels = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4, object = x >= 20 && x < 60 && y >= 10 && y < 50;
    pixels.set(object ? [210, 40, 30, 255] : [30, 100, 210, 255], i);
  }
  return { kind: 'quick', width: w, height: h, pixels, selection: null, constraints: null, points: [{ x: 35, y: 25 }], radius: 3, tolerance: 12, subtract: false };
}
test('rotation, reflection and non-uniform scale retain local coordinates', () => {
  const t = { x: 45, y: -27, sx: -1.7, sy: .43, angle: 1.14 }, p = { x: 84.5, y: 62.25 };
  const actual = worldToLocal(localToWorld(p, t), t);
  assert.ok(Math.abs(actual.x - p.x) < 1e-9); assert.ok(Math.abs(actual.y - p.y) < 1e-9);
});
test('selection modes retain fractional alpha', () => {
  const a = new Uint8Array([0, 128, 255]), b = new Uint8Array([255, 128, 0]);
  assert.deepEqual([...combineMasks(a, b, 'add')], [255, 128, 255]);
  assert.deepEqual([...combineMasks(a, b, 'subtract')], [0, 64, 255]);
  assert.deepEqual([...combineMasks(a, b, 'intersect')], [0, 128, 0]);
  assert.deepEqual([...multiplyMasks(a, b)], [0, 64, 0]);
});
test('polygon rasterization clips to source bounds without including the right edge', () => {
  const mask = polygonMask(10, 10, [{ x: -2, y: -2 }, { x: 5, y: -2 }, { x: 5, y: 5 }, { x: -2, y: 5 }]);
  assert.equal(mask.filter(Boolean).length, 25);
});
test('copy and cut preserve transform, effective mask, stacking and undo', () => {
  const doc = emptyDocument(), l = newLayer('asset', 'source', 3, 1); doc.layers.push(l); doc.active = l.id;
  l.transform = { x: 33, y: 71, sx: -2, sy: .5, angle: .7 }; l.mask = new Uint8Array([255, 128, 0]); l.selection = new Uint8Array([0, 128, 255]);
  const original = snapshot(doc), history = new History(); history.push(doc, 'cut');
  assert.equal(selectionToLayer(doc, true), true);
  assert.equal(doc.layers.length, 2); assert.deepEqual(doc.layers[1].transform, l.transform);
  assert.deepEqual([...doc.layers[1].mask!], [0, 64, 0]); assert.deepEqual([...l.mask!], [255, 64, 0]);
  assert.equal(doc.active, doc.layers[1].id); assert.equal(l.selection, null);
  const restored = history.undo(doc)!; assert.deepEqual(restored, original);
  assert.equal(history.redo(restored)!.layers.length, 2);
});
test('a disabled mask is ignored when copying the visible source', () => {
  const doc = emptyDocument(), l = newLayer('asset', 'source', 2, 1); l.mask = new Uint8Array([0, 0]); l.maskEnabled = false; l.selection = new Uint8Array([255, 0]); doc.layers.push(l); doc.active = l.id;
  selectionToLayer(doc, false); assert.deepEqual([...doc.layers[1].mask!], [255, 0]); assert.deepEqual([...l.mask!], [0, 0]);
});
test('WASM colour range is global; wand is connected; tolerance excludes transparent pixels', () => {
  const input = image(80, 60); input.pixels.set([210, 40, 30, 255], 0); input.points = [{ x: 30, y: 20 }];
  const global = runAlgorithm(kernel, { ...input, kind: 'color' }).selection;
  const wand = runAlgorithm(kernel, { ...input, kind: 'wand' }).selection;
  assert.equal(global[0], 255); assert.equal(wand[0], 0); assert.equal(wand[20 * 80 + 30], 255);
  assert.equal(wand.filter(Boolean).length, 1600);
  input.pixels[(20 * 80 + 30) * 4 + 3] = 0;
  assert.equal(runAlgorithm(kernel, { ...input, kind: 'color' }).selection[20 * 80 + 30], 0);
  assert.equal(runAlgorithm(kernel, { ...input, kind: 'wand' }).selection.some(Boolean), false);
  assert.equal(runAlgorithm(kernel, { ...input, kind: 'wand', points: [{ x: -1, y: 0 }] }).selection.some(Boolean), false);
});
test('WASM graph cut expands over object colour while respecting negative strokes', () => {
  const input = image(), first = runAlgorithm(kernel, input);
  assert.equal(first.selection[25 * 80 + 35], 255); assert.equal(first.selection[40 * 80 + 50], 255); assert.equal(first.selection[2 * 80 + 2], 0);
  const second = runAlgorithm(kernel, { ...input, selection: first.selection, constraints: first.constraints!, points: [{ x: 50, y: 40 }], subtract: true });
  assert.equal(second.selection[40 * 80 + 50], 0); assert.equal(second.selection[25 * 80 + 35], 255);
  const third = runAlgorithm(kernel, { ...input, selection: second.selection, constraints: second.constraints!, points: [{ x: 30, y: 30 }] });
  assert.equal(third.selection[40 * 80 + 50], 0); assert.equal(third.selection[30 * 80 + 30], 255);
});
test('trimap changes a boundary band and preserves explicit foreground/background', () => {
  const mask = new Uint8Array(30 * 20); for (let y = 0; y < 20; y++) for (let x = 15; x < 30; x++) mask[y * 30 + x] = 255;
  const constraints = new Uint8Array(mask.length); constraints[10 * 30 + 15] = 1; constraints[10 * 30 + 14] = 2;
  const trimap = makeTrimap(mask, 30, 20, 2, constraints);
  assert.equal(trimap[10 * 30 + 5], 0); assert.equal(trimap[10 * 30 + 25], 255); assert.equal(trimap[10 * 30 + 16], 128);
  assert.equal(trimap[10 * 30 + 15], 255); assert.equal(trimap[10 * 30 + 14], 0);
});
test('WASM matting recovers opacity from source colours rather than blur', () => {
  const w = 40, h = 10, pixels = new Uint8ClampedArray(w * h * 4), mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const a = Math.max(0, Math.min(1, (x - 16) / 8)), i = y * w + x;
    pixels.set([Math.round(255 * a), 0, Math.round(255 * (1 - a)), 255], i * 4); mask[i] = x >= 20 ? 255 : 0;
  }
  const result = runAlgorithm(kernel, { kind: 'refine', width: w, height: h, pixels, selection: mask, constraints: null, points: [], radius: 5, tolerance: 0, subtract: false }).selection;
  assert.ok(Math.abs(result[5 * w + 18] - 64) < 12); assert.ok(Math.abs(result[5 * w + 20] - 128) < 12); assert.ok(Math.abs(result[5 * w + 22] - 191) < 12);
  assert.equal(result[5 * w + 5], 0); assert.equal(result[5 * w + 35], 255);
});
test('history buffers are immutable across selection and mask replacement', () => {
  const doc = emptyDocument(), l = newLayer('asset', 'source', 2, 1); l.mask = new Uint8Array([0, 255]); doc.layers.push(l); doc.active = l.id;
  const h = new History(); h.push(doc, 'paint'); l.mask = l.mask.slice(); l.mask[0] = 255;
  assert.deepEqual([...h.undo(doc)!.layers[0].mask!], [0, 255]);
});
