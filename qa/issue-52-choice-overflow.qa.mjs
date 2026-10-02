import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { seed } from './fixtures.mjs';

const artifact = resolve(process.env.QA_ARTIFACT || 'LoopDeck3.html');
const url = process.env.QA_BASE_URL || pathToFileURL(artifact).href;

async function go(page, route) {
  await page.goto(`${url}#${route}`);
  await page.reload();
}

async function start(page) {
  await expect(page.locator('.module-screen')).toBeVisible();
  await page.locator('.v2-customize > summary').click();
  await page.getByLabel('シャッフル', { exact: false }).uncheck();
  await page.getByLabel('正解時', { exact: false }).uncheck();
  await page.getByRole('button', { name: '学習を始める', exact: true }).click();
  await expect(page.locator('.question-prompt')).toBeVisible();
}

for (const [width, height] of [[320, 568], [360, 800]]) {
  test(`issue #52: long unbroken choices wrap at ${width}x${height}`, async ({ page }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error') errors.push(message.text());
    });

    await page.setViewportSize({ width, height });
    await go(page, 'home');
    await seed(page, false);
    await go(page, 'module/qa-module-0');
    await start(page);

    await page.getByPlaceholder('答えを入力').fill('wrong');
    await page.getByRole('button', { name: '回答する', exact: true }).click();
    await page.getByRole('button', { name: '次へ', exact: true }).click();

    const choices = page.locator('.choice-btn');
    await expect(choices).toHaveCount(4);
    const longChoice = choices.nth(1);
    await expect(longChoice).toContainText('長い日本語教材名');
    await expect(longChoice).toContainText('ABC');
    await expect(longChoice).toContainText('UnbrokenEnglishToken');
    await page.evaluate(() => document.fonts.ready);

    const metrics = await page.evaluate(() => {
      const root = document.documentElement;
      const buttons = [...document.querySelectorAll('.choice-btn')];
      if (buttons.length !== 4) throw new Error(`Expected 4 choices, got ${buttons.length}`);
      const rects = buttons.map(button => {
        const rect = button.getBoundingClientRect();
        return {
          left: rect.left,
          right: rect.right,
          width: rect.width,
          height: rect.height,
          clientWidth: button.clientWidth,
          scrollWidth: button.scrollWidth,
        };
      });
      return {
        viewportWidth: root.clientWidth,
        documentScrollWidth: root.scrollWidth,
        overflowWrap: getComputedStyle(buttons[1]).overflowWrap,
        rects,
      };
    });

    expect(metrics.documentScrollWidth).toBeLessThanOrEqual(metrics.viewportWidth + 2);
    expect(metrics.overflowWrap).toBe('anywhere');
    for (const rect of metrics.rects) {
      expect(rect.left).toBeGreaterThanOrEqual(-2);
      expect(rect.right).toBeLessThanOrEqual(metrics.viewportWidth + 2);
      expect(rect.scrollWidth).toBeLessThanOrEqual(rect.clientWidth + 1);
    }
    expect(metrics.rects[1].width).toBeCloseTo(metrics.rects[0].width, 0);
    expect(metrics.rects[1].height).toBeGreaterThan(metrics.rects[0].height);

    for (let i = 0; i < 4; i += 1) {
      const choice = choices.nth(i);
      await choice.scrollIntoViewIfNeeded();
      await expect(choice).toBeInViewport();
    }

    await longChoice.click();
    await expect(page.locator('.result-area')).toBeVisible();
    const resultOverflow = await page.evaluate(() => ({
      width: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    expect(resultOverflow.scroll).toBeLessThanOrEqual(resultOverflow.width + 2);
    expect(errors).toEqual([]);
  });
}
