import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { access, mkdir, writeFile } from 'node:fs/promises';
await mkdir('.cache/qa', { recursive: true });
try { await access('.cache/qa/cats.jpg'); } catch { const response = await fetch('https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/cats.jpg'); if (!response.ok) throw new Error('测试图片下载失败'); await writeFile('.cache/qa/cats.jpg', Buffer.from(await response.arrayBuffer())); }
const browser = await chromium.launch({ executablePath: process.env.BROWSER_PATH ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
const errors = [], requests = [];
async function savedDocument(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('image-editor-v1'); request.onerror = () => reject(request.error);
    request.onsuccess = () => { const db = request.result, tx = db.transaction('state'), r = tx.objectStore('state').get('current'); r.onsuccess = () => resolve(r.result?.document); r.onerror = () => reject(r.error); tx.oncomplete = () => db.close(); };
  }));
}
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  page.setDefaultTimeout(15000);
  page.on('requestfailed', r => errors.push(`${r.url()}: ${r.failure()?.errorText}`));
  page.on('response', async r => { if (r.url().includes('onnx') || r.url().includes('ort-wasm')) requests.push({ url: r.url(), status: r.status() }); });
  await page.goto(process.env.EDITOR_URL ?? 'http://127.0.0.1:5173/');
  await page.waitForFunction(() => !document.querySelector('[data-action=import]').disabled);
  await page.locator('[data-el=files]').setInputFiles('.cache/qa/cats.jpg');
  await page.waitForFunction(() => document.querySelectorAll('[data-layer]').length === 1 && !document.querySelector('[data-action=import]').disabled);
  await page.locator('[data-tool=model]').click();
  assert.equal(requests.length, 0, 'Model resources must not load before consent');
  await page.locator('[data-action=model-enable]').click(); await page.locator('dialog button[value=ok]').click();
  console.log('Model download started');
  try {
    await page.waitForFunction(() => document.querySelector('[data-action=model-enable]').hidden || document.querySelector('[data-el=status]').dataset.error === 'true', null, { timeout: 180000 });
    const status = await page.locator('[data-el=status]').textContent();
    assert.equal(await page.locator('[data-action=model-enable]').isVisible(), false, `Model failed: ${status}`);
    console.log('Model loaded');
    const box = await page.locator('[data-el=canvas]').boundingBox(); await page.mouse.click(box.x + box.width / 2 - 320 + 90, box.y + box.height / 2 - 240 + 220);
    console.log('Foreground prompt sent');
    await page.waitForFunction(() => !document.querySelector('[data-action=apply]').hidden && !document.querySelector('[data-action=apply]').disabled, null, { timeout: 180000 });
    assert.notEqual(await page.locator('[data-el=status]').getAttribute('data-error'), 'true', await page.locator('[data-el=status]').textContent());
    console.log('Candidate ready');
    await page.locator('[data-action=apply]').click();
    console.log('Candidate committed');
    await page.locator('[data-tool=refine]').click(); await page.locator('[data-action=refine]').click();
    console.log('Matting requested');
    await page.waitForFunction(() => !document.querySelector('[data-action=apply]').disabled); await page.locator('[data-action=apply]').click();
    console.log('Matting committed');
    await page.locator('[data-action=copy]').waitFor({ state: 'visible' }); assert.equal(await page.locator('[data-action=copy]').isEnabled(), true);
    await page.locator('[data-action=copy]').click(); assert.equal(await page.locator('[data-layer]').count(), 2);
    console.log('Layer copied');
    let state; const deadline = Date.now() + 15000;
    while (Date.now() < deadline) { state = await savedDocument(page); if (state?.layers.length === 2) break; await new Promise(r => setTimeout(r, 100)); }
    assert.equal(state?.layers.length, 2, 'Copied layer must autosave'); console.log('Copied layer saved');
    const mask = Object.values(state.layers[1].mask);
    const quality = { foreground: mask[220 * 640 + 90], background: mask[400 * 640 + 310], partialAlpha: mask.some(v => v > 0 && v < 255) };
    assert.equal(quality.foreground, 255); assert.equal(quality.background, 0); assert.equal(quality.partialAlpha, true);
    await page.locator('[data-visibility]').last().uncheck();
    await page.screenshot({ path: '.cache/qa/model.png' });
    await page.locator('[data-tool=model]').click();
    await page.locator('[data-action=model-disable]').click(); assert.equal(await page.locator('[data-layer]').count(), 2);
    await page.route('https://huggingface.co/**', route => route.abort());
    await page.reload(); await page.waitForFunction(() => !document.querySelector('[data-action=import]').disabled);
    await page.locator('[data-tool=model]').click(); await page.locator('[data-action=model-enable]').click(); await page.locator('dialog button[value=ok]').click();
    await page.waitForFunction(() => document.querySelector('[data-action=model-enable]').hidden || document.querySelector('[data-el=status]').dataset.error === 'true', null, { timeout: 30000 });
    assert.equal(await page.locator('[data-action=model-enable]').isVisible(), false, 'Cached model should load with remote model requests blocked');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed: 'model download, WASM inference, real photo foreground/background, fractional edge alpha, copy, disable preservation, cached reload without model network access', quality, requests: requests.map(r => ({ ...r, url: r.url.split('?')[0] })), errors }, null, 2));
  } catch (e) { console.log(JSON.stringify({ status: await page.locator('[data-el=status]').textContent(), errors, requests }, null, 2)); await page.screenshot({ path: '.cache/qa/model-failure.png' }); throw e; }
  await context.close();
} finally { await browser.close(); }
