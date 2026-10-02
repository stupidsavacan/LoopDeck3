import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { database } from '../src/storage/indexedDb';
import { studyStore } from '../src/storage/studyRepository';
import type { Attempt } from '../src/core/models';

afterEach(() => vi.restoreAllMocks());
const attempt: Attempt = { attemptId: 'snapshot-attempt', questionId: 'before', moduleId: 'm', answeredAt: '2026-10-02T00:00:00Z', result: 'correct', input: 'A', answer: 'A', elapsedMs: 1000, mode: 'normal' };

describe('snapshot transaction boundary', () => {
  it('exports a consistent point in time when a write is requested during the first store read', async () => {
    await database.transact(['attempts', 'bookmarks'], 'readwrite', tx => {
      tx.objectStore('attempts').clear();
      tx.objectStore('bookmarks').clear();
      tx.objectStore('attempts').put(attempt);
      tx.objectStore('bookmarks').put({ questionId: 'before' });
    });
    const read = IDBObjectStore.prototype.getAll;
    let write: Promise<unknown> | undefined;
    let armed = true;
    vi.spyOn(IDBObjectStore.prototype, 'getAll').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['getAll']>) {
      const request = read.apply(this, args);
      if (this.name === 'attempts' && armed) {
        armed = false;
        request.addEventListener('success', () => {
          write = database.transact(['attempts', 'bookmarks'], 'readwrite', tx => {
            tx.objectStore('attempts').put({ ...attempt, questionId: 'after' });
            tx.objectStore('bookmarks').clear();
            tx.objectStore('bookmarks').put({ questionId: 'after' });
          });
        });
      }
      return request;
    });
    const snapshot = await studyStore.exportSnapshot();
    await write;
    expect(snapshot.attempts.map(item => item.questionId)).toEqual(['before']);
    expect(snapshot.bookmarks).toEqual(['before']);
    expect(await studyStore.getBookmarks()).toEqual(['after']);
  });
  it('rejects old-format data without changing the current database', async () => {
    const before = await studyStore.getBookmarks();
    await expect(studyStore.restoreSnapshot({ loopDeckBackupVersion: 1, exportedAt: new Date().toISOString(), attempts: [], bookmarks: [], importedPacks: [] }, 'replace')).rejects.toThrow('Unsupported backup format');
    expect(await studyStore.getBookmarks()).toEqual(before);
  });
});
