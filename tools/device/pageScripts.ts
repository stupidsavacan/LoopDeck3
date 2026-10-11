/**
 * Functions in this file are serialized into the page by Playwright (Function#toString),
 * so each one must be fully self-contained: no imports, no references to module scope.
 * They are exercised in jsdom by tests/deviceUi.test.ts.
 *
 * Semantic target resolution (getByRole / getByText / CSS) is NOT done here: it uses
 * Playwright's own locators in playwrightConnector.ts. These scripts only measure.
 */
import type { CssRect, Point, ViewportInfo } from './geometry.js';

/** Role + exact accessible name (Playwright getByRole), or a CSS selector. */
export type Locator = { role: string; name: string } | { css: string };

export type ProbeArg = { mode: 'viewport' } | { mode: 'snapshot'; max: number };

export interface DomItem {
  role: string | null;
  name: string;
  tag: string;
  visible: boolean;
  rect: { x: number; y: number; w: number; h: number };
}

export type ProbeResult =
  | { mode: 'viewport'; viewport: ViewportInfo; href: string }
  | { mode: 'snapshot'; items: DomItem[]; truncated: boolean; viewport: ViewportInfo; href: string };

export interface ElementMeasure {
  rect: CssRect;
  /** Centre of the part of the element inside the visual viewport; null when none is visible. */
  point: Point | null;
  hit: boolean;
  pointHits?: boolean[];
  viewport: ViewportInfo;
}

/** Measures one resolved element: viewport facts, visible centre, and elementFromPoint hit tests. */
export function elementProbe(element: Element, arg: { points?: Point[] }): ElementMeasure {
  const vv = window.visualViewport;
  const viewport: ViewportInfo = {
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    dpr: window.devicePixelRatio,
    visualViewport: {
      offsetLeft: vv ? vv.offsetLeft : 0,
      offsetTop: vv ? vv.offsetTop : 0,
      width: vv ? vv.width : window.innerWidth,
      height: vv ? vv.height : window.innerHeight,
      scale: vv ? vv.scale : 1
    }
  };
  const box = element.getBoundingClientRect();
  const rect: CssRect = { x: box.x, y: box.y, width: box.width, height: box.height };
  const v = viewport.visualViewport;
  const left = Math.max(rect.x, v.offsetLeft);
  const top = Math.max(rect.y, v.offsetTop);
  const right = Math.min(rect.x + rect.width, v.offsetLeft + v.width);
  const bottom = Math.min(rect.y + rect.height, v.offsetTop + v.height);
  const hits = (at: Point): boolean => {
    const found = document.elementFromPoint(at.x, at.y);
    return found !== null && (found === element || element.contains(found));
  };
  if (right <= left || bottom <= top) return { rect, point: null, hit: false, viewport };
  const point = { x: (left + right) / 2, y: (top + bottom) / 2 };
  return { rect, point, hit: hits(point), pointHits: arg.points ? arg.points.map(hits) : undefined, viewport };
}

/**
 * Compact DOM listing for `inspect`. Roles and names here are an approximation for reading
 * only; actions never depend on them (they use Playwright locators).
 */
export function domProbe(arg: ProbeArg): ProbeResult {
  const normalize = (value: string | null | undefined): string => (value ?? '').replace(/\s+/g, ' ').trim();
  const vv = window.visualViewport;
  const viewport: ViewportInfo = {
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    dpr: window.devicePixelRatio,
    visualViewport: {
      offsetLeft: vv ? vv.offsetLeft : 0,
      offsetTop: vv ? vv.offsetTop : 0,
      width: vv ? vv.width : window.innerWidth,
      height: vv ? vv.height : window.innerHeight,
      scale: vv ? vv.scale : 1
    }
  };
  if (arg.mode === 'viewport') return { mode: 'viewport', viewport, href: window.location.href };

  const roleOf = (element: Element): string | null => {
    const explicit = element.getAttribute('role');
    if (explicit) return explicit.split(/\s+/)[0];
    const tag = element.tagName.toLowerCase();
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'a') return 'link';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') return (element.getAttribute('type') || 'text').toLowerCase();
    return null;
  };
  const isVisible = (element: Element): boolean => {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    for (let node: Element | null = element; node; node = node.parentElement) {
      const style = window.getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || (style.opacity !== '' && Number(style.opacity) === 0)) return false;
    }
    return true;
  };
  const all = Array.from(document.querySelectorAll('button,a[href],input,select,textarea,summary,[role],h1,h2,h3,h4,h5,h6'));
  const items: DomItem[] = all.slice(0, arg.max).map((element) => {
    const rect = element.getBoundingClientRect();
    return {
      role: roleOf(element),
      name: normalize(element.getAttribute('aria-label') || element.textContent || element.getAttribute('title')),
      tag: element.tagName.toLowerCase(),
      visible: isVisible(element),
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) }
    };
  });
  return { mode: 'snapshot', items, truncated: all.length > arg.max, viewport, href: window.location.href };
}

// --- run scenario helpers (self-contained, serialized into the page) ---------------

export interface DiagnosticsRead {
  ok: boolean;
  entries: { id: string; level: string; code: string | null; area: string }[];
}

/** Reads the app's persisted diagnostics log (localStorage `loopdeck3.diagnostics`). */
export function readDiagnostics(): DiagnosticsRead {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem('loopdeck3.diagnostics');
  } catch {
    return { ok: false, entries: [] };
  }
  if (raw === null) return { ok: true, entries: [] };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return { ok: false, entries: [] };
    const entries = parsed
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      .map((item) => ({
        id: String(item.id ?? ''),
        level: String(item.level ?? ''),
        code: typeof item.code === 'string' ? item.code : null,
        area: String(item.area ?? '')
      }));
    return { ok: true, entries };
  } catch {
    return { ok: false, entries: [] };
  }
}

export function errorScreenPresent(): boolean {
  return document.querySelector('.startup-error-screen') !== null;
}

export function navigateHash(route: string): void {
  window.location.hash = route;
}

/** Throws an uncaught error from a timer so it surfaces as a pageerror. */
export function throwInPage(message: string): void {
  setTimeout(() => {
    throw new Error(message);
  }, 0);
}
