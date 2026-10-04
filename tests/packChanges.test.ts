// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalDatabase } from '../src/storage/indexedDb';
import { StudyRepository } from '../src/storage/studyRepository';
import { StudyApplication } from '../src/app/application';
import { notifyPackChanges, subscribePackChanges } from '../src/storage/packChanges';
import type { LoopDeckPack } from '../src/core/models';

const pack: LoopDeckPack = {
  packVersion: 1,
  packId: 'notify',
  title: 'Notification pack',
  folders: [],
  modules: [{ id: 'notify-module', folderId: '', title: 'Newly imported module', subject: 'Test', questionIds: ['notify-q'] }],
  questions: [{ id: 'notify-q', moduleId: 'notify-module', type: 'input', prompt: 'Question', answer: 'Answer' }]
};
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.restoreAllMocks();
});

describe('injected catalog notifications', () => {
  it('scopes local changes to a database and stops notifying disposed subscribers', () => {
    const left = vi.fn(),
      right = vi.fn();
    const unsubscribe = subscribePackChanges('left', left);
    cleanups.push(unsubscribe, subscribePackChanges('right', right));
    notifyPackChanges('left');
    expect(left).toHaveBeenCalledOnce();
    expect(right).not.toHaveBeenCalled();
    unsubscribe();
    notifyPackChanges('left');
    expect(left).toHaveBeenCalledOnce();
  });
  it('deduplicates matching storage notifications and ignores other app namespaces', () => {
    const changed = vi.fn();
    cleanups.push(subscribePackChanges('shared', changed));
    const message = JSON.stringify({ database: 'shared', revision: 'revision-1' });
    for (const key of ['loopdeck_pack_changes_v1', 'loopdeck3.catalog-changes', 'loopdeck3.catalog-changes']) {
      window.dispatchEvent(new StorageEvent('storage', { key, newValue: message }));
    }
    expect(changed).toHaveBeenCalledOnce();
  });
  it('publishes after successful persistence and does not publish aborted installs', async () => {
    const database = new LocalDatabase(`notifications-${crypto.randomUUID()}`);
    const store = new StudyRepository(database),
      changed = vi.fn();
    cleanups.push(() => database.close(), store.subscribePackChanges(changed));
    await store.saveImportedPack(pack);
    expect(changed).toHaveBeenCalledOnce();
    expect(await store.getImportedPacks()).toMatchObject([{ packId: pack.packId }]);
    const conflicting = {
      ...pack,
      packId: 'other',
      modules: [{ ...pack.modules[0], id: 'other-module' }],
      questions: [{ ...pack.questions[0], moduleId: 'other-module' }]
    };
    await expect(store.saveImportedPack(conflicting)).rejects.toBeTruthy();
    expect(changed).toHaveBeenCalledOnce();
  });
  it('refreshes a mounted catalog after another repository installs material in the same database', async () => {
    const name = `shared-catalog-${crypto.randomUUID()}`;
    const first = new LocalDatabase(name),
      second = new LocalDatabase(name);
    const root = document.createElement('div');
    const app = new StudyApplication(root, { store: new StudyRepository(first) });
    cleanups.push(() => {
      app.dispose();
      first.close();
      second.close();
    });
    history.replaceState(null, '', '#home');
    app.start();
    await vi.waitFor(() => expect(root.querySelector('.home-screen')).toBeTruthy());
    expect(root.textContent).not.toContain('Newly imported module');
    await new StudyRepository(second).saveImportedPack(pack);
    await vi.waitFor(() => expect(root.textContent).toContain('Newly imported module'));
  });
});
