import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoopDeckPack } from '../src/core/models';
import { studyStore } from '../src/storage/studyRepository';
import type { StudyBackup } from '../src/storage/storageTypes';
import { resolveActivePacks } from '../src/packs/packResolver';
import { validatePack } from '../src/packs/packValidator';

function pack(packId: string): LoopDeckPack {
  return {
    packVersion: 1,
    packId,
    title: packId,
    folders: [],
    modules: [{ id: 'm', title: packId, subject: 'Test', folderId: '', questionIds: [packId + '-q'] }],
    questions: [{ id: packId + '-q', moduleId: 'm', type: 'input', prompt: 'Q', answer: 'A' }]
  };
}
const empty: StudyBackup = {
  format: 'loopdeck3.backup', schema: 1,
  exportedAt: '2026-10-02T00:00:00Z',
  attempts: [],
  bookmarks: [],
  importedPacks: [],
  importedPackAssets: [],
  reviewCards: [],
  reviewLogs: []
};
beforeEach(async () => {
  await studyStore.restoreSnapshot(empty, 'replace');
});
afterEach(() => {
  vi.restoreAllMocks();
});
async function winner() {
  return resolveActivePacks(await studyStore.getImportedPacks()).modulePackIdById.get('m');
}

describe('pack priority persistence', () => {
  it('assigns transaction-ordered priorities to concurrent imports', async () => {
    await Promise.all([studyStore.saveImportedPack(pack('z-first')), studyStore.saveImportedPack(pack('a-second'))]);
    expect(await winner()).toBe('a-second');
  });
  it('promotes an updated pack and preserves priority through both asset strategies', async () => {
    await studyStore.saveImportedPack(pack('a-first'));
    await studyStore.saveImportedPackWithAssets(pack('z-second'), [], 'replace');
    expect(await winner()).toBe('z-second');
    await studyStore.saveImportedPackWithAssets(pack('a-first'), [], 'upsert');
    expect(await winner()).toBe('a-first');
  });
  it.each(['replace', 'merge'] as const)('round trips priority through a %s backup restore', async (mode) => {
    await studyStore.saveImportedPack(pack('z-first'));
    await studyStore.saveImportedPack(pack('a-second'));
    const backup = await studyStore.exportSnapshot();
    expect(backup.importedPacks.map((p) => p.packId)).toEqual(['z-first', 'a-second']);
    expect(backup.importedPacks.every((p) => !('installedOrder' in p))).toBe(true);
    await studyStore.saveImportedPack(pack('zz-newer'));
    await studyStore.restoreSnapshot(backup, mode);
    expect(await winner()).toBe('a-second');
    expect((await studyStore.getImportedPacks()).some((p) => p.packId === 'zz-newer')).toBe(mode === 'merge');
  });
  it('rejects an asynchronous pack write failure and rolls back the asset transaction', async () => {
    await studyStore.saveImportedPack(pack('old'));
    const original = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
      if (this.name === 'packs') throw new DOMException('Disk full', 'QuotaExceededError');
      return original.call(this, value, key);
    });
    await expect(
      studyStore.saveImportedPackWithAssets(
        pack('incoming'),
        [
          {
            packId: 'incoming',
            path: 'images/a.png',
            mimeType: 'image/png',
            dataUrl: 'data:image/png;base64,YQ=='
          }
        ],
        'upsert'
      )
    ).rejects.toBeTruthy();
    expect(await studyStore.getPackAsset('incoming', 'images/a.png')).toBeUndefined();
    expect(await winner()).toBe('old');
  });
  it('rejects obsolete fractional ordinals in backups before replacing current data', async () => {
    const legacy = pack('legacy');
    legacy.questions[0].number = 1.5;
    expect(validatePack(legacy).ok).toBe(false);

    const before = await studyStore.getImportedPacks();
    await expect(studyStore.restoreSnapshot({ ...empty, importedPacks: [legacy] }, 'replace')).rejects.toThrow();
    expect(await studyStore.getImportedPacks()).toEqual(before);
  });
});
