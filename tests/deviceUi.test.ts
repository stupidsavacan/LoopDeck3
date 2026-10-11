import { describe, expect, it } from 'vitest';
import { expectVisible, pickerInspect, pickerSelect, swipe, tap } from '../tools/device/actions';
import { cssToScreen, planSwipe, validateGeometry, type ViewportInfo } from '../tools/device/geometry';
import { prepareSession } from '../tools/device/lifecycle';
import type { ElementMeasure } from '../tools/device/pageScripts';
import { sessionPaths } from '../tools/device/session';
import { findAppWebView, findPickerNode, parseUiDump } from '../tools/device/ui';
import { FakeAdb, FakeCdp, appUi, fakeDeps, pickerUi, tempDir } from './helpers/deviceFakes';

const viewport = (width: number, height: number, dpr = 3, extra: Partial<ViewportInfo['visualViewport']> = {}): ViewportInfo => ({
  innerWidth: width,
  innerHeight: height,
  dpr,
  visualViewport: { offsetLeft: 0, offsetTop: 0, width, height, scale: 1, ...extra }
});

const measure = (rect: ElementMeasure['rect'], vp: ViewportInfo, hit = true, pointHits?: boolean[]): ElementMeasure => ({
  rect,
  point: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
  hit,
  pointHits,
  viewport: vp
});

async function device(ui: string) {
  const dir = tempDir();
  const adb = new FakeAdb();
  adb.ui = [ui];
  const cdp = new FakeCdp();
  const { run } = await prepareSession(fakeDeps(adb, cdp, dir), sessionPaths(undefined, dir), 'T1', false);
  return { adb, cdp, run };
}

const inputs = (adb: FakeAdb) => adb.shellCalls.filter((words) => words[0] === 'input');

describe('uiautomator parsing and DocumentsUI selection', () => {
  it('collapses the same-bounds virtual WebView child but refuses distinct views', () => {
    const snapshot = parseUiDump(appUi({ width: 720, height: 1600, top: 70 }));
    const physical = snapshot.nodes[1];
    const virtual = { ...physical, depth: 2, bounds: { ...physical.bounds!, right: 721 } };
    snapshot.nodes.push(virtual);
    expect(findAppWebView(snapshot)).toEqual(physical.bounds);
    snapshot.nodes[2] = { ...virtual, depth: 1 };
    expect(() => findAppWebView(snapshot)).toThrow(/found 2/);
    snapshot.nodes[2] = { ...virtual, bounds: { ...virtual.bounds, right: 600 } };
    expect(() => findAppWebView(snapshot)).toThrow(/found 2/);
  });
  it('reads bounds without interpolating attribute text anywhere', () => {
    const snapshot = parseUiDump(appUi({ width: 1080, height: 2400, top: 72 }));
    expect(snapshot.nodes[1]).toMatchObject({
      cls: 'android.webkit.WebView',
      depth: 1,
      bounds: { left: 0, top: 72, right: 1080, bottom: 2400 }
    });
  });

  it('selects only exact text or resource-id inside DocumentsUI, exactly once', () => {
    const snapshot = parseUiDump(pickerUi());
    expect(findPickerNode(snapshot, { text: 'backup.json' })).toEqual({ x: 300, y: 250 });
    expect(() => findPickerNode(snapshot, { text: 'backup' })).toThrow(/exactly one/); // no substring matching
    expect(() => findPickerNode(snapshot, { resourceId: 'com.google.android.documentsui:id/title' })).toThrow(/found 2/);
    expect(() => findPickerNode(snapshot, {})).toThrow(/exactly one of/);
    expect(() => findPickerNode(parseUiDump(appUi({ width: 1080, height: 2400 })), { text: 'x' })).toThrow(/DocumentsUI/);
  });

  it('taps a picker element natively and refuses outside DocumentsUI', async () => {
    const picker = await device(pickerUi());
    expect(await pickerInspect(picker.run)).toMatchObject({ foreground: ['com.google.android.documentsui'] });
    await pickerSelect(picker.run, { text: 'backup.json' });
    expect(inputs(picker.adb)).toEqual([['input', 'tap', '300', '250']]);

    const app = await device(appUi({ width: 1080, height: 2400 }));
    await expect(pickerSelect(app.run, { text: 'backup.json' })).rejects.toThrow(/DocumentsUI/);
    await expect(pickerInspect(app.run)).rejects.toThrow(/DocumentsUI/);
    expect(inputs(app.adb)).toEqual([]);
  });
});

