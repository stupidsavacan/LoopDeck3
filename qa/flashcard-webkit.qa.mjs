import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Load production single-file CSS, not a copy. Regression: Safari used to paint
// a transparent back because contain:paint flattened the preserve-3d ancestor.
const url = pathToFileURL(resolve('LoopDeck3.html')).href;

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
    expect(painted.equals(stable), 'screenshots must be stable before comparing').toBe(true);
    await back.evaluate(node => node.style.setProperty('visibility', 'hidden', 'important'));
    const withoutBack = await wrap.screenshot({ animations: 'disabled' });
    expect(painted.equals(withoutBack), 'back face must contribute visible pixels').toBe(false);
    await info.attach('painted-flashcard-back.png', { body: painted, contentType: 'image/png' });
  });
}
