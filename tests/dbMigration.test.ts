import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';

const DB_NAME = 'loopdeck3-db';

function openLegacyDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = () => {
      const database = request.result;
      database.createObjectStore('attempts', { keyPath: 'attemptId' });
      database.createObjectStore('bookmarks', { keyPath: 'questionId' });
      database.createObjectStore('packs', { keyPath: 'packId' });
      database.createObjectStore('settings', { keyPath: 'key' });
      database.createObjectStore('reviewCards', { keyPath: 'questionId' });
      database.createObjectStore('reviewLogs', { keyPath: 'reviewLogId' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function completeTransaction(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

describe('IndexedDB migration', () => {
  it('migrates legacy data while removing the obsolete settings store', async () => {
    const legacy = await openLegacyDatabase();
    const transaction = legacy.transaction(['attempts', 'bookmarks', 'packs', 'reviewCards', 'reviewLogs'], 'readwrite');
    transaction.objectStore('attempts').put({
      attemptId: 'legacy-attempt',
      questionId: 'q',
      moduleId: 'm',
      answeredAt: '2026-01-01T00:00:00.000Z',
      result: 'wrong',
      input: 'x',
      answer: 'y',
      elapsedMs: 1000,
      mode: 'normal'
    });
    transaction.objectStore('bookmarks').put({ questionId: 'q', createdAt: '2026-01-01T00:00:00.000Z' });
    transaction.objectStore('packs').put({
      packVersion: 1,
      packId: 'legacy-pack',
      title: 'Legacy',
      folders: [],
      modules: [],
      questions: []
    });
    transaction.objectStore('reviewCards').put({ questionId: 'q', moduleId: 'm' });
    transaction.objectStore('reviewLogs').put({ reviewLogId: 'legacy-log', questionId: 'q', moduleId: 'm' });
    await completeTransaction(transaction);
    legacy.close();

    const { db } = await import('../src/storage/db');
    expect((await db.getAttempts()).map((attempt) => attempt.attemptId)).toContain('legacy-attempt');
    expect(await db.getBookmarks()).toContain('q');
    expect(await db.hasBookmark('q')).toBe(true);
    expect(await db.hasBookmark('missing')).toBe(false);
    expect((await db.getImportedPacks()).map((pack) => pack.packId)).toContain('legacy-pack');
    expect((await db.getReviewCards()).map((card) => card.questionId)).toContain('q');
    expect((await db.getReviewLogs()).map((log) => log.reviewLogId)).toContain('legacy-log');
    expect(await db.getImportedPackAssets()).toEqual([]);

    const upgraded = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    expect(upgraded.objectStoreNames.contains('settings')).toBe(false);
    upgraded.close();
    const current = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 4);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const indexTx = current.transaction(['attempts', 'packAssets', 'reviewLogs'], 'readonly');
    expect([...indexTx.objectStore('attempts').indexNames]).toEqual(expect.arrayContaining(['byQuestionId', 'byResult']));
    expect([...indexTx.objectStore('packAssets').indexNames]).toContain('byPackId');
    expect([...indexTx.objectStore('reviewLogs').indexNames]).toEqual(expect.arrayContaining(['byQuestionId', 'byReviewedAt']));
    current.close();
  });
});
