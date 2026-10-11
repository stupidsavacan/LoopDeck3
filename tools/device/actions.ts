import { atomicWriteFile } from './session.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DOCUMENTS_UI_PACKAGES, LIMITS, TIMEOUTS } from './constants.js';
import { DeviceCliError } from './errors.js';
import { cssToScreen, planSwipe, validateGeometry, type CssRect, type Direction, type Point, type ViewportInfo } from './geometry.js';
import type { DomItem, Locator, ProbeResult } from './pageScripts.js';
import type { DeviceRun } from './runtime.js';
import {
  captureUi,
  displayBounds,
  findAppWebView,
  findPickerNode,
  requireAppForeground,
  topLevelPackages,
  waitFor,
  type PickerTarget,
  type UiSnapshot
} from './ui.js';
import { probe, withWebView, type CdpPage, type ExpectTarget } from './webview.js';

export const uiSnapshot = (run: DeviceRun): Promise<UiSnapshot> => captureUi(() => run.device.uiDumpRaw(), run.deps.clock);

interface Located {
  rect: CssRect;
  point: Point;
  hit: boolean;
  pointHits?: boolean[];
  viewport: ViewportInfo;
}

/** Strict Playwright resolution to exactly one visible element, then measurement. */
async function locate(page: CdpPage, locator: Locator, points?: Point[]): Promise<Located> {
  const result = await page.locate(locator, { scroll: true, points });
  const measure = result.measure;
  if (result.error || !measure || !measure.point) {
    throw new DeviceCliError(
      'WEBVIEW',
      `Locator did not resolve to one actionable element: ${result.error ?? 'unknown'} (${result.visible} visible of ${result.total} matching)`
    );
  }
  return { rect: measure.rect, point: measure.point, hit: measure.hit, pointHits: measure.pointHits, viewport: measure.viewport };
}

/** UI WebView bounds + DOM viewport, validated to be an exact, unambiguous mapping. */
async function nativeGeometry(run: DeviceRun, viewport: ViewportInfo) {
  const snapshot = await uiSnapshot(run);
  requireAppForeground(snapshot);
  const webView = findAppWebView(snapshot);
  validateGeometry(webView, viewport, displayBounds(snapshot));
  return webView;
}

export interface AttachReport {
  pid: number;
  previousPid: number | null;
  pidChanged: boolean;
  page: string;
  viewport: ViewportInfo;
  userAgentPresent: boolean;
}

/** Capability probe: connects, reads viewport facts, disconnects. Nothing is changed in the app. */
export function attachProbe(run: DeviceRun): Promise<AttachReport> {
  return withWebView(run, async ({ page, pid, previousPid }) => {
    const result = (await probe(page, { mode: 'viewport' })) as Extract<ProbeResult, { mode: 'viewport' }>;
    const url = new URL(page.url());
    return {
      pid,
      previousPid,
      pidChanged: previousPid !== null && previousPid !== pid,
      page: `${url.origin}${url.pathname}`,
      viewport: result.viewport,
      userAgentPresent: true
    };
  });
}

export interface TapReport {
  mode: 'dom' | 'native';
  screen?: Point;
}

export const tap = (run: DeviceRun, locator: Locator, native: boolean): Promise<TapReport> =>
  withWebView(run, ({ page }) => tapOn(run, page, locator, native));

export async function tapOn(run: DeviceRun, page: CdpPage, locator: Locator, native: boolean): Promise<TapReport> {
  const target = await locate(page, locator);
  if (!target.hit)
    throw new DeviceCliError('GEOMETRY', 'Refusing tap: elementFromPoint at the target centre is not the target (covered or clipped)');
  if (!native) {
    await page.mouseClick(target.point.x, target.point.y);
    return { mode: 'dom' };
  }
  const webView = await nativeGeometry(run, target.viewport);
  const screen = cssToScreen(target.point, webView, target.viewport);
  await run.device.tap(screen.x, screen.y);
  return { mode: 'native', screen };
}

export interface SwipeReport {
  start: Point;
  end: Point;
  cssDistance: number;
}

export const swipe = (
  run: DeviceRun,
  locator: Locator,
  direction: Direction,
  requestedCssDistance: number,
  durationMs: number
): Promise<SwipeReport> => withWebView(run, ({ page }) => swipeOn(run, page, locator, direction, requestedCssDistance, durationMs));

export async function swipeOn(
  run: DeviceRun,
  page: CdpPage,
  locator: Locator,
  direction: Direction,
  requestedCssDistance: number,
  durationMs: number
): Promise<SwipeReport> {
  const target = await locate(page, locator);
  const plan = planSwipe(target.rect, direction, requestedCssDistance, target.viewport);
  const path = Array.from({ length: 5 }, (_, index) => ({
    x: plan.start.x + ((plan.end.x - plan.start.x) * index) / 4,
    y: plan.start.y + ((plan.end.y - plan.start.y) * index) / 4
  }));
  const verified = await locate(page, locator, path);
  if (!verified.pointHits || !verified.pointHits.every(Boolean)) {
    throw new DeviceCliError('GEOMETRY', 'Refusing swipe: the planned path is not wholly over the target element');
  }
  const webView = await nativeGeometry(run, verified.viewport);
  const start = cssToScreen(plan.start, webView, verified.viewport);
  const end = cssToScreen(plan.end, webView, verified.viewport);
  await run.device.swipe(start.x, start.y, end.x, end.y, durationMs);
  return { start, end, cssDistance: plan.distance };
}

export interface ExpectReport {
  passed: boolean;
  visible: number;
}

