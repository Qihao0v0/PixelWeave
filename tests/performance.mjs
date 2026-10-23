import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
await mkdir('.cache/qa', { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.BROWSER_PATH ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } }); const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(process.env.EDITOR_URL ?? 'http://127.0.0.1:5173/'); await page.waitForFunction(() => !document.querySelector('[data-action=import]').disabled);
  const buffer = Buffer.from(await page.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 4000; c.height = 3000; const x = c.getContext('2d');
    x.fillStyle = '#3040c0'; x.fillRect(0, 0, 4000, 3000); x.fillStyle = '#e03030'; x.fillRect(1000, 600, 2000, 1800);
    return c.toDataURL().split(',')[1];
  }), 'base64');
  const start = Date.now(); await page.locator('[data-el=files]').setInputFiles(Array.from({ length: 5 }, (_, i) => ({ name: `12MP-${i}.png`, mimeType: 'image/png', buffer })));
  await page.waitForFunction(() => document.querySelectorAll('[data-layer]').length === 5 && !document.querySelector('[data-action=import]').disabled, null, { timeout: 60000 });
  const importMs = Date.now() - start;
  await page.locator('[data-tool=quick]').click();
  const box = await page.locator('[data-el=canvas]').boundingBox(), point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const selectStart = Date.now(); await page.mouse.click(point.x, point.y);
  await page.waitForFunction(() => !document.querySelector('[data-action=apply]').hidden && !document.querySelector('[data-action=apply]').disabled, null, { timeout: 30000 });
  const quickSelectMs = Date.now() - selectStart; await page.locator('[data-action=apply]').click();
  await page.locator('[data-action=mask-from]').click();
  await page.locator('[data-option=zoom]').fill('200'); await page.locator('[data-option=zoom]').press('Tab');
  await page.screenshot({ path: '.cache/qa/large-image.png' });
  const heap = await page.evaluate(() => performance.memory ? { used: performance.memory.usedJSHeapSize, limit: performance.memory.jsHeapSizeLimit } : null);
  const result = { image: '4000×3000', layers: 5, importMs, quickSelectMs, jsHeapBytes: heap, note: 'JS heap excludes GPU/bitmap memory; headless Windows Edge, not a phone measurement', errors };
  assert.deepEqual(errors, []); console.log(JSON.stringify(result, null, 2)); await writeFile('.cache/qa/performance.json', JSON.stringify(result, null, 2));
} finally { await browser.close(); }
