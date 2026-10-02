import { test as base, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fixture, seed } from './fixtures.mjs';

const artifact = resolve(process.env.QA_ARTIFACT || 'LoopDeck3.html');
const url = process.env.QA_BASE_URL || pathToFileURL(artifact).href;
const test = base.extend({
  page: async ({ page, browser }, use, info) => {
    const errors = [], network = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', msg => { if (msg.type() === 'error') errors.push({ text: msg.text(), location: msg.location() }); });
    if (!process.env.QA_BASE_URL) await page.route(/^https?:/, route => { network.push(route.request().url()); return route.abort(); });
    const environment = { browser: browser.version(), url, platform: process.platform };
    if (!process.env.QA_BASE_URL) environment.sha256 = createHash('sha256').update(await readFile(artifact)).digest('hex');
    await info.attach('environment', { body: JSON.stringify(environment), contentType: 'application/json' });
    await use(page);
    expect(errors, 'unexpected console/page errors').toEqual([]);
    expect(network, 'single-file attempted network access').toEqual([]);
  },
});
const routes = { home: '.home-screen', 'module/qa-module-0': '.module-screen', review: '.review-screen', graphs: '.graphs-screen', import: '.import-screen', 'pdf-worksheet': '.pdf-worksheet-screen', 'debug-log': '.debug-log-screen' };
async function go(page, route) { await page.goto(`${url}#${route}`); await page.reload(); await expect(page.locator(routes[route] || '.module-screen')).toBeVisible(); }
async function layout(page, info, name) {
  await page.evaluate(() => document.fonts.ready);
  const overflow = await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    return { width, scroll: document.documentElement.scrollWidth, offenders: [...document.querySelectorAll('main *')].filter(e => { const r = e.getBoundingClientRect(); return r.width && (r.right > width + 2 || r.left < -2); }).slice(0, 12).map(e => `${e.tagName}.${e.className}`) };
  });
  expect.soft(overflow.scroll, JSON.stringify({ name, ...overflow })).toBeLessThanOrEqual(overflow.width + 2);
  if (process.env.QA_SCREENSHOTS === 'all' || /home|quiz-result/.test(name)) await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: true });
}
async function start(page) {
  await page.locator('.v2-customize > summary').click();
  await page.getByLabel('シャッフル', { exact: false }).uncheck();
  await page.getByLabel('正解時', { exact: false }).uncheck();
  await page.getByRole('button', { name: '学習を始める', exact: true }).click();
  await expect(page.locator('.question-prompt')).toBeVisible();
}
const sizes = [[320,568],[360,800],[390,844],[412,915],[600,960],[744,1133],[768,1024],[810,1080],[820,1180],[834,1194],[1024,768],[1180,820],[1194,834],[1024,600],[1280,720],[1366,768],[1440,900],[1920,1080],[2560,1080], ...[359,361,419,420,421,759,760,761,899,900,901,999,1000,1001].map(w => [w,800])];
for (const [width, height] of sizes) test(`matrix ${width}x${height}`, async ({ page }, info) => {
  await page.setViewportSize({ width, height });
  await go(page, 'home');
  await layout(page, info, 'empty-home');
  await seed(page);
  for (const route of Object.keys(routes)) {
    await go(page, route);
    await layout(page, info, route.replace('/', '-'));
    if (route === 'home') { await page.locator('.folder-head').last().click(); await layout(page, info, 'folder'); }
    if (route.startsWith('module')) {
      await start(page);
      await layout(page, info, 'quiz-input');
      await page.getByPlaceholder('答えを入力').fill('wrong');
      await page.getByRole('button', { name: '回答する', exact: true }).dblclick();
      await layout(page, info, 'quiz-result');
      await page.getByRole('button', { name: '次へ', exact: true }).click();
      await expect(page.locator('.choice-btn')).toHaveCount(4);
      await layout(page, info, 'quiz-long-choices');
    }
  }
});

test('images, all question types, resize, session persistence and double submit', async ({ page }, info) => {
  await go(page, 'home'); await seed(page, false); await go(page, 'module/qa-module-0'); await start(page);
  for (let i = 0; i < 12; i++) {
    await expect(page.locator('.question-prompt')).toContainText(`${i} `);
    for (const [width, height] of [[390,844],[844,390],[390,300],[390,844]]) { await page.setViewportSize({ width, height }); await layout(page, info, `q${i}-${width}-${height}`); }
    if (i >= 3 && i <= 8) {
      const img = page.locator('.question-image'); await img.scrollIntoViewIfNeeded();
      await expect.poll(() => img.evaluate(e => e.complete && e.naturalWidth > 0)).toBe(true);
      // object-fit: contain preserves pixels even when the bordered box is capped.
      expect(await img.evaluate(e => getComputedStyle(e).objectFit)).toBe('contain');
    } else if (i >= 9) await expect(page.locator('.image-fallback')).toContainText('見つかりません');
    if (i % 3 === 0) { await page.getByPlaceholder('答えを入力').fill(i ? 'answer' : 'answe'); await page.getByRole('button', { name: '回答する', exact: true }).dblclick(); }
    else if (i % 3 === 1) await page.locator('.choice-btn').first().click();
    else { await page.locator('.choice-btn').first().click(); await page.getByRole('button', { name: '選択を確定' }).click(); }
    await page.getByRole('button', { name: '次へ', exact: true }).click();
    if (i === 0) { await page.reload(); await page.getByRole('button', { name: /再開/ }).click(); }
  }
  await expect(page.getByRole('button', { name: '教材詳細に戻る' })).toBeVisible();
  const count = await page.evaluate(() => new Promise(resolve => { const r = indexedDB.open('loopdeck-db'); r.onsuccess = () => { const db = r.result; const q = db.transaction('attempts').objectStore('attempts').count(); q.onsuccess = () => { resolve(q.result); db.close(); }; }; }));
  expect(count).toBe(12);
});

