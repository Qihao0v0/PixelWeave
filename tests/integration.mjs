import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
const browser = await chromium.launch({ executablePath: process.env.BROWSER_PATH ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } }); const errors = []; page.on('pageerror', e => errors.push(e.message));
  // The source module is imported from Vite's development server for the host integration test.
  await page.goto(process.env.EDITOR_URL ?? 'http://127.0.0.1:5173/');
  await page.waitForFunction(() => !document.querySelector('[data-action=import]').disabled);
  await page.evaluate(async () => {
    const { mountEditor } = await import('/src/editor.ts');
    const root = document.createElement('section'); root.id = 'embedded'; root.style.cssText = 'position:fixed;top:0;left:0;width:400px;height:500px;z-index:10'; document.body.append(root);
    window.embeddedEditor = mountEditor(root, { storageKey: 'isolated-editor-test', assetBaseURL: '/' });
  });
  await page.waitForFunction(() => !document.querySelector('#embedded [data-action=import]').disabled);
  const dimensions = await page.locator('#embedded .ie').boundingBox(); assert.equal(dimensions.width, 400); assert.equal(dimensions.height, 500);
  assert.equal(await page.locator('#embedded [data-action=layers]').isVisible(), true); assert.equal(await page.locator('#embedded .ie-side').isVisible(), false);
  await page.locator('#embedded [data-action=layers]').click(); const drawer = await page.locator('#embedded .ie-side').boundingBox(); assert.ok(drawer.x >= 0 && drawer.y >= 0 && drawer.y + drawer.height <= 500);
  assert.equal(await page.locator('#embedded .ie-layer-panel').isVisible(), true); assert.equal(await page.locator('#embedded .ie-controls-panel').isVisible(), false);
  await page.locator('#embedded [data-action=controls]').click(); assert.equal(await page.locator('#embedded .ie-controls-panel').isVisible(), true); assert.equal(await page.locator('#embedded .ie-layer-panel').isVisible(), false);
  await page.evaluate(async () => { await window.embeddedEditor.destroy(); });
  assert.equal(await page.locator('#embedded').evaluate(el => el.childElementCount), 0); assert.equal(await page.locator('#embedded').getAttribute('class'), '');
  assert.deepEqual(errors, []); console.log('Host integration passed: isolated storage, 400×500 container layout, bounded layer drawer, async destroy');
} finally { await browser.close(); }
