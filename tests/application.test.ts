// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StudyApplication } from '../src/app/application';
import { parseRoute, routeHash } from '../src/app/context';
import { resolveActivePacks } from '../src/packs/packResolver';

const mounted: StudyApplication[] = [];
beforeEach(() => { history.replaceState(null, '', '#home'); localStorage.clear(); });
afterEach(() => { for (const app of mounted.splice(0)) app.dispose(); vi.restoreAllMocks(); });

function deferred<T>() {
  let complete: (value: T) => void = () => {};
  const promise = new Promise<T>(resolve => { complete = resolve; });
  return { promise, complete };
}

describe('application ownership', () => {
  it('round-trips encoded module identities and refuses prototype/invalid routes', () => {
    const route = { name: 'module' as const, moduleId: 'part/a:日本語%' };
    expect(parseRoute(routeHash(route))).toEqual(route);
    for (const hash of ['#constructor', '#__proto__', '#module/%zz', '#module/']) expect(parseRoute(hash)).toEqual({ name: 'home' });
  });
  it('cannot publish a catalog that finishes after navigating to diagnostics', async () => {
    const catalog = deferred<ReturnType<typeof resolveActivePacks>>();
    const root = document.createElement('div');
    const app = new StudyApplication(root, () => catalog.promise);
    mounted.push(app);
    app.start();
    app.navigate({ name: 'debugLog' });
    catalog.complete(resolveActivePacks([]));
    await vi.waitFor(() => expect(root.querySelector('.debug-log-screen')).toBeTruthy());
    expect(root.querySelector('.home-screen')).toBeNull();
    expect(root.inert).toBe(false);
  });
  it('releases DOM, timers and URL listeners when disposed during a load', async () => {
    const catalog = deferred<ReturnType<typeof resolveActivePacks>>();
    const root = document.createElement('div');
    const app = new StudyApplication(root, () => catalog.promise);
    mounted.push(app);
    app.start();
    app.dispose();
    catalog.complete(resolveActivePacks([]));
    history.replaceState(null, '', '#debug-log');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await catalog.promise;
    await Promise.resolve();
    expect(root.childElementCount).toBe(0);
    expect(root.inert).toBe(false);
    expect(root.hasAttribute('aria-busy')).toBe(false);
  });
  it('ignores controls retained from an obsolete route', async () => {
    const root = document.createElement('div');
    const app = new StudyApplication(root, async () => resolveActivePacks([]));
    mounted.push(app);
    app.start();
    await vi.waitFor(() => expect(root.querySelector('.home-screen')).toBeTruthy());
    const oldMaterials = [...root.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '教材とデータを開く');
    expect(oldMaterials).toBeDefined();
    app.navigate({ name: 'debugLog' });
    oldMaterials?.click();
    expect(location.hash).toBe('#debug-log');
    expect(root.querySelector('.debug-log-screen')).toBeTruthy();
  });
});
