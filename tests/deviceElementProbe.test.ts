// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { domProbe, elementProbe } from '../tools/device/pageScripts';

function place(element: Element, x: number, y: number, width: number, height: number): void {
  element.getBoundingClientRect = () =>
    ({ x, y, width, height, left: x, top: y, right: x + width, bottom: y + height, toJSON: () => ({}) }) as DOMRect;
}

let hitTarget: Element | null = null;

beforeEach(() => {
  document.body.innerHTML =
    '<div id="wrap"><button id="ok" aria-label="OK"><span id="inner">OK</span></button><button id="hidden" style="display:none">Hidden</button><p id="cover">cover</p></div>';
  Object.defineProperty(window, 'innerWidth', { value: 360, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: 776, configurable: true });
  Object.defineProperty(window, 'devicePixelRatio', { value: 3, configurable: true });
  (document as unknown as { elementFromPoint: () => Element | null }).elementFromPoint = () => hitTarget;
});

afterEach(() => {
  hitTarget = null;
});

describe('elementProbe', () => {
  it('reports the visible centre, viewport facts, and a descendant hit as a hit', () => {
    const button = document.getElementById('ok')!;
    place(button, 20, 100, 320, 300);
    hitTarget = document.getElementById('inner');
    const measure = elementProbe(button, { points: [{ x: 30, y: 110 }] });
    expect(measure.point).toEqual({ x: 180, y: 250 });
    expect(measure.hit).toBe(true);
    expect(measure.pointHits).toEqual([true]);
    expect(measure.viewport).toMatchObject({ innerWidth: 360, innerHeight: 776, dpr: 3, visualViewport: { scale: 1, offsetLeft: 0 } });
  });

  it('reports a covered element as not hit', () => {
    const button = document.getElementById('ok')!;
    place(button, 20, 100, 320, 300);
    hitTarget = document.getElementById('cover');
    expect(elementProbe(button, { points: [{ x: 1, y: 1 }] })).toMatchObject({ hit: false, pointHits: [false] });
  });

  it('centres on the visible part of a partly off-screen element and returns no point when fully off-screen', () => {
    const button = document.getElementById('ok')!;
    place(button, 20, 700, 320, 300);
    hitTarget = button;
    expect(elementProbe(button, {}).point).toEqual({ x: 180, y: 738 });
    place(button, 20, 900, 320, 300);
    expect(elementProbe(button, {})).toMatchObject({ point: null, hit: false });
  });
});

describe('domProbe', () => {
  it('lists controls for reading, marking hidden ones, with a bound', () => {
    place(document.getElementById('ok')!, 0, 0, 10, 10);
    place(document.getElementById('hidden')!, 0, 0, 10, 10);
    const result = domProbe({ mode: 'snapshot', max: 5 });
    if (result.mode !== 'snapshot') throw new Error('unexpected mode');
    expect(result.items.map((item) => [item.role, item.name, item.visible])).toEqual([
      ['button', 'OK', true],
      ['button', 'Hidden', false]
    ]);
    const limited = domProbe({ mode: 'snapshot', max: 1 });
    expect(limited.mode === 'snapshot' && limited.truncated).toBe(true);
  });
});
