import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Load production single-file CSS, not a copy. Regression: Safari used to paint
// a transparent back because contain:paint flattened the preserve-3d ancestor.
const url = pathToFileURL(resolve('LoopDeck3.html')).href;

// GPU raster of the rotated back face can move anti-aliased corners and the gradient
// band by 1-3 levels between two captures, so "stable" means within a few levels.
const STABLE_CHANNEL_TOLERANCE = 4;

/** Decodes both PNGs in the page and counts pixels whose largest channel difference exceeds the tolerance. */
async function comparePngs(page, first, second) {
  return page.evaluate(
    async ([a, b, tolerance]) => {
      const decode = async (base64) => {
        const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob());
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const context = canvas.getContext('2d');
        context.drawImage(bitmap, 0, 0);
        return context.getImageData(0, 0, bitmap.width, bitmap.height);
      };
      const [left, right] = await Promise.all([decode(a), decode(b)]);
      if (left.width !== right.width || left.height !== right.height) return { sameSize: false, maxDiff: 255, changed: left.width * left.height, total: left.width * left.height };
      let maxDiff = 0;
      let changed = 0;
      for (let index = 0; index < left.data.length; index += 4) {
        const diff = Math.max(
          Math.abs(left.data[index] - right.data[index]),
          Math.abs(left.data[index + 1] - right.data[index + 1]),
          Math.abs(left.data[index + 2] - right.data[index + 2]),
          Math.abs(left.data[index + 3] - right.data[index + 3])
        );
        maxDiff = Math.max(maxDiff, diff);
        if (diff > tolerance) changed += 1;
      }
      return { sameSize: true, maxDiff, changed, total: left.width * left.height };
    },
    [first.toString('base64'), second.toString('base64'), STABLE_CHANNEL_TOLERANCE]
  );
}

for (const [width, height] of [[390, 844], [834, 1062]]) {
  test(`WebKit paints the flipped flashcard back at ${width}x${height}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height });
    await page.goto(url);
    await expect(page.locator('.home-screen')).toBeVisible();

    // Real stylesheet with the production flip DOM structure; deterministic content.
    await page.evaluate(() => {
      const stage = document.createElement('section');
      stage.id = 'flashcard-webkit-probe';
      stage.className = 'flashcard-stage';
      stage.style.cssText = 'position:fixed;inset:0;z-index:2147483647;min-height:0;padding:0;background:#f5f7fb;';
      stage.innerHTML = `
        <div class="flashcard-stack">
          <div class="flashcard-wrap" role="button" tabindex="0">
            <div class="flashcard-inner">
              <div class="flashcard-face flashcard-front" aria-hidden="false">
                <span class="flashcard-side-label">FRONT</span>
                <div class="flashcard-content"><p class="flashcard-term">Question</p></div>
              </div>
              <div class="flashcard-face flashcard-back" aria-hidden="true">
                <span class="flashcard-side-label">BACK</span>
                <div class="flashcard-content"><p class="flashcard-term">Safari answer</p></div>
              </div>
            </div>
          </div>
        </div>`;
      document.body.append(stage);
    });

    const wrap = page.locator('#flashcard-webkit-probe .flashcard-wrap');
    const inner = wrap.locator('.flashcard-inner');
    const back = wrap.locator('.flashcard-back');
    await expect(wrap).toBeVisible();
    const containment = await inner.evaluate(node => getComputedStyle(node).contain);
    expect(containment, '3D flip must not use paint containment').not.toMatch(/paint|strict|content/);
    await wrap.evaluate(node => {
      node.classList.add('is-flipped');
      node.querySelector('.flashcard-front').setAttribute('aria-hidden', 'true');
      node.querySelector('.flashcard-back').setAttribute('aria-hidden', 'false');
    });
    await expect(back).toHaveAttribute('aria-hidden', 'false');
    await page.evaluate(() => document.fonts.ready);
    const painted = await wrap.screenshot({ animations: 'disabled' });
    const stable = await wrap.screenshot({ animations: 'disabled' });
    const stability = await comparePngs(page, painted, stable);
    expect(stability, 'screenshots must be stable (within a few levels) before comparing').toMatchObject({ sameSize: true, changed: 0 });
    await back.evaluate(node => node.style.setProperty('visibility', 'hidden', 'important'));
    const withoutBack = await wrap.screenshot({ animations: 'disabled' });
    // A transparent back would change almost nothing; a painted one changes a visible share of the card.
    const contribution = await comparePngs(page, painted, withoutBack);
    expect(contribution.changed / contribution.total, 'back face must contribute visible pixels').toBeGreaterThan(0.01);
    await info.attach('painted-flashcard-back.png', { body: painted, contentType: 'image/png' });
  });
}