/** Polls (bounded) for exact visible text or a CSS locator. Failure is a check failure, not an infrastructure error. */
export const expectVisible = (run: DeviceRun, target: ExpectTarget, timeoutMs: number): Promise<ExpectReport> =>
  withWebView(run, ({ page }) => expectVisibleOn(run, page, target, timeoutMs));

export async function expectVisibleOn(run: DeviceRun, page: CdpPage, target: ExpectTarget, timeoutMs: number): Promise<ExpectReport> {
  try {
    const visible = await waitFor(
      run.deps.clock,
      () => page.countVisible(target),
      (count) => count === -1 || count > 0,
      'expected element',
      timeoutMs,
      TIMEOUTS.uiPollMs
    );
    if (visible === -1) throw new DeviceCliError('USAGE', 'Invalid CSS selector');
    return { passed: true, visible };
  } catch (error) {
    if (error instanceof DeviceCliError && error.code === 'TIMEOUT') return { passed: false, visible: 0 };
    throw error;
  }
}

// --- inspect -----------------------------------------------------------------

export interface InspectOptions {
  dom: boolean;
  ui: boolean;
  compact: boolean;
  diff: boolean;
}

export interface InspectReport {
  dom?: { lines: string[]; truncated: boolean };
  ui?: { lines: string[]; foreground: string[] };
  diff?: { added: string[]; removed: string[]; previous: boolean };
}

const clip = (value: string, max: number): string => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

export function domLines(items: DomItem[], compact: boolean): string[] {
  return items
    .filter((item) => !compact || item.visible)
    .map((item) =>
      compact
        ? `${item.role ?? item.tag}|${clip(item.name, 60)}`
        : `${item.role ?? '-'}|${item.name}|${item.tag}|${item.visible ? 'visible' : 'hidden'}|${item.rect.x},${item.rect.y} ${item.rect.w}x${item.rect.h}`
    );
}

export function uiLines(snapshot: UiSnapshot, compact: boolean): string[] {
  return snapshot.nodes
    .filter((node) => !compact || node.text || node.contentDesc || node.resourceId || node.clickable)
    .map((node) => {
      const b = node.bounds;
      const where = b ? `[${b.left},${b.top}][${b.right},${b.bottom}]` : '[]';
      return compact
        ? `${node.cls.split('.').pop()}|${node.resourceId}|${clip(node.text, 60)}`
        : `${node.pkg}|${node.cls}|${node.resourceId}|${node.text}|${node.contentDesc}|${where}`;
    });
}

function multisetDiff(before: string[], after: string[]): { added: string[]; removed: string[] } {
  const count = (lines: string[]) => lines.reduce((map, line) => map.set(line, (map.get(line) ?? 0) + 1), new Map<string, number>());
  const a = count(before);
  const b = count(after);
  const added: string[] = [];
  const removed: string[] = [];
  for (const [line, n] of b) for (let i = 0; i < n - (a.get(line) ?? 0); i++) added.push(line);
  for (const [line, n] of a) for (let i = 0; i < n - (b.get(line) ?? 0); i++) removed.push(line);
  return { added: added.slice(0, 100), removed: removed.slice(0, 100) };
}

/** Last inspect lines live beside the session (ignored qa-results); they hold device text and are never summarized. */
export async function inspect(run: DeviceRun, options: InspectOptions): Promise<InspectReport> {
  const report: InspectReport = {};
  const snapshotFile = join(run.session.paths.root, 'inspect-last.json');
  let previous: { dom?: string[]; ui?: string[] } | null = null;
  try {
    previous = JSON.parse(readFileSync(snapshotFile, 'utf8')) as { dom?: string[]; ui?: string[] };
  } catch {
    previous = null;
  }
  if (options.dom) {
    const { items, truncated } = await withWebView(run, async ({ page }) => {
      const result = (await probe(page, { mode: 'snapshot', max: LIMITS.maxDomItems })) as Extract<ProbeResult, { mode: 'snapshot' }>;
      return { items: result.items, truncated: result.truncated };
    });
    report.dom = { lines: domLines(items, options.compact), truncated };
  }
  if (options.ui) {
    const snapshot = await uiSnapshot(run);
    report.ui = { lines: uiLines(snapshot, options.compact), foreground: topLevelPackages(snapshot) };
  }
  if (options.diff) {
    const before = [...(previous?.dom ?? []), ...(previous?.ui ?? [])];
    const after = [...(report.dom?.lines ?? []), ...(report.ui?.lines ?? [])];
    report.diff = { ...multisetDiff(before, after), previous: previous !== null };
  }
  atomicWriteFile(snapshotFile, JSON.stringify({ dom: report.dom?.lines ?? [], ui: report.ui?.lines ?? [] }));
  return report;
}

// --- picker / keys -------------------------------------------------------------

export async function pickerInspect(
  run: DeviceRun
): Promise<{ foreground: string[]; elements: { text: string; resourceId: string; clickable: boolean }[] }> {
  const snapshot = await uiSnapshot(run);
  const foreground = topLevelPackages(snapshot);
  if (foreground.length !== 1 || !DOCUMENTS_UI_PACKAGES.includes(foreground[0])) {
    throw new DeviceCliError('UI', 'The Android document picker (DocumentsUI) is not the foreground window');
  }
  const elements = snapshot.nodes
    .filter((node) => node.text || node.resourceId)
    .slice(0, 200)
    .map((node) => ({ text: node.text, resourceId: node.resourceId, clickable: node.clickable }));
  return { foreground, elements };
}

export async function pickerSelect(run: DeviceRun, target: PickerTarget): Promise<Point> {
  const point = findPickerNode(await uiSnapshot(run), target);
  await run.device.tap(point.x, point.y);
  return point;
}
