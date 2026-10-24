import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { overflowPack, startOverflowSession, settleCard, measureFace, checkTouchScroll, dragTouch } from './flashcard-overflow-fixture.mjs';

const url = process.env.QA_BASE_URL || pathToFileURL(resolve('LoopDeck3.html')).href;
const sizes = [[320, 568], [360, 640], [360, 740], [390, 844], [412, 915], [768, 1024], [1280, 720]];
for (const [width, height] of sizes) test(`flashcard text fit and visible face touch scroll ${width}x${height}`, async ({ page }, info) => {
  await page.setViewportSize({ width, height });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await startOverflowSession(page, url);
  const measurements = [];
  for (const question of overflowPack.questions) {
    await expect(page.locator('.flashcard-position')).toHaveText(`${overflowPack.questions.indexOf(question) + 1} / 8`);
    await expect(page.locator('.flashcard-front .flashcard-term')).toHaveText(question.prompt);
    await settleCard(page);
    const fonts = [];
    for (const side of ['front', 'back']) {
      if (side === 'back') { await dragTouch(page, page.locator('.flashcard-wrap'), 0, 0); await settleCard(page); }
      await expect(page.locator(`.flashcard-${side}`)).toHaveAttribute('aria-hidden', 'false');
      const measure = await measureFace(page, side);
      fonts.push(measure.font);
      measurements.push({ question: question.id, side, ...measure });
      expect(measure.font).toBeGreaterThanOrEqual(17.6);
      expect(measure.scrollWidth).toBeLessThanOrEqual(measure.width + 1);
      expect(measure.firstVisible).toBe(true);
      if (['reported', 'ninety', 'short'].includes(question.id)) {
        expect(measure.scrollHeight).toBeLessThanOrEqual(measure.height + 1);
        expect(measure.lastVisible).toBe(true);
      } else if (measure.scrollHeight > measure.height + 1) {
        await checkTouchScroll(page, side);
      }
      if (question.id === 'lines') expect(measure.whiteSpace).toBe('pre-wrap');
      if (question.id === 'reported') await page.screenshot({ path: info.outputPath(`${side}-reported.png`), fullPage: true });
    }
    if (question.id === 'ninety') expect(Math.abs(fonts[0] - fonts[1]) / fonts[0]).toBeLessThan(0.1);
    if (question.id === 'extras') {
      expect(fonts[1]).toBeGreaterThan(25); // Supporting material must not force a short answer to minimum size.
      await expect(page.locator('.flashcard-front img')).toHaveJSProperty('complete', true);
    }
    await page.getByRole('button', { name: '知ってる', exact: true }).click();
  }
  await expect(page.locator('.flashcard-donut-center')).toHaveText('100%知ってる');
  await info.attach('face-measurements', { body: JSON.stringify(measurements, null, 2), contentType: 'application/json' });
  expect(errors).toEqual([]);
});

test('flashcard refits after rotation and keeps scroll position on flip', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await startOverflowSession(page, url);
  const portrait = await measureFace(page, 'front');
  await page.setViewportSize({ width: 740, height: 360 }); await settleCard(page);
  const landscape = await measureFace(page, 'front');
  expect(landscape.lastVisible).toBe(true);
  expect(landscape.font).toBeGreaterThan(portrait.font);
  await page.setViewportSize({ width: 320, height: 568 }); await settleCard(page);
  expect((await measureFace(page, 'front')).lastVisible).toBe(true);
  for (let i = 0; i < 3; i++) {
    await page.getByRole('button', { name: '知ってる', exact: true }).click();
    await expect(page.locator('.flashcard-position')).toHaveText(`${i + 2} / 8`);
  }
  await settleCard(page);
  await dragTouch(page, page.locator('.flashcard-front .flashcard-content'), 0, -100);
  const top = (await measureFace(page, 'front')).scrollTop;
  expect(top).toBeGreaterThan(20);
  for (let i = 0; i < 2; i++) { await dragTouch(page, page.locator('.flashcard-wrap'), 0, 0); await settleCard(page); }
  expect((await measureFace(page, 'front')).scrollTop).toBe(top);
  await dragTouch(page, page.locator('.flashcard-wrap'), 120, 0);
  await expect(page.locator('.flashcard-position')).toHaveText('5 / 8');
  await dragTouch(page, page.locator('.flashcard-wrap'), -120, 0);
  await expect(page.locator('.flashcard-position')).toHaveText('6 / 8');
  await expect(page.locator('.flashcard-counts')).toHaveText('知ってる 4 · 知らない 1');
});
