import { chromium } from 'playwright-core';
import { mkdir, readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';

const url = process.env.EDITOR_URL ?? 'http://127.0.0.1:5173/';
const executablePath = process.env.BROWSER_PATH ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
await mkdir('.cache/qa', { recursive: true });
const browser = await chromium.launch({ executablePath, headless: true });
const errors = [];
const results = [];
async function setup(viewport, touch = false) {
  const context = await browser.newContext({ viewport, hasTouch: touch, isMobile: touch, acceptDownloads: true });
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(url); await page.locator('[data-action=import]').waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.querySelector('[data-action=import]').disabled);
  return { context, page };
}
async function documentState(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const r = indexedDB.open('image-editor-v1', 1);
    r.onerror = () => reject(r.error); r.onsuccess = () => {
      const db = r.result, tx = db.transaction('state');
      const state = tx.objectStore('state').get('current'); state.onsuccess = () => resolve(state.result?.document ?? null); tx.oncomplete = () => db.close();
    };
  }));
}
async function waitSaved(page, condition) {
  const end = Date.now() + 10000;
  while (Date.now() < end) { const state = await documentState(page); if (condition(state)) return state; await new Promise(resolve => setTimeout(resolve, 80)); }
  throw new Error('Expected saved document was not written');
}
async function picture(page) {
  return Buffer.from(await page.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 120; c.height = 80; const x = c.getContext('2d');
    x.fillStyle = '#ee2020'; x.fillRect(0, 0, 60, 80); x.fillStyle = '#2040ee'; x.fillRect(60, 0, 60, 80);
    return c.toDataURL('image/png').split(',')[1];
  }), 'base64');
}
async function importImage(page, name = '双色.png') {
  await page.locator('[data-el=files]').setInputFiles({ name, mimeType: 'image/png', buffer: await picture(page) });
  await page.waitForFunction(() => document.querySelectorAll('[data-layer]').length > 0 && !document.querySelector('[data-action=import]').disabled);
  await waitSaved(page, d => d?.layers.length > 0);
}
async function imagePoint(page, x, y) {
  const box = await page.locator('[data-el=canvas]').boundingBox();
  return { x: box.x + (box.width - 120) / 2 + x, y: box.y + (box.height - 80) / 2 + y };
}
async function canvasClick(page, x, y) { const p = await imagePoint(page, x, y); await page.mouse.click(p.x, p.y); }
async function drag(page, from, to) { await page.mouse.move(from.x, from.y); await page.mouse.down(); await page.mouse.move(to.x, to.y, { steps: 8 }); await page.mouse.up(); }
async function sampleFile(page, file, points) {
  const bytes = [...await readFile(file)];
  return page.evaluate(async ({ bytes, points }) => {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)]));
    const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height; const ctx = canvas.getContext('2d'); ctx.drawImage(bitmap, 0, 0);
    return { width: bitmap.width, height: bitmap.height, pixels: points.map(([x, y]) => [...ctx.getImageData(x, y, 1, 1).data]) };
  }, { bytes, points });
}
async function apply(page) {
  const b = page.locator('[data-action=apply]'); await b.waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.querySelector('[data-action=apply]').disabled); await b.click();
}
async function downloadPNG(page, file) {
  await page.locator('[data-action=export]').click(); await page.locator('dialog select[name=type]').selectOption('image/png');
  const pending = page.waitForEvent('download'); await page.locator('dialog button[value=ok]').click(); await (await pending).saveAs(file);
}
async function assertSameImage(page, before, after) {
  const result = await page.evaluate(async ([a, b]) => {
    const decode = async bytes => { const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)])); const c = document.createElement('canvas'); c.width = bitmap.width; c.height = bitmap.height; const ctx = c.getContext('2d'); ctx.drawImage(bitmap, 0, 0); const data = ctx.getImageData(0, 0, c.width, c.height).data; bitmap.close(); return { width: c.width, height: c.height, data }; };
    const first = await decode(a), second = await decode(b); let maxError = 0;
    if (first.width !== second.width || first.height !== second.height) return { equalSize: false, maxError };
    for (let i = 0; i < first.data.length; i += 4) {
      maxError = Math.max(maxError, Math.abs(first.data[i + 3] - second.data[i + 3]));
      for (let j = 0; j < 3; j++) maxError = Math.max(maxError, Math.abs(first.data[i + j] * first.data[i + 3] / 255 - second.data[i + j] * second.data[i + 3] / 255));
    }
    return { equalSize: true, maxError };
  }, [[...await readFile(before)], [...await readFile(after)]]);
  assert.equal(result.equalSize, true); assert.ok(result.maxError <= 2, `Merging changed the rendered image by ${result.maxError}`);
}
try {
  const paintSession = await setup({ width: 1280, height: 800 });
  const paint = paintSession.page;
  await importImage(paint);
  const sourceAsset = (await documentState(paint)).layers[0].asset;
  await paint.locator('[data-el=canvas]').focus(); await paint.keyboard.press('f');
  assert.equal(await paint.locator('[data-tool=bucket]').getAttribute('aria-pressed'), 'true');
  await paint.locator('[data-option=fill-color]').fill('#00ff00');
  await paint.locator('[data-option=tolerance]').fill('0');
  await canvasClick(paint, 20, 40);
  let painted = await waitSaved(paint, d => d?.layers[0].asset !== sourceAsset);
  const greenAsset = painted.layers[0].asset;
  await downloadPNG(paint, '.cache/qa/bucket.png');
  assert.deepEqual((await sampleFile(paint, '.cache/qa/bucket.png', [[20, 40], [90, 40]])).pixels, [[0, 255, 0, 255], [32, 64, 238, 255]]);
  await paint.locator('[data-action=undo]').click(); await waitSaved(paint, d => d?.layers[0].asset === sourceAsset);
  await paint.locator('[data-action=redo]').click(); await waitSaved(paint, d => d?.layers[0].asset === greenAsset);
  await paint.reload(); await paint.waitForFunction(() => !document.querySelector('[data-action=import]').disabled);
  await downloadPNG(paint, '.cache/qa/bucket-restored.png');
  await assertSameImage(paint, '.cache/qa/bucket.png', '.cache/qa/bucket-restored.png');
  await paint.locator('[data-tool=rect]').click();
  await drag(paint, await imagePoint(paint, 10, 10), await imagePoint(paint, 30, 30)); await apply(paint);
  await paint.locator('[data-tool=bucket]').click(); await paint.locator('[data-option=fill-color]').fill('#ffff00');
  await canvasClick(paint, 20, 20); await waitSaved(paint, d => d?.layers[0].asset !== greenAsset);
  await paint.locator('[data-action=deselect]').click();
  await downloadPNG(paint, '.cache/qa/bucket-selection.png');
  assert.deepEqual((await sampleFile(paint, '.cache/qa/bucket-selection.png', [[20, 20], [40, 40]])).pixels, [[255, 255, 0, 255], [0, 255, 0, 255]]);
  await paint.locator('[data-tool=rect]').click();
  await drag(paint, await imagePoint(paint, 10, 10), await imagePoint(paint, 30, 30)); await apply(paint);
  await paint.locator('[data-action=mask-from]').click();
  await paint.locator('[data-action=trim]').click();
  painted = await waitSaved(paint, d => d?.width === 20 && d.height === 20);
  assert.equal(painted.layers[0].transform.x, -10); assert.equal(painted.layers[0].transform.y, -10);
  await paint.locator('[data-action=undo]').click(); await waitSaved(paint, d => d?.width === 120);
  await paint.locator('[data-action=redo]').click(); await waitSaved(paint, d => d?.width === 20);
  await paint.locator('[data-visibility]').uncheck();
  await paint.locator('[data-action=trim]').click();
  assert.equal(await paint.locator('[data-el=status]').textContent(), '画布完全透明，无需裁切');
  assert.equal((await documentState(paint)).width, 20);
  await paintSession.context.close();
  const trimSession = await setup({ width: 1280, height: 800 });
  const trim = trimSession.page;
  const transparentImage = Buffer.from(await trim.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 120; c.height = 80;
    const ctx = c.getContext('2d'); ctx.fillStyle = '#ff0000'; ctx.fillRect(20, 10, 40, 30);
    ctx.fillStyle = 'rgba(255,0,0,0.004)'; ctx.fillRect(10, 5, 1, 1);
    return c.toDataURL().split(',')[1];
  }), 'base64');
  await trim.locator('[data-el=files]').setInputFiles({ name: 'transparent.png', mimeType: 'image/png', buffer: transparentImage });
  await waitSaved(trim, d => d?.layers.length === 1);
  for (const [field, value] of [['x', '7'], ['y', '9']]) {
    await trim.locator(`[data-transform=${field}]`).fill(value); await trim.locator(`[data-transform=${field}]`).press('Tab');
  }
  await importImage(trim, 'hidden.png'); await trim.locator('[data-visibility]').first().uncheck();
  await trim.locator('[data-option=background]').selectOption('#ffffff');
  await trim.locator('[data-action=trim]').click();
  const trimmed = await waitSaved(trim, d => d?.width === 50 && d.height === 35);
  assert.equal(trimmed.layers[0].transform.x, -10); assert.equal(trimmed.layers[0].transform.y, -5);
  assert.equal(trimmed.layers[1].transform.x, -17); assert.equal(trimmed.layers[1].transform.y, -14);
  await downloadPNG(trim, '.cache/qa/trimmed.png');
  const trimmedPixels = await sampleFile(trim, '.cache/qa/trimmed.png', [[0, 0], [10, 5]]);
  assert.equal(trimmedPixels.pixels[0][3], 1); assert.deepEqual(trimmedPixels.pixels[1], [255, 0, 0, 255]);
  await trim.locator('[data-action=trim]').click();
  assert.equal(await trim.locator('[data-el=status]').textContent(), '没有可去除的透明边界');
  await trimSession.context.close();
  const rotatedSession = await setup({ width: 1280, height: 800 });
  const rotated = rotatedSession.page;
  await importImage(rotated);
  for (const [field, value] of [['angle', '90'], ['x', '80']]) {
    await rotated.locator(`[data-transform=${field}]`).fill(value); await rotated.locator(`[data-transform=${field}]`).press('Tab');
  }
  const rotatedAsset = (await waitSaved(rotated, d => d?.layers[0].transform.x === 80)).layers[0].asset;
  await rotated.locator('[data-tool=bucket]').click();
  await rotated.locator('[data-option=fill-color]').fill('#00ff00');
  await canvasClick(rotated, 40, 20); await waitSaved(rotated, d => d?.layers[0].asset !== rotatedAsset);
  await downloadPNG(rotated, '.cache/qa/bucket-rotated.png');
  assert.deepEqual((await sampleFile(rotated, '.cache/qa/bucket-rotated.png', [[40, 20], [40, 70]])).pixels, [[0, 255, 0, 255], [32, 64, 238, 255]]);
  await rotated.screenshot({ path: '.cache/qa/bucket-ui.png' });
  await rotatedSession.context.close();
  const emptyFillSession = await setup({ width: 390, height: 844 }, true);
  const emptyFill = emptyFillSession.page;
  await emptyFill.locator('[data-tool=bucket]').click();
  await emptyFill.locator('[data-option=fill-color]').fill('#ff8800');
  const emptyStage = await emptyFill.locator('[data-el=canvas]').boundingBox();
  await emptyFill.touchscreen.tap(emptyStage.x + emptyStage.width / 2, emptyStage.y + emptyStage.height / 2);
  await waitSaved(emptyFill, d => d?.layers.length === 1 && d.layers[0].name === '填充图层');
  await downloadPNG(emptyFill, '.cache/qa/bucket-empty.png');
  assert.deepEqual((await sampleFile(emptyFill, '.cache/qa/bucket-empty.png', [[0, 0], [1199, 799]])).pixels, [[255, 136, 0, 255], [255, 136, 0, 255]]);
  await emptyFill.locator('[data-action=undo]').click(); await waitSaved(emptyFill, d => d?.layers.length === 0);
  await emptyFill.locator('[data-action=redo]').click(); await waitSaved(emptyFill, d => d?.layers.length === 1);
  await emptyFill.screenshot({ path: '.cache/qa/bucket-mobile.png' });
  await emptyFillSession.context.close();
  results.push('bucket: connected colour, selection, asset undo/redo and reload; trim: masks, hidden layers, shifted layers, alpha=1, empty/no-op');
  const historySession = await setup({ width: 1280, height: 800 });
  const h = historySession.page;
  assert.equal(await h.locator('[data-action=undo]').isDisabled(), true);
  assert.equal(await h.locator('[data-action=redo]').isDisabled(), true);
  await importImage(h);
  await h.locator('[data-el=canvas]').focus();
  await h.keyboard.press('Control+z');
  await waitSaved(h, d => d?.layers.length === 0);
  await h.keyboard.press('Control+y');
  await waitSaved(h, d => d?.layers.length === 1);
  await h.locator('[data-tool=rect]').click();
  await drag(h, await imagePoint(h, 10, 10), await imagePoint(h, 50, 50));
  assert.equal(await h.locator('[data-action=apply]').isVisible(), true);
  assert.equal(await h.locator('[data-action=undo]').isEnabled(), true);
  await h.keyboard.press('Control+z');
  await waitSaved(h, d => d?.layers.length === 1 && d.layers[0].selection === null);
  assert.equal(await h.locator('[data-action=apply]').isVisible(), false);
  await h.keyboard.press('Control+Shift+z');
  await waitSaved(h, d => d?.layers[0].selection?.[20 * 120 + 20] === 255);
  await h.keyboard.press('Meta+z');
  await waitSaved(h, d => d?.layers[0].selection === null);
  await h.keyboard.press('Meta+Shift+z');
  await waitSaved(h, d => d?.layers[0].selection?.[20 * 120 + 20] === 255);
  const nameInput = h.locator('[data-name]').first();
  await nameInput.focus();
  assert.equal(await nameInput.evaluate(el => {
    const event = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true });
    el.dispatchEvent(event); return event.defaultPrevented;
  }), false, 'Text inputs must retain native undo');
  await h.locator('[data-el=canvas]').focus();
  await h.keyboard.press('Control+z');
  await waitSaved(h, d => d?.layers[0].selection === null);
  await h.keyboard.press('ArrowRight');
  await waitSaved(h, d => d?.layers[0].transform.x === 1);
  assert.equal(await h.locator('[data-action=redo]').isDisabled(), true, 'New edits must clear redo');
  await historySession.context.close();
  results.push('history: empty state, import undo/redo, pending selection undo/redo, Ctrl/Meta shortcuts, native text undo, redo invalidation');
  const { context, page } = await setup({ width: 1280, height: 800 });
  await importImage(page);
  await page.locator('[data-tool=color]').click();
  await page.locator('[data-option=tolerance]').fill('0'); await canvasClick(page, 20, 40); await apply(page);
  let doc = await waitSaved(page, d => d?.layers[0].selection?.[20 * 120 + 20] === 255);
  assert.equal(Object.values(doc.layers[0].selection).filter(Boolean).length, 4800);
  await page.locator('[data-action=copy]').click();
  doc = await waitSaved(page, d => d?.layers.length === 2);
  assert.equal(doc.layers[1].mask[40 * 120 + 20], 255); assert.equal(doc.layers[1].mask[40 * 120 + 90], 0); assert.equal(doc.layers[0].mask, null);
  await page.locator('[data-transform=x]').fill('30'); await page.locator('[data-transform=x]').press('Tab');
  await page.locator('[data-transform=width]').fill('240'); await page.locator('[data-transform=width]').press('Tab');
  await page.locator('[data-transform=angle]').fill('30'); await page.locator('[data-transform=angle]').press('Tab');
  doc = await waitSaved(page, d => Math.abs((d?.layers[1].transform.angle ?? 0) - Math.PI / 6) < 1e-8);
  assert.equal(doc.layers[1].transform.x, 30); assert.equal(doc.layers[1].transform.sx, 2); assert.equal(doc.layers[1].transform.sy, 2);
  await page.locator('[data-action=flip-x]').click();
  doc = await waitSaved(page, d => d?.layers[1].transform.sx === -2); assert.equal(doc.layers[1].mask[40 * 120 + 20], 255);
  await page.locator('[data-action=undo]').click(); await waitSaved(page, d => d?.layers[1].transform.sx === 2);
  const restoredTransform = (await documentState(page)).layers[1].transform;
  await page.reload(); await page.waitForFunction(() => !document.querySelector('[data-action=import]').disabled);
  assert.equal(await page.locator('[data-layer]').count(), 2); assert.equal(await page.locator('[data-transform=angle]').inputValue(), '30');
  doc = await documentState(page); assert.deepEqual(doc.layers[1].transform, restoredTransform);
  await page.locator('[data-action=export]').click(); await page.locator('dialog select[name=type]').selectOption('image/png');
  const downloadPromise = page.waitForEvent('download'); await page.locator('dialog button[value=ok]').click(); const download = await downloadPromise;
  await download.saveAs('.cache/qa/export.png'); assert.ok((await readFile('.cache/qa/export.png')).length > 100);
  const png = await sampleFile(page, '.cache/qa/export.png', [[5, 5], [110, 5]]); assert.equal(png.width, 120); assert.equal(png.height, 80); assert.deepEqual(png.pixels, [[238, 32, 32, 255], [32, 64, 238, 255]]);
  await page.screenshot({ path: '.cache/qa/desktop.png' });
  const beforeMerge = await documentState(page);
  await page.locator('[data-tool=refine]').click();
  await page.evaluate(() => { const original = HTMLCanvasElement.prototype.toBlob; HTMLCanvasElement.prototype.toBlob = function(callback, ...args) { return original.call(this, blob => setTimeout(() => callback(blob), 400), ...args); }; });
  await page.locator('[data-action=merge-down]').click();
  assert.equal(await page.locator('[data-action=refine]').isDisabled(), true); assert.equal(await page.locator('[data-action=undo]').isDisabled(), true);
  doc = await waitSaved(page, d => d?.layers.length === 1);
  assert.equal(doc.layers[0].opacity, 1); assert.equal(doc.layers[0].mask, null); assert.ok(doc.layers[0].width > doc.width); assert.ok(doc.layers[0].transform.x < 0);
  await downloadPNG(page, '.cache/qa/merged-down.png'); await assertSameImage(page, '.cache/qa/export.png', '.cache/qa/merged-down.png');
  await page.locator('[data-action=undo]').click(); doc = await waitSaved(page, d => d?.layers.length === 2); assert.deepEqual(doc.layers, beforeMerge.layers);
  await page.locator('[data-action=redo]').click(); await waitSaved(page, d => d?.layers.length === 1);
  await page.reload(); await page.waitForFunction(() => !document.querySelector('[data-action=import]').disabled);
  await downloadPNG(page, '.cache/qa/merged-restored.png'); await assertSameImage(page, '.cache/qa/merged-down.png', '.cache/qa/merged-restored.png');
  await page.locator('[data-action=duplicate]').click(); await waitSaved(page, d => d?.layers.length === 2);
  await page.locator('[data-transform=x]').fill('20000'); await page.locator('[data-transform=x]').press('Tab'); await waitSaved(page, d => d?.layers[1].transform.x === 20000);
  await page.locator('[data-action=merge-down]').click(); await page.waitForFunction(() => document.querySelector('[data-el=status]').dataset.error === 'true');
  assert.equal(await page.locator('[data-layer]').count(), 2); assert.equal(await page.locator('[data-action=export]').isEnabled(), true);
  await page.locator('[data-action=undo]').click(); await waitSaved(page, d => d?.layers[1].transform.x !== 20000);
  results.push('merge down: transformed masked layers, off-canvas pixels, export equivalence, undo/redo, reload, failed merge atomicity');
  results.push('desktop: colour range, copy layer, numeric transform, flip, undo, IndexedDB restore, PNG export');
  await context.close();

  const second = await setup({ width: 1100, height: 760 }); const p = second.page;
  await importImage(p);
  await p.locator('[data-tool=wand]').click(); await canvasClick(p, 90, 30); await apply(p);
  await p.locator('[data-action=cut]').click();
  doc = await waitSaved(p, d => d?.layers.length === 2);
  assert.equal(doc.layers[0].mask[30 * 120 + 90], 0); assert.equal(doc.layers[1].mask[30 * 120 + 90], 255);
  await p.locator('[data-action=undo]').click(); await waitSaved(p, d => d?.layers.length === 1);
  assert.equal((await documentState(p)).layers[0].mask, null);
  await p.locator('[data-tool=quick]').click(); await canvasClick(p, 30, 40); await apply(p);
  doc = await waitSaved(p, d => d?.layers[0].selection?.[40 * 120 + 30] === 255);
  assert.equal(doc.layers[0].selection[40 * 120 + 90], 255); // add mode retains the earlier wand selection.
  await p.locator('[data-action=deselect]').click(); await waitSaved(p, d => d?.layers[0].selection === null);
  await p.locator('[data-tool=quick]').click(); await canvasClick(p, 30, 40); await apply(p);
  doc = await waitSaved(p, d => d?.layers[0].selection?.[40 * 120 + 30] === 255); assert.equal(doc.layers[0].selection[40 * 120 + 90], 0);
  await p.locator('[data-action=all]').click(); await waitSaved(p, d => d?.layers[0].selection?.[40 * 120 + 90] === 255);
  await p.locator('[data-option=mode]').selectOption('intersect'); await canvasClick(p, 30, 40); await apply(p);
  doc = await waitSaved(p, d => d?.layers[0].selection?.[40 * 120 + 90] === 0); assert.equal(doc.layers[0].selection[40 * 120 + 30], 255);
  await p.locator('[data-tool=refine]').click(); await p.locator('[data-action=refine]').click(); await apply(p);
  await p.locator('[data-action=mask-from]').click(); await waitSaved(p, d => d?.layers[0].mask && !d.layers[0].selection);
  await p.locator('[data-tool=mask]').click(); await p.locator('[data-option=paint]').selectOption('subtract'); await canvasClick(p, 30, 40); await p.locator('[data-action=cancel]').click();
  assert.equal((await documentState(p)).layers[0].mask[40 * 120 + 30], 255);
  await p.locator('[data-action=export]').click(); await p.locator('dialog select[name=type]').selectOption('image/jpeg');
  const jpegPromise = p.waitForEvent('download'); await p.locator('dialog button[value=ok]').click(); await (await jpegPromise).saveAs('.cache/qa/export.jpg');
  const jpeg = await sampleFile(p, '.cache/qa/export.jpg', [[30, 40], [95, 40]]); assert.ok(jpeg.pixels[0][0] > 225 && jpeg.pixels[0][1] < 40); assert.ok(jpeg.pixels[1].every(v => v > 245));
  await p.locator('[data-transform=opacity]').fill('50'); await p.locator('[data-transform=opacity]').press('Tab');
  await p.locator('[data-action=duplicate]').click(); await p.locator('[data-action=duplicate]').click();
  doc = await waitSaved(p, d => d?.layers.length === 3); const hiddenId = doc.layers[1].id;
  await p.locator(`[data-visibility="${hiddenId}"]`).uncheck(); await waitSaved(p, d => d?.layers[1].visible === false);
  await downloadPNG(p, '.cache/qa/visible-before.png');
  await p.locator('[data-action=merge-visible]').click(); doc = await waitSaved(p, d => d?.layers.length === 2);
  assert.equal(doc.layers[0].id, hiddenId); assert.equal(doc.layers[0].visible, false); assert.equal(doc.layers[1].opacity, 1);
  await downloadPNG(p, '.cache/qa/visible-after.png'); await assertSameImage(p, '.cache/qa/visible-before.png', '.cache/qa/visible-after.png');
  const transparent = await sampleFile(p, '.cache/qa/visible-after.png', [[30, 40], [95, 40]]); assert.ok(transparent.pixels[0][3] >= 190 && transparent.pixels[0][3] <= 192); assert.equal(transparent.pixels[1][3], 0);
  await p.locator('[data-action=undo]').click(); await waitSaved(p, d => d?.layers.length === 3);
  await p.locator('[data-action=redo]').click(); await waitSaved(p, d => d?.layers.length === 2);
  results.push('merge visible: hidden layer retained, baked opacity and transparency, export equivalence, undo/redo');
  results.push('desktop: wand, cut, cut undo, incremental graph cut, matting, selection-to-mask, cancel mask edits, JPEG export');
  await second.context.close();

  const transform = await setup({ width: 1100, height: 760 }); const t = transform.page; await importImage(t);
  await drag(t, await imagePoint(t, 35, 30), await imagePoint(t, 55, 40)); await apply(t);
  doc = await waitSaved(t, d => d?.layers[0].transform.x === 20); assert.equal(doc.layers[0].transform.y, 10);
  await drag(t, await imagePoint(t, 140, 90), await imagePoint(t, 200, 130)); await apply(t);
  doc = await waitSaved(t, d => d?.layers[0].transform.sx === 1.5); assert.equal(doc.layers[0].transform.sy, 1.5);
  await t.locator('[data-action=undo]').click(); await waitSaved(t, d => d?.layers[0].transform.sx === 1);
  await t.locator('[data-tool=rect]').click();
  await drag(t, await imagePoint(t, 25, 15), await imagePoint(t, 55, 35)); await apply(t);
  doc = await waitSaved(t, d => d?.layers[0].selection?.[10 * 120 + 10] === 255); assert.equal(Object.values(doc.layers[0].selection).filter(Boolean).length, 600);
  await t.locator('[data-tool=crop]').click(); await drag(t, await imagePoint(t, 10, 5), await imagePoint(t, 110, 75)); await apply(t);
  doc = await waitSaved(t, d => d?.width === 100 && d.height === 70); assert.equal(doc.layers[0].transform.x, 10); assert.equal(doc.layers[0].transform.y, 5);
  await t.locator('[data-action=undo]').click(); await waitSaved(t, d => d?.width === 120);
  await t.locator('[data-tool=move]').click(); await t.locator('[data-option=proportional]').uncheck();
  await t.locator('[data-transform=width]').fill('240'); await t.locator('[data-transform=width]').press('Tab');
  await t.locator('[data-transform=angle]').fill('30'); await t.locator('[data-transform=angle]').press('Tab');
  await t.locator('[data-tool=brush]').click(); const brushPoint = await imagePoint(t, 40, 40); await t.mouse.move(brushPoint.x, brushPoint.y);
  await t.locator('[data-option=radius]').fill('40');
  await t.waitForFunction(() => document.querySelector('[data-el=brush-cursor] ellipse').getAttribute('rx') === '40');
  assert.equal(await t.locator('[data-el=brush-cursor]').isVisible(), true);
  assert.equal(await t.locator('[data-el=brush-cursor] ellipse').first().getAttribute('ry'), '20');
  assert.match(await t.locator('[data-el=brush-cursor] ellipse').first().getAttribute('transform'), /^rotate\(29\.999|^rotate\(30 /);
  await t.locator('[data-option=zoom]').fill('200'); await t.locator('[data-option=zoom]').press('Tab');
  await t.waitForFunction(() => document.querySelector('[data-el=brush-cursor] ellipse').getAttribute('rx') === '80');
  await t.mouse.move(brushPoint.x, brushPoint.y); await t.screenshot({ path: '.cache/qa/brush-cursor.png' });
  await t.mouse.move(20, 20); assert.equal(await t.locator('[data-el=brush-cursor]').isVisible(), false);
  results.push('desktop: pointer movement, scale handles, transformed rectangle selection, canvas crop and undo'); await transform.context.close();

  const failures = await setup({ width: 1100, height: 760 }); const f = failures.page;
  await f.locator('[data-action=new]').click(); await f.locator('dialog [name=width]').fill('500'); await f.locator('dialog [name=height]').fill('400'); await f.locator('dialog button[value=ok]').click();
  await importImage(f); doc = await waitSaved(f, d => d?.layers.length === 1); assert.equal(doc.width, 500); assert.equal(doc.height, 400);
  await f.evaluate(() => { window.originalPut = IDBObjectStore.prototype.put; IDBObjectStore.prototype.put = function(...args) { if (this.name === 'assets') throw new DOMException('测试：存储空间不足', 'QuotaExceededError'); return window.originalPut.apply(this, args); }; });
  await f.locator('[data-transform=opacity]').fill('50'); await f.locator('[data-transform=opacity]').press('Tab');
  await f.waitForFunction(() => document.querySelector('[data-el=status]').dataset.error === 'true');
  assert.equal((await documentState(f)).layers[0].opacity, 1); assert.equal(await f.locator('[data-transform=opacity]').inputValue(), '50');
  await f.evaluate(() => { IDBObjectStore.prototype.put = window.originalPut; });
  await f.locator('[data-action=dismiss]').click(); await f.locator('[data-transform=opacity]').fill('40'); await f.locator('[data-transform=opacity]').press('Tab');
  await waitSaved(f, d => d?.layers[0].opacity === .4);
  await f.locator('[data-el=files]').setInputFiles({ name: 'bad.png', mimeType: 'image/png', buffer: Buffer.from('not an image') });
  await f.waitForFunction(() => document.querySelector('[data-el=status]').dataset.error === 'true'); assert.equal(await f.locator('[data-layer]').count(), 1);
  results.push('failure recovery: explicit canvas size, atomic quota failure, in-memory edits retained, save retry, corrupt image rollback'); await failures.context.close();

  const mobile = await setup({ width: 390, height: 844 }, true); const m = mobile.page;
  await importImage(m); await m.locator('[data-tool=brush]').click();
  let point = await imagePoint(m, 25, 35); await m.touchscreen.tap(point.x, point.y); await apply(m);
  assert.equal(await m.locator('[data-el=brush-cursor]').isVisible(), true);
  doc = await waitSaved(m, d => d?.layers[0].selection?.[35 * 120 + 25] === 255);
  await m.locator('[data-action=layers]').click(); assert.equal(await m.locator('.ie-side').isVisible(), true);
  assert.equal(await m.locator('.ie-layer-panel').isVisible(), true); assert.equal(await m.locator('.ie-controls-panel').isVisible(), false);
  await m.locator('[data-action=controls]').click();
  assert.equal(await m.locator('.ie-controls-panel').isVisible(), true); assert.equal(await m.locator('.ie-layer-panel').isVisible(), false);
  assert.equal(await m.locator('[data-action=layers]').getAttribute('aria-expanded'), 'false');
  await m.locator('[data-action=copy]').click(); await waitSaved(m, d => d?.layers.length === 2);
  await m.locator('[data-action=controls]').click();
  assert.equal(await m.locator('.ie-side').isVisible(), false);
  await m.locator('[data-action=layers]').click(); await m.locator('[data-action=merge-down]').click(); await waitSaved(m, d => d?.layers.length === 1);
  await m.locator('[data-action=undo]').click(); await waitSaved(m, d => d?.layers.length === 2); await m.locator('[data-action=layers]').click();
  await m.locator('[data-tool=brush]').click();
  const cdp = await mobile.context.newCDPSession(m); const area = await m.locator('[data-el=canvas]').boundingBox();
  const middle = { x: area.x + area.width / 2, y: area.y + area.height / 2 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: middle.x - 25, y: middle.y, id: 1 }, { x: middle.x + 25, y: middle.y, id: 2 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: middle.x - 50, y: middle.y, id: 1 }, { x: middle.x + 50, y: middle.y, id: 2 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); assert.ok(Number(await m.locator('[data-option=zoom]').inputValue()) > 150);
  assert.equal(await m.locator('[data-action=apply]').isVisible(), false, 'Pinching from a paint tool must roll back the accidental first-finger stroke');
  assert.equal(await m.locator('[data-el=brush-cursor]').isVisible(), false);
  await m.locator('[data-option=radius]').fill('60');
  assert.equal(await m.locator('[data-el=brush-cursor]').isVisible(), true);
  assert.equal(await m.locator('[data-el=brush-cursor] ellipse').first().getAttribute('rx'), '60');
  assert.equal(await m.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await m.screenshot({ path: '.cache/qa/mobile.png' }); results.push('mobile: touch brush, confirm, layer drawer, copy, two-finger pinch, viewport overflow');
  await mobile.context.close();
  assert.deepEqual(errors, []); console.log(JSON.stringify({ passed: results, browserErrors: errors }, null, 2));
} finally { await browser.close(); }
