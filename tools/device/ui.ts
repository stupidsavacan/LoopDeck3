import { createRequire } from 'node:module';
import { APP_PACKAGE, DOCUMENTS_UI_PACKAGES, LIMITS, TIMEOUTS, WEBVIEW_CLASS } from './constants.js';
import { DeviceCliError } from './errors.js';

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface UiNode {
  depth: number;
  cls: string;
  pkg: string;
  text: string;
  resourceId: string;
  contentDesc: string;
  bounds: Rect | null;
  clickable: boolean;
  enabled: boolean;
}

export interface UiSnapshot {
  rotation: number | null;
  nodes: UiNode[];
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const rectWidth = (rect: Rect): number => rect.right - rect.left;
export const rectHeight = (rect: Rect): number => rect.bottom - rect.top;

/** uiautomator had no window to dump yet (e.g. mid-transition). Retryable. */
export class UiNotReadyError extends DeviceCliError {
  constructor(message: string) {
    super('UI', message);
  }
}

function parseBounds(value: string | null): Rect | null {
  const match = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(value ?? '');
  if (!match) return null;
  return { left: Number(match[1]), top: Number(match[2]), right: Number(match[3]), bottom: Number(match[4]) };
}

interface XmlElement {
  tagName: string;
  children: ArrayLike<XmlElement>;
  getAttribute(name: string): string | null;
}

/**
 * Parses uiautomator XML. jsdom is already a dev dependency and only runs in Node;
 * attribute values are read as data and never interpolated into commands or markup.
 */
export function parseUiDump(raw: string): UiSnapshot {
  const start = raw.indexOf('<?xml');
  const end = raw.lastIndexOf('</hierarchy>');
  if (/null root node/i.test(raw) || start < 0 || end < 0) throw new UiNotReadyError('uiautomator returned no hierarchy (null root node)');
  const xml = raw.slice(start, end + '</hierarchy>'.length);
  const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
    JSDOM: new (source: string, options: { contentType: string }) => { window: { document: { documentElement: XmlElement } } };
  };
  const root = new JSDOM(xml, { contentType: 'text/xml' }).window.document.documentElement;
  if (root.tagName !== 'hierarchy') throw new UiNotReadyError('uiautomator output has no hierarchy root');
  const rotation = Number.parseInt(root.getAttribute('rotation') ?? '', 10);
  const nodes: UiNode[] = [];
  const walk = (element: XmlElement, depth: number): void => {
    for (const child of Array.from(element.children)) {
      if (child.tagName !== 'node') continue;
      if (nodes.length >= LIMITS.maxUiNodes) throw new DeviceCliError('UI', `UI hierarchy exceeds ${LIMITS.maxUiNodes} nodes`);
      nodes.push({
        depth,
        cls: child.getAttribute('class') ?? '',
        pkg: child.getAttribute('package') ?? '',
        text: child.getAttribute('text') ?? '',
        resourceId: child.getAttribute('resource-id') ?? '',
        contentDesc: child.getAttribute('content-desc') ?? '',
        bounds: parseBounds(child.getAttribute('bounds')),
        clickable: child.getAttribute('clickable') === 'true',
        enabled: child.getAttribute('enabled') !== 'false'
      });
      walk(child, depth + 1);
    }
  };
  walk(root, 0);
  if (nodes.length === 0) throw new UiNotReadyError('uiautomator hierarchy is empty');
  return { rotation: Number.isNaN(rotation) ? null : rotation, nodes };
}

/** Bounded retry for a null/empty UI root, with short growing backoff instead of one long sleep. */
export async function captureUi(dump: () => Promise<string>, clock: Clock, attempts = 6): Promise<UiSnapshot> {
  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return parseUiDump(await dump());
    } catch (error) {
      if (!(error instanceof UiNotReadyError)) throw error;
      last = error;
      if (attempt < attempts) await clock.sleep(Math.min(100 * attempt, 500));
    }
  }
  throw new DeviceCliError('UI', `UI hierarchy was not available after ${attempts} attempts: ${(last as Error).message}`);
}

/** Polls `read` until `ready` accepts the result or the bounded deadline passes. */
export async function waitFor<T>(
  clock: Clock,
  read: () => Promise<T>,
  ready: (value: T) => boolean,
  what: string,
  timeoutMs: number = TIMEOUTS.uiReadyMs,
  pollMs: number = TIMEOUTS.uiPollMs
): Promise<T> {
  const deadline = clock.now() + timeoutMs;
  for (;;) {
    let failure: unknown = null;
    try {
      const value = await read();
      if (ready(value)) return value;
    } catch (error) {
      if (!(error instanceof DeviceCliError) || error.code === 'IDENTITY' || error.code === 'TIMEOUT') throw error;
      failure = error;
    }
    if (clock.now() + pollMs > deadline) {
      throw new DeviceCliError(
        'TIMEOUT',
        `Timed out after ${timeoutMs} ms waiting for ${what}${failure ? `: ${(failure as Error).message}` : ''}`
      );
    }
    await clock.sleep(pollMs);
  }
}