describe('coordinate mapping', () => {
  it('maps CSS points through the WebView bounds including the top inset', () => {
    const webView = { left: 0, top: 72, right: 1080, bottom: 2400 };
    const vp = viewport(360, 776);
    validateGeometry(webView, vp, { left: 0, top: 0, right: 1080, bottom: 2400 });
    expect(cssToScreen({ x: 100, y: 200 }, webView, vp)).toEqual({ x: 300, y: 672 });
  });

  it('maps landscape bounds and honours a visual viewport offset', () => {
    const webView = { left: 0, top: 0, right: 2400, bottom: 1080 };
    const vp = viewport(800, 360, 3, { offsetLeft: 10 });
    validateGeometry(webView, { ...vp, innerWidth: 800 }, { left: 0, top: 0, right: 2400, bottom: 1080 });
    expect(cssToScreen({ x: 410, y: 100 }, webView, vp)).toEqual({ x: 1200, y: 300 });
  });

  it('refuses ambiguity: scale, offset, orientation mismatch, wrong dpr, off-display WebView, out-of-range points', () => {
    const display = { left: 0, top: 0, right: 1080, bottom: 2400 };
    const webView = { left: 0, top: 72, right: 1080, bottom: 2400 };
    expect(() => validateGeometry(webView, viewport(360, 776, 3, { scale: 1.5 }), display)).toThrow(/scale/);
    expect(() => validateGeometry(webView, viewport(360, 700), display)).toThrow(/ambiguous/); // 72px unexplained
    expect(() => validateGeometry(webView, viewport(360, 776, 2), display)).toThrow(/ambiguous/);
    expect(() => validateGeometry({ left: 0, top: 72, right: 1080, bottom: 2600 }, viewport(360, 842), display)).toThrow(
      /outside the display/
    );
    expect(() => validateGeometry({ left: 0, top: 0, right: 1080, bottom: 1080 }, viewport(360, 360), display)).not.toThrow();
    expect(() => cssToScreen({ x: 400, y: 10 }, webView, viewport(360, 776))).toThrow(/outside the visible viewport/);
    expect(() => cssToScreen({ x: -1, y: 10 }, webView, viewport(360, 776))).toThrow(/outside/);
  });

  it('plans swipes wholly inside the visible part of the target', () => {
    const vp = viewport(360, 776);
    const normal = planSwipe({ x: 20, y: 100, width: 320, height: 300 }, 'up', 120, vp);
    expect(normal.start).toEqual({ x: 180, y: 310 });
    expect(normal.end).toEqual({ x: 180, y: 190 });
    const clipped = planSwipe({ x: 20, y: 100, width: 320, height: 300 }, 'down', 5000, vp);
    expect(clipped.distance).toBe(292);
    const partlyOffscreen = planSwipe({ x: 20, y: 700, width: 320, height: 300 }, 'up', 120, vp);
    for (const point of [partlyOffscreen.start, partlyOffscreen.end]) expect(point.y).toBeGreaterThanOrEqual(700);
    for (const point of [partlyOffscreen.start, partlyOffscreen.end]) expect(point.y).toBeLessThanOrEqual(776);
    expect(() => planSwipe({ x: 20, y: 100, width: 320, height: 20 }, 'up', 120, vp)).toThrow(/too small/);
    expect(() => planSwipe({ x: 20, y: 900, width: 320, height: 100 }, 'up', 120, vp)).toThrow(/not visible/);
  });
});

