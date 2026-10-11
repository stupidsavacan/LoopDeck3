// Explicit Android-only QA: writes the existing overflow fixture to the debug app.
// The release app is never accessed. Run with --serial; no default phone selection.
import { parseArgs } from 'node:util';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { expect } from '@playwright/test';
import { loadDeviceModule } from '../scripts/ldev.mjs';
import { startOverflowSession, settleCard, measureFace, overflowPack } from './flashcard-overflow-fixture.mjs';

const { values } = parseArgs({ options: { serial: { type: 'string' }, session: { type: 'string' } }, strict: true });
if (!values.serial) throw new Error('Android QA requires an explicit --serial');
const session = resolve(values.session ?? `qa-results/android/smoke-${Date.now()}`);
const { withDeviceSession } = await loadDeviceModule('fixture');
const { captureStateInPage, defaultCaptureArg, summarizeCapture, compareStates } = await loadDeviceModule('state');
const results = { target: 'Android debug WebView', status: 'FAIL', faces: [], checks: [], cleanup: 'unverified' };
await mkdir(session, { recursive: true });

try {
  await withDeviceSession({ serial: values.serial, session, launch: true }, async (api) => {
    await api.rotate('portrait');
    await api.webView(async ({ page: wrapped }) => {
      const page = wrapped.playwrightPage;
      if (!page) throw new Error('A real Android Playwright page is required');
      const url = page.url().split('#')[0];
      await startOverflowSession(page, url);
      for (const [index, question] of overflowPack.questions.entries()) {
        await expect(page.locator('.flashcard-position')).toHaveText(`${index + 1} / 8`);
        for (const side of ['front', 'back']) {
          if (side === 'back') await api.tap({ css: '.flashcard-wrap' }, { native: true });
          await settleCard(page);
          await expect(page.locator(`.flashcard-${side}`)).toHaveAttribute('aria-hidden', 'false');
          const initial = await measureFace(page, side);
          expect(initial.firstVisible).toBe(true);
          expect(initial.font).toBeGreaterThanOrEqual(18.4);
          if (['reported', 'ninety', 'short'].includes(question.id)) {
            expect(initial.lastVisible).toBe(true);
            expect(initial.scrollHeight).toBeLessThanOrEqual(initial.height + 1);
          }
          const hiddenSide = side === 'front' ? 'back' : 'front';
          const hidden = page.locator(`.flashcard-${hiddenSide} .flashcard-content`);
          const hiddenTop = await hidden.evaluate((node) => node.scrollTop);
          for (let attempt = 0; attempt < 30 && !(await measureFace(page, side)).lastVisible; attempt++) {
            const before = (await measureFace(page, side)).scrollTop;
            await api.swipe({ css: `.flashcard-${side} .flashcard-content` }, 'up', { distance: 160 });
            await expect.poll(async () => (await measureFace(page, side)).scrollTop).toBeGreaterThan(before);
          }
          const final = await measureFace(page, side);
          expect(final.lastVisible).toBe(true);
          expect(await hidden.evaluate((node) => node.scrollTop)).toBe(hiddenTop);
          results.faces.push({ question: question.id, side, passed: true });
          console.log(`Android face ${question.id}/${side}: PASS`);
        }
        await api.tap({ role: 'button', name: '知ってる' }, { native: true });
      }
      await expect(page.locator('.flashcard-donut-center')).toHaveText('100%KNOWN');

      await startOverflowSession(page, url);
      await api.rotate('landscape');
      await expect.poll(() => page.evaluate(() => innerWidth > innerHeight)).toBe(true);
      await settleCard(page);
      expect((await measureFace(page, 'front')).lastVisible).toBe(true);
      await api.rotate('portrait');
      await expect.poll(() => page.evaluate(() => innerWidth < innerHeight)).toBe(true);
      await settleCard(page);
      await api.swipe({ css: '.flashcard-wrap' }, 'right');
      await expect(page.locator('.flashcard-position')).toHaveText('2 / 8');
      await settleCard(page);
      await api.swipe({ css: '.flashcard-wrap' }, 'left');
      await expect(page.locator('.flashcard-position')).toHaveText('3 / 8');
      await expect(page.locator('.flashcard-counts')).toHaveText('KNOWN 1 · AGAIN 1');
      results.checks.push('native rotation', 'native KNOWN/AGAIN swipes');
      // Complete this session before comparing state, so visibility changes do
      // not intentionally update a live learning checkpoint during the check.
      for (let position = 3; position <= 8; position++) {
        await expect(page.locator('.flashcard-position')).toHaveText(`${position} / 8`);
        await api.tap({ role: 'button', name: '知ってる' }, { native: true });
      }
      await expect(page.locator('.flashcard-donut-center')).toBeVisible();
      const captured = summarizeCapture(await page.evaluate(captureStateInPage, defaultCaptureArg()));
      expect(captured.complete).toBe(true);
      results.beforeLifecycle = { count: captured.totalCount, sha256: captured.sha256 };
    });

    const baseline = await api.collect({ label: 'baseline', expectSame: false });
    expect(baseline.summary.overall).toBe('PASS');
    await api.lifecycle('background');
    await api.lifecycle('resume');
    const resumed = await api.collect({ label: 'resumed', compareTo: baseline.directory, expectSame: true });
    expect(resumed.summary.comparison.verdict).toBe('same');
    const restarted = await api.lifecycle('relaunch');
    expect(restarted.pidChanged).toBe(true);
    const after = await api.collect({ label: 'relaunched', compareTo: baseline.directory, expectSame: true });
    expect(after.summary.overall).toBe('PASS');
    expect(compareStates(baseline.summary.state, after.summary.state).verdict).toBe('same');
    results.checks.push('background/resume persistence', 'process relaunch persistence', 'evidence state comparison');
    results.status = 'PASS';
    await api.lifecycle('background');
  });
} catch (error) {
  results.status = 'FAIL';
  results.error = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  try {
    const record = JSON.parse(await readFile(join(session, 'session.json'), 'utf8'));
    results.cleanup = record.status;
  } catch {
    results.cleanup = 'unverified';
  }
  await writeFile(join(session, 'acceptance.json'), `${JSON.stringify(results, null, 2)}\n`);
  console.log(`Android QA ${results.status}; cleanup ${results.cleanup}; evidence ${session}`);
}
