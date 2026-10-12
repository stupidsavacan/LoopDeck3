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

// --- observe probe (self-contained, serialized into the page) -----------------------

export interface ObservedDomElement {
  role: string | null;
  name: string;
  tag: string;
  enabled: boolean;
  /** Visible, enabled and of a kind a user can act on (button, link, form control, role=button...). */
  actionable: boolean;
  rect: { x: number; y: number; w: number; h: number };
  /** Role + accessible name as read here (an approximation). `unique` only says no other listed element has the same pair. */
  byRole: { role: string; name: string; unique: boolean } | null;
  /** Present only when this selector was checked to match exactly this one element in the document. */
  css: string | null;
}

export interface ObserveProbeResult {
  href: string;
  hash: string;
  title: string;
  elements: ObservedDomElement[];
  /** Visible elements that did not fit under `max`, and elements skipped because they are not visible. */
  truncated: number;
  hidden: number;
}

/** What `ldev observe` lists from the page: visible elements with a locator only where one was verified. */
export function observeProbe(arg: { max: number }): ObserveProbeResult {
  const normalize = (value: string | null | undefined): string => (value ?? '').replace(/\s+/g, ' ').trim();
  const roleOf = (element: Element): string | null => {
    const explicit = element.getAttribute('role');
    if (explicit) return explicit.split(/\s+/)[0];
    const tag = element.tagName.toLowerCase();
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'a') return 'link';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const type = (element.getAttribute('type') || 'text').toLowerCase();
      return type === 'checkbox' || type === 'radio' ? type : type === 'button' || type === 'submit' ? 'button' : 'textbox';
    }
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
  const escapeIdent = (value: string): string => value.replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`);
  const quote = (value: string): string => `"${value.replace(/["\\]/g, (char) => `\\${char}`)}"`;
  const only = (selector: string, element: Element): boolean => {
    try {
      const found = document.querySelectorAll(selector);
      return found.length === 1 && found[0] === element;
    } catch {
      return false;
    }
  };
  const cssFor = (element: Element): string | null => {
    const tag = element.tagName.toLowerCase();
    const candidates: string[] = [];
    const id = element.getAttribute('id');
    if (id && /^[A-Za-z][A-Za-z0-9_-]*$/.test(id)) candidates.push(`#${escapeIdent(id)}`);
    const testId = element.getAttribute('data-testid');
    if (testId) candidates.push(`[data-testid=${quote(testId)}]`);
    const label = element.getAttribute('aria-label');
    if (label) candidates.push(`${tag}[aria-label=${quote(label)}]`);
    const classes = Array.from(element.classList).filter((name) => /^[A-Za-z_-][A-Za-z0-9_-]*$/.test(name));
    for (const name of classes) candidates.push(`${tag}.${escapeIdent(name)}`);
    if (classes.length > 1) candidates.push(`${tag}${classes.slice(0, 3).map((name) => `.${escapeIdent(name)}`).join('')}`);
    return candidates.find((candidate) => only(candidate, element)) ?? null;
  };
  const actionableRoles = new Set(['button', 'link', 'checkbox', 'radio', 'textbox', 'combobox', 'switch', 'tab', 'menuitem', 'option', 'slider']);

  const all = Array.from(document.querySelectorAll('button,a[href],input,select,textarea,summary,[role],[data-testid],h1,h2,h3,h4,h5,h6'));
  const visible = all.filter(isVisible);
  const listed = visible.slice(0, arg.max);
  const items = listed.map((element) => {
    const rect = element.getBoundingClientRect();
    const role = roleOf(element);
    const name = normalize(element.getAttribute('aria-label') || element.textContent || element.getAttribute('title'));
    const enabled = !(element as HTMLButtonElement).disabled && element.getAttribute('aria-disabled') !== 'true';
    return {
      role,
      name: name.length > 120 ? `${name.slice(0, 119)}…` : name,
      tag: element.tagName.toLowerCase(),
      enabled,
      actionable: enabled && role !== null && actionableRoles.has(role),
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
      css: cssFor(element),
      full: name
    };
  });
  const elements: ObservedDomElement[] = items.map((item) => {
    const same = items.filter((other) => other.role === item.role && other.full === item.full).length;
    const { full, ...rest } = item;
    return { ...rest, byRole: item.role && full ? { role: item.role, name: item.name, unique: same === 1 } : null };
  });
  return {
    href: window.location.href,
    hash: window.location.hash,
    title: document.title,
    elements,
    truncated: visible.length - listed.length,
    hidden: all.length - visible.length
  };
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

export interface LocalStorageKeys {
  ok: boolean;
  keys: string[];
}

/** Key names only (never values) of this origin's localStorage. */
export function readLocalStorageKeys(): LocalStorageKeys {
  try {
    const keys: string[] = [];
    for (let index = 0; index < window.localStorage.length; index++) {
      const key = window.localStorage.key(index);
      if (key !== null) keys.push(key);
    }
    return { ok: true, keys: keys.sort() };
  } catch {
    return { ok: false, keys: [] };
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