test('shared built-in assets decode and occur once in artifact', async ({ page }) => {
  await go(page, 'home');
  if (process.env.QA_BASE_URL) return;
  const assets = await page.evaluate(() => globalThis.__LOOPDECK_EMBEDDED_ASSETS__);
  expect(Object.keys(assets)).toHaveLength(4);
  const html = await readFile(artifact, 'utf8');
  for (const value of Object.values(assets)) {
    expect(html.split(value).length - 1).toBe(1);
    expect(await page.evaluate(src => new Promise(resolve => { const img = new Image(); img.onload = () => resolve(img.naturalWidth > 0); img.onerror = () => resolve(false); img.src = src; }), value)).toBe(true);
  }
});

test('import error recovery, merge preview, JSON/ZIP/backup and PDF downloads', async ({ page }, info) => {
  await go(page, 'import');
  const input = page.locator('input[type=file]');
  await input.setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from('{') });
  await expect(page.locator('.issue.error')).not.toHaveCount(0);
  const pack = fixture().packs[0];
  await input.setInputFiles({ name: 'long-filename-'.repeat(15) + '.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(pack)) });
  await page.getByRole('button', { name: 'この教材を取り込む', exact: true }).click();
  await expect(page.locator('.home-screen')).toBeVisible();
  await go(page, 'import');
  await input.setInputFiles({ name: 'merge.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(pack)) });
  await expect(page.getByRole('button', { name: 'マージ更新する', exact: true })).toBeVisible();
  for (const name of ['JSON', 'ZIP', '履歴バックアップを書き出し']) {
    const download = page.waitForEvent('download'); await page.getByRole('button', { name, exact: true }).last().click();
    const file = await download; expect(await file.failure()).toBeNull();
    const path = info.outputPath(file.suggestedFilename()); await file.saveAs(path); expect((await readFile(path)).length).toBeGreaterThan(20);
  }
  await go(page, 'pdf-worksheet');
  const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'PDFを書き出す' }).click();
  const file = await download; const path = info.outputPath('worksheet.pdf'); await file.saveAs(path);
  expect((await readFile(path)).subarray(0, 5).toString()).toBe('%PDF-');
});

// Reflow equivalents only: this does not certify native Chrome zoom or OS scaling.
test('80–200 percent zoom-equivalent reflow across routes', async ({ page }, info) => {
  await go(page, 'home'); await seed(page);
  for (const scale of [0.8, 1, 1.25, 1.5, 1.75, 2]) {
    await page.setViewportSize({ width: Math.round(1280 / scale), height: Math.round(720 / scale) });
    for (const route of Object.keys(routes)) {
      await go(page, route); await layout(page, info, `reflow-${scale}-${route.replace('/', '-')}`);
    }
  }
});

test('review, bookmarks, browser history, debug clear and reduced-height input', async ({ page }, info) => {
  await go(page, 'review'); await expect(page.getByRole('button', { name: '今日の復習を始める' })).toBeVisible();
  await seed(page); await go(page, 'review');
  await page.getByRole('button', { name: '今日の復習を始める' }).click();
  await expect(page.locator('.question-prompt')).toBeVisible();
  await page.getByRole('button', { name: '答えを見る', exact: true }).click();
  await page.getByRole('button', { name: '次へ', exact: true }).click();
  await go(page, 'module/qa-module-0'); await start(page);
  await page.getByRole('button', { name: 'ブックマーク済み', exact: true }).click();
  await expect(page.getByRole('button', { name: 'ブックマーク', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'ブックマーク', exact: true }).click();
  await expect(page.getByRole('button', { name: 'ブックマーク済み', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 300 });
  const answer = page.getByPlaceholder('答えを入力'); await answer.fill('answer'); await answer.scrollIntoViewIfNeeded();
  await expect(answer).toBeInViewport();
  await page.getByRole('button', { name: '回答する', exact: true }).click();
  const next = page.getByRole('button', { name: '次へ', exact: true }); await next.scrollIntoViewIfNeeded(); await expect(next).toBeInViewport();
  await layout(page, info, 'keyboard-result');
  await page.setViewportSize({ width: 1280, height: 720 });
  await go(page, 'module/qa-module-0');
  await page.getByRole('button', { name: 'ホーム', exact: true }).click();
  await expect(page.locator('.home-screen')).toBeVisible();
  await page.goBack(); await expect(page.locator('.module-screen')).toBeVisible();
  await page.goForward(); await expect(page.locator('.home-screen')).toBeVisible();
  await go(page, 'debug-log');
  await page.locator('.debug-log-list details').first().locator('summary').click();
  await layout(page, info, 'expanded-debug');
  page.once('dialog', dialog => dialog.dismiss()); await page.getByRole('button', { name: 'ログを消去' }).click();
  await expect(page.locator('.debug-log-list details')).not.toHaveCount(0);
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'ログを消去' }).click();
  await expect(page.locator('.debug-log-list')).toContainText('まだログはありません');
});