export function topLevelPackages(snapshot: UiSnapshot): string[] {
  return [...new Set(snapshot.nodes.filter((node) => node.depth === 0).map((node) => node.pkg))];
}

export function displayBounds(snapshot: UiSnapshot): Rect {
  const roots = snapshot.nodes.filter((node) => node.depth === 0 && node.bounds);
  if (roots.length === 0) throw new DeviceCliError('UI', 'UI hierarchy has no root bounds');
  return {
    left: Math.min(...roots.map((node) => node.bounds!.left)),
    top: Math.min(...roots.map((node) => node.bounds!.top)),
    right: Math.max(...roots.map((node) => node.bounds!.right)),
    bottom: Math.max(...roots.map((node) => node.bounds!.bottom))
  };
}

export function isLandscape(snapshot: UiSnapshot): boolean {
  const bounds = displayBounds(snapshot);
  return rectWidth(bounds) > rectHeight(bounds);
}

export function requireAppForeground(snapshot: UiSnapshot): void {
  const packages = topLevelPackages(snapshot);
  if (packages.length !== 1 || packages[0] !== APP_PACKAGE) {
    throw new DeviceCliError('UI', `The debug app is not the foreground window (foreground: ${packages.join(', ') || 'none'})`);
  }
}

/** One physical WebView; Android may repeat it as a nested virtual accessibility root. */
export function findAppWebView(snapshot: UiSnapshot): Rect {
  const views: UiNode[] = [];
  const ancestors: UiNode[] = [];
  for (const node of snapshot.nodes) {
    ancestors.length = node.depth;
    if (node.cls === WEBVIEW_CLASS && node.pkg === APP_PACKAGE && node.bounds) {
      const parent = [...ancestors]
        .reverse()
        .find((ancestor) => ancestor.cls === WEBVIEW_CLASS && ancestor.pkg === APP_PACKAGE && ancestor.bounds);
      // Only collapse an actual ancestor with equivalent bounds (1px rounding).
      // Distinct siblings and differently sized nested WebViews remain ambiguous.
      const same =
        parent?.bounds &&
        Object.keys(node.bounds).every((key) => Math.abs(node.bounds![key as keyof Rect] - parent.bounds![key as keyof Rect]) <= 1);
      if (!same) views.push(node);
    }
    ancestors[node.depth] = node;
  }
  if (views.length !== 1) throw new DeviceCliError('UI', `Expected exactly one app WebView in the UI hierarchy, found ${views.length}`);
  const bounds = views[0].bounds!;
  if (rectWidth(bounds) <= 0 || rectHeight(bounds) <= 0) throw new DeviceCliError('UI', 'App WebView has empty bounds');
  return bounds;
}

export function isAppReady(snapshot: UiSnapshot): boolean {
  try {
    requireAppForeground(snapshot);
    findAppWebView(snapshot);
    return true;
  } catch {
    return false;
  }
}

export interface PickerTarget {
  text?: string;
  resourceId?: string;
}

/** DocumentsUI only; exact text OR exact resource-id; exactly one match. Returns the node center. */
export function findPickerNode(snapshot: UiSnapshot, target: PickerTarget): { x: number; y: number } {
  if ((target.text === undefined) === (target.resourceId === undefined)) {
    throw new DeviceCliError('USAGE', 'Provide exactly one of --text or --resource-id');
  }
  const packages = topLevelPackages(snapshot);
  if (packages.length !== 1 || !DOCUMENTS_UI_PACKAGES.includes(packages[0])) {
    throw new DeviceCliError('UI', 'The Android document picker (DocumentsUI) is not the foreground window');
  }
  const matches = snapshot.nodes.filter(
    (node) =>
      DOCUMENTS_UI_PACKAGES.includes(node.pkg) &&
      node.bounds &&
      (target.text !== undefined ? node.text === target.text : node.resourceId === target.resourceId)
  );
  if (matches.length !== 1) throw new DeviceCliError('UI', `Expected exactly one matching picker element, found ${matches.length}`);
  const bounds = matches[0].bounds!;
  if (rectWidth(bounds) <= 0 || rectHeight(bounds) <= 0) throw new DeviceCliError('UI', 'Picker element has empty bounds');
  return { x: Math.round((bounds.left + bounds.right) / 2), y: Math.round((bounds.top + bounds.bottom) / 2) };
}
