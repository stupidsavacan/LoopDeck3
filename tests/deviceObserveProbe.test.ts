// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { observeProbe } from '../tools/device/pageScripts';

beforeEach(() => {
  document.title = 'LoopDeck';
  window.location.hash = '#home';
  document.body.innerHTML = [
    '<h1>Home</h1>',
    '<button id="start">Start</button>',
    '<button class="row">Open</button><button class="row">Open</button>',
    '<button aria-label="Close" class="x">x</button>',
    '<button disabled class="off">Off</button>',
    '<button style="display:none" id="gone">Gone</button>'
  ].join('');
  // jsdom has no layout: give every element a box
  for (const element of Array.from(document.body.querySelectorAll('*'))) {
    element.getBoundingClientRect = () => ({ x: 1, y: 2, width: 30, height: 10, left: 1, top: 2, right: 31, bottom: 12, toJSON: () => ({}) }) as DOMRect;
  }
});

describe('observeProbe', () => {
  it('lists visible elements and counts the hidden ones', () => {
    const result = observeProbe({ max: 50 });
    expect(result.hash).toBe('#home');
    expect(result.title).toBe('LoopDeck');
    expect(result.elements.map((element) => element.name)).toEqual(['Home', 'Start', 'Open', 'Open', 'Close', 'Off']);
    expect(result.hidden).toBe(1);
  });

  it('gives a CSS locator only when it matches exactly that element', () => {
    const byName = Object.fromEntries(observeProbe({ max: 50 }).elements.map((element, index) => [`${element.name}${index}`, element]));
    expect(byName.Start1.css).toBe('#start');
    expect(byName.Close4.css).toBe('button[aria-label="Close"]');
    expect(byName.Open2.css).toBeNull(); // two buttons.row: ambiguous, so no invented locator
    expect(byName.Open3.css).toBeNull();
  });

  it('marks role+name pairs that are not unique and disabled controls as not actionable', () => {
    const elements = observeProbe({ max: 50 }).elements;
    expect(elements.filter((element) => element.name === 'Open').map((element) => element.byRole?.unique)).toEqual([false, false]);
    expect(elements.find((element) => element.name === 'Start')?.byRole).toEqual({ role: 'button', name: 'Start', unique: true });
    expect(elements.find((element) => element.name === 'Off')).toMatchObject({ enabled: false, actionable: false });
    expect(elements.find((element) => element.name === 'Home')).toMatchObject({ role: 'heading', actionable: false });
  });

  it('reports what did not fit', () => {
    const result = observeProbe({ max: 2 });
    expect(result.elements).toHaveLength(2);
    expect(result.truncated).toBe(4);
  });
});
