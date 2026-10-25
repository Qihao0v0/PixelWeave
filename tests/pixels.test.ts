import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alphaBounds, floodFill, type FillInput } from '../src/pixels';

function fillInput(width: number, height: number, values: number[][]): FillInput {
  return { kind: 'fill', width, height, pixels: new Uint8ClampedArray(values.flat()), x: 0, y: 0,
    color: [0, 255, 0], tolerance: 0, selection: null, mask: null };
}
const red = [255, 0, 0, 255], blue = [0, 0, 255, 255], green = [0, 255, 0, 255];
test('bucket fills only four-connected matching pixels and keeps source immutable', () => {
  const input = fillInput(3, 2, [red, blue, red, red, blue, red]);
  const original = input.pixels.slice(), result = floodFill(input);
  assert.deepEqual([...result.pixels], [green, blue, red, green, blue, red].flat());
  assert.deepEqual(input.pixels, original); assert.equal(result.changed, true);
});
test('bucket treats invisible RGB as transparent and fills alpha', () => {
  const input = fillInput(3, 1, [[255, 0, 0, 0], [0, 0, 255, 0], red]);
  assert.deepEqual([...floodFill(input).pixels], [green, green, red].flat());
});
test('bucket respects tolerance, selection barriers and enabled mask boundaries', () => {
  const input = fillInput(4, 1, [red, [250, 0, 0, 255], red, red]);
  input.tolerance = 5; input.selection = new Uint8Array([255, 128, 0, 255]);
  assert.deepEqual([...floodFill(input).pixels], [green, [125, 128, 0, 255], red, red].flat());
  input.selection = null; input.mask = new Uint8Array([255, 0, 255, 255]);
  assert.deepEqual([...floodFill(input).pixels], [green, [250, 0, 0, 255], red, red].flat());
});
test('bucket skips out-of-bounds, excluded and already filled pixels', () => {
  const input = fillInput(1, 1, [green]);
  assert.equal(floodFill(input).changed, false);
  input.x = -1; assert.equal(floodFill(input).changed, false);
  input.x = 0; input.color = [255, 0, 0]; input.selection = new Uint8Array([0]);
  assert.equal(floodFill(input).changed, false);
});
test('transparent bounds keep the faintest visible pixel and ignore hidden RGB', () => {
  const pixels = new Uint8ClampedArray(6 * 5 * 4).fill(200);
  for (let i = 3; i < pixels.length; i += 4) pixels[i] = 0;
  assert.equal(alphaBounds(pixels, 6, 5), null);
  pixels[(1 * 6 + 2) * 4 + 3] = 1;
  pixels[(3 * 6 + 4) * 4 + 3] = 255;
  assert.deepEqual(alphaBounds(pixels, 6, 5), { x: 2, y: 1, width: 3, height: 3 });
});
