import { DeviceCliError } from './errors.js';
import { rectHeight, rectWidth, type Rect } from './ui.js';

/** DOM-side numbers (CSS pixels) captured at the moment of the gesture. */
export interface ViewportInfo {
  innerWidth: number;
  innerHeight: number;
  dpr: number;
  visualViewport: { offsetLeft: number; offsetTop: number; width: number; height: number; scale: number };
}

export interface CssRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

const refuse = (message: string) => new DeviceCliError('GEOMETRY', `Refusing native input: ${message}`);

/**
 * The only supported mapping is the exact one: a WebView whose pixel bounds equal the
 * visual viewport times devicePixelRatio, at scale 1. Anything else (pinch zoom,
 * partially off-screen WebView, split screen, an unexplained inset) is ambiguous and refused.
 */
export function validateGeometry(webView: Rect, viewport: ViewportInfo, display: Rect): void {
  const { dpr, visualViewport: vv } = viewport;
  if (!Number.isFinite(dpr) || dpr < 0.5 || dpr > 8) throw refuse(`devicePixelRatio ${dpr} is not plausible`);
  if (Math.abs(vv.scale - 1) > 0.01) throw refuse(`visual viewport scale is ${vv.scale}, not 1`);
  if (Math.abs(vv.width - viewport.innerWidth) > 1 || Math.abs(vv.height - viewport.innerHeight) > 1) {
    throw refuse('visual viewport differs from the layout viewport (scrollbar or keyboard inset)');
  }
  const tolerance = Math.max(2, Math.ceil(dpr));
  const widthPx = rectWidth(webView);
  const heightPx = rectHeight(webView);
  if (Math.abs(widthPx - vv.width * dpr) > tolerance || Math.abs(heightPx - vv.height * dpr) > tolerance) {
    throw refuse(
      `WebView is ${widthPx}x${heightPx}px but the DOM viewport is ${vv.width}x${vv.height} CSS px at dpr ${dpr}; scale or offset is ambiguous`
    );
  }
  if (widthPx > heightPx !== viewport.innerWidth > viewport.innerHeight) throw refuse('WebView and DOM disagree about orientation');
  if (webView.left < display.left || webView.top < display.top || webView.right > display.right || webView.bottom > display.bottom) {
    throw refuse('WebView extends outside the display');
  }
}

/** Layout-viewport CSS point (as from getBoundingClientRect) to absolute screen pixels. */
export function cssToScreen(point: Point, webView: Rect, viewport: ViewportInfo): Point {
  const { dpr, visualViewport: vv } = viewport;
  const inViewX = point.x - vv.offsetLeft;
  const inViewY = point.y - vv.offsetTop;
  if (inViewX < 0 || inViewY < 0 || inViewX > vv.width || inViewY > vv.height) {
    throw refuse(`point (${point.x}, ${point.y}) is outside the visible viewport`);
  }
  const x = Math.round(webView.left + inViewX * dpr);
  const y = Math.round(webView.top + inViewY * dpr);
  if (x < webView.left || x >= webView.right || y < webView.top || y >= webView.bottom)
    throw refuse('mapped point falls outside the WebView bounds');
  return { x, y };
}

export function intersectCss(rect: CssRect, viewport: ViewportInfo): CssRect | null {
  const vv = viewport.visualViewport;
  const left = Math.max(rect.x, vv.offsetLeft);
  const top = Math.max(rect.y, vv.offsetTop);
  const right = Math.min(rect.x + rect.width, vv.offsetLeft + vv.width);
  const bottom = Math.min(rect.y + rect.height, vv.offsetTop + vv.height);
  return right > left && bottom > top ? { x: left, y: top, width: right - left, height: bottom - top } : null;
}

export function centerOf(rect: CssRect): Point {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

export type Direction = 'up' | 'down' | 'left' | 'right';

const SWIPE_MARGIN = 4;
const SWIPE_MIN_EXTENT = 24;

/**
 * Plans a swipe wholly inside the visible part of the target. The path is centred on the
 * visible rectangle's centre and its length is clipped to the usable extent.
 * "up" means the finger moves up (content scrolls down).
 */
export function planSwipe(
  target: CssRect,
  direction: Direction,
  requestedCssDistance: number,
  viewport: ViewportInfo
): { start: Point; end: Point; distance: number } {
  const visible = intersectCss(target, viewport);
  if (!visible) throw refuse('target is not visible in the viewport');
  const vertical = direction === 'up' || direction === 'down';
  const extent = (vertical ? visible.height : visible.width) - 2 * SWIPE_MARGIN;
  if (extent < SWIPE_MIN_EXTENT) throw refuse(`visible target extent (${Math.max(0, Math.floor(extent))} CSS px) is too small to swipe`);
  const distance = Math.min(requestedCssDistance, extent);
  const center = centerOf(visible);
  const sign = direction === 'up' || direction === 'left' ? -1 : 1;
  const half = distance / 2;
  return vertical
    ? { start: { x: center.x, y: center.y - sign * half }, end: { x: center.x, y: center.y + sign * half }, distance }
    : { start: { x: center.x - sign * half, y: center.y }, end: { x: center.x + sign * half, y: center.y }, distance };
}
