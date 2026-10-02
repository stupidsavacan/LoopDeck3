// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StudyApplication } from '../src/app/application';
import { parseRoute, routeHash } from '../src/app/context';
import { resolveActivePacks } from '../src/packs/packResolver';
import { LocalDatabase } from '../src/storage/indexedDb';
import { StudyRepository, studyStore } from '../src/storage/studyRepository';

const mounted: StudyApplication[] = [];
beforeEach(() => { history.replaceState(null, '', '#home'); localStorage.clear(); });
afterEach(() => { for (const app of mounted.splice(0)) app.dispose(); vi.restoreAllMocks(); });

function deferred<T>() {
  let complete: (value: T) => void = () => {};
  const promise = new Promise<T>(resolve => { complete = resolve; });
  return { promise, complete };
}

describe('application ownership', () => {
  it('loads and studies through the injected repository without writing the default database', async () => {
    const database = new LocalDatabase(`injected-app-${crypto.randomUUID()}`);
    const store = new StudyRepository(database);
    const before = await studyStore.getAttempts();
    const root = document.createElement('div');
    const app = new StudyApplication(root, { store });
    mounted.push(app);
    try {
      await store.saveImportedPack({ packVersion: 1, packId: 'injected', title: 'Injected', folders: [{ id: 'f', title: 'Injected folder' }],
        modules: [{ id: 'injected-module', title: 'Injected module', folderId: 'f', subject: 'Test', questionIds: ['injected-q'] }],
        questions: [{ id: 'injected-q', moduleId: 'injected-module', type: 'input', prompt: 'Injected question', answer: 'dog' }] });
      app.start();
      await vi.waitFor(() => expect(root.textContent).toContain('Injected module'));
      app.navigate({ name: 'module', moduleId: 'injected-module' });
      await vi.waitFor(() => expect(root.querySelector('.module-screen')).toBeTruthy());
      [...root.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '学習を始める')?.click();
      const input = root.querySelector<HTMLInputElement>('input.text-input');
      expect(input).toBeTruthy(); if (input) input.value = 'dog';
      [...root.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '回答する')?.click();
      await vi.waitFor(async () => expect(await store.getAttempts()).toHaveLength(1));
      expect(await store.getReviewCard('injected-q')).toMatchObject({ totalCorrect: 1 });
      expect(await studyStore.getAttempts()).toEqual(before);
    } finally { app.dispose(); database.close(); }
  });
  it('round-trips encoded module identities and refuses prototype/invalid routes', () => {
    const route = { name: 'module' as const, moduleId: 'part/a:日本語%' };
    expect(parseRoute(routeHash(route))).toEqual(route);
    for (const hash of ['#constructor', '#__proto__', '#module/%zz', '#module/']) expect(parseRoute(hash)).toEqual({ name: 'home' });
  });
  it('cannot publish a catalog that finishes after navigating to diagnostics', async () => {
    const catalog = deferred<ReturnType<typeof resolveActivePacks>>();
    const root = document.createElement('div');
    const app = new StudyApplication(root, { loadCatalog: () => catalog.promise });
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
    const app = new StudyApplication(root, { loadCatalog: () => catalog.promise });
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
    const app = new StudyApplication(root, { loadCatalog: async () => resolveActivePacks([]) });
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
  it('normalizes an invalid history URL without pushing another entry', async () => {
    const root = document.createElement('div');
    const app = new StudyApplication(root, { loadCatalog: async () => resolveActivePacks([]) });
    mounted.push(app);
    app.start();
    await vi.waitFor(() => expect(root.querySelector('.home-screen')).toBeTruthy());
    const push = vi.spyOn(history, 'pushState');
    history.replaceState(null, '', '#module/%zz');
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(location.hash).toBe('#home');
    expect(push).not.toHaveBeenCalled();
  });
});