describe('native tap and swipe', () => {
  const rect = { x: 20, y: 100, width: 320, height: 300 };

  it('sends an ADB tap at the mapped screen point after DOM hit testing', async () => {
    const { adb, cdp, run } = await device(appUi({ width: 1080, height: 2400, top: 72 }));
    cdp.pages[0].locate = () => ({ total: 1, visible: 1, measure: measure(rect, viewport(360, 776)) });
    expect(await tap(run, { role: 'button', name: '知ってる' }, true)).toEqual({ mode: 'native', screen: { x: 540, y: 72 + 250 * 3 } });
    expect(inputs(adb)).toEqual([['input', 'tap', '540', '822']]);
    expect(cdp.clicks).toEqual([]);
  });

  it('uses CDP mouse input for a DOM tap and no ADB input', async () => {
    const { adb, cdp, run } = await device(appUi({ width: 1080, height: 2400 }));
    cdp.pages[0].locate = () => ({ total: 1, visible: 1, measure: measure(rect, viewport(360, 776)) });
    expect(await tap(run, { css: '.flashcard-wrap' }, false)).toEqual({ mode: 'dom' });
    expect(cdp.clicks).toEqual([{ x: 180, y: 250 }]);
    expect(inputs(adb)).toEqual([]);
  });

  it('refuses a covered target, an ambiguous locator, and mismatched geometry before any input', async () => {
    const { adb, cdp, run } = await device(appUi({ width: 1080, height: 2400, top: 72 }));
    cdp.pages[0].locate = () => ({ total: 1, visible: 1, measure: measure(rect, viewport(360, 776), false) });
    await expect(tap(run, { css: '.x' }, true)).rejects.toThrow(/covered or clipped/);
    cdp.pages[0].locate = () => ({ total: 2, visible: 2, error: 'ambiguous: multiple visible matches' });
    await expect(tap(run, { role: 'button', name: 'OK' }, true)).rejects.toThrow(/ambiguous/);
    cdp.pages[0].locate = () => ({ total: 1, visible: 1, measure: measure(rect, viewport(360, 700)) });
    await expect(tap(run, { css: '.x' }, true)).rejects.toThrow(/ambiguous/);
    expect(inputs(adb)).toEqual([]);
  });

  it('refuses native input when the app is not the foreground window', async () => {
    const { adb, cdp, run } = await device(pickerUi());
    cdp.pages[0].locate = () => ({ total: 1, visible: 1, measure: measure(rect, viewport(360, 776)) });
    await expect(tap(run, { css: '.x' }, true)).rejects.toThrow(/foreground/);
    expect(inputs(adb)).toEqual([]);
  });

  it('swipes along a clipped, verified path in landscape', async () => {
    const { adb, cdp, run } = await device(appUi({ width: 2400, height: 1080, top: 0 }, 1));
    const vp = viewport(800, 360);
    cdp.pages[0].locate = (_locator, options) => ({
      total: 1,
      visible: 1,
      measure: measure(
        { x: 100, y: 50, width: 600, height: 200 },
        vp,
        true,
        options.points?.map(() => true)
      )
    });
    const report = await swipe(run, { css: '.flashcard-content' }, 'left', 2000, 350);
    expect(report.cssDistance).toBe(592);
    expect(inputs(adb)).toEqual([
      ['input', 'swipe', String(Math.round((400 + 296) * 3)), '450', String(Math.round((400 - 296) * 3)), '450', '350']
    ]);
  });

  it('refuses a swipe whose planned path leaves the target', async () => {
    const { adb, cdp, run } = await device(appUi({ width: 1080, height: 2400, top: 72 }));
    cdp.pages[0].locate = (_locator, options) => ({
      total: 1,
      visible: 1,
      measure: measure(
        rect,
        viewport(360, 776),
        true,
        options.points?.map((_, i) => i !== 2)
      )
    });
    await expect(swipe(run, { css: '.x' }, 'up', 120, 350)).rejects.toThrow(/not wholly over the target/);
    expect(inputs(adb)).toEqual([]);
  });
});

describe('expect', () => {
  it('passes as soon as the target is visible and fails (check, not error) after the bounded timeout', async () => {
    const { cdp, run } = await device(appUi({ width: 1080, height: 2400 }));
    let polls = 0;
    cdp.pages[0].countVisible = () => (++polls >= 3 ? 1 : 0);
    expect(await expectVisible(run, { text: '1 / 8' }, 5000)).toEqual({ passed: true, visible: 1 });
    cdp.pages[0].countVisible = () => 0;
    expect(await expectVisible(run, { css: '.never' }, 1000)).toEqual({ passed: false, visible: 0 });
    cdp.pages[0].countVisible = () => -1;
    await expect(expectVisible(run, { css: '[' }, 1000)).rejects.toThrow(/Invalid CSS/);
  });
});
