import { StudyRepository } from '../src/storage/studyRepository';
import { createReviewCard, applyReviewRating } from '../src/core/scheduler';
import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { LocalDatabase } from '../src/storage/indexedDb';

describe('fresh LoopDeck3 database', () => {
  it('closes a late connection after a blocked open and allows a fresh retry', async () => {
    const close = vi.fn();
    const request = { result: { close }, onblocked: null, onsuccess: null } as unknown as IDBOpenDBRequest;
    const open = vi.spyOn(indexedDB, 'open').mockReturnValueOnce(request);
    const database = new LocalDatabase('blocked-open-test');
    try {
      const pending = database.all('bookmarks');
      request.onblocked?.call(request, new Event('blocked') as IDBVersionChangeEvent);
      await expect(pending).rejects.toThrow('Close other LoopDeck3 windows');
      request.onsuccess?.call(request, new Event('success'));
      expect(close).toHaveBeenCalledOnce();
      expect(await database.all('bookmarks')).toEqual([]);
      expect(open).toHaveBeenCalledTimes(2);
    } finally {
      database.close();
      open.mockRestore();
    }
  });
  it('creates one current schema without migrating old stores', async () => {
    const database = new LocalDatabase('fresh-schema-test');
    try {
      const shape = await database.transact('attempts', 'readonly', (tx) => ({
        version: tx.db.version,
        stores: [...tx.db.objectStoreNames],
        indexes: [...tx.objectStore('attempts').indexNames]
      }));
      expect(shape.version).toBe(2);
      expect(shape.stores).toEqual(['attempts', 'bookmarks', 'contentMetadata', 'packAssets', 'packs', 'reviewCards', 'reviewLogs']);
      expect(shape.indexes).toEqual(['byQuestionId', 'byResult']);
    } finally {
      database.close();
    }
  });
  it('rolls back earlier requests when scheduling throws', async () => {
    const database = new LocalDatabase('abort-scheduling-test');
    try {
      await expect(
        database.transact('bookmarks', 'readwrite', (tx) => {
          tx.objectStore('bookmarks').put({ questionId: 'should-not-commit' });
          throw new Error('Cannot complete this command');
        })
      ).rejects.toThrow('Cannot complete this command');
      expect(await database.all('bookmarks')).toEqual([]);
    } finally {
      database.close();
    }
  });
});

it('migrates only schema1 LoopDeck3 records, repairs recoverable progress and separates directions', async () => {
  const name = `migration3-${crypto.randomUUID()}`;
  const legacy = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      for (const [name, key] of Object.entries({
        attempts: 'attemptId',
        bookmarks: 'questionId',
        packs: 'packId',
        packAssets: 'assetId',
        reviewCards: 'questionId',
        reviewLogs: 'reviewLogId'
      }))
        request.result.createObjectStore(name, { keyPath: key });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const stamp = new Date('2026-01-01T00:00:00Z');
  const progress = applyReviewRating(createReviewCard('scheduled', 'm', stamp), 'good', 'correct', 1000, { now: stamp });
  const tx = legacy.transaction(['reviewCards', 'reviewLogs', 'packAssets'], 'readwrite');
  tx.objectStore('reviewCards').put({ questionId: 'new', moduleId: 'm' });
  tx.objectStore('reviewCards').put(progress.card);
  tx.objectStore('reviewCards').put({ questionId: 'broken', moduleId: 'm', state: 'review' });
  tx.objectStore('reviewLogs').put(progress.log);
  tx.objectStore('reviewLogs').put({ reviewLogId: 'broken' });
  tx.objectStore('packAssets').put({ assetId: 'p:images/a.png', packId: 'p', path: 'images/a.png', dataUrl: 'data' });
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
  });
  legacy.close();
  const database = new LocalDatabase(name),
    store = new StudyRepository(database);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    expect(await store.getReviewCard('new')).toMatchObject({
      state: 'new',
      questionMode: 'as_stored',
      createdAt: '1970-01-01T00:00:00.000Z'
    });
    expect(await store.getReviewCard('scheduled')).toEqual(progress.card);
    expect(await store.getReviewCard('broken')).toBeUndefined();
    expect(await store.getReviewLogs()).toEqual([progress.log]);
    await store.putReviewCard({ ...progress.card, questionMode: 'back_to_front' });
    expect(await store.getReviewCards()).toHaveLength(3);
    expect(await store.getPackAsset('p', 'images/a.png')).toMatchObject({ assetId: '["p","images/a.png"]' });
    expect(warn).toHaveBeenCalled();
  } finally {
    database.close();
    warn.mockRestore();
  }
});

it('repairs malformed schema2 cards on direct reads and discards progress with missing due dates', async () => {
  const database = new LocalDatabase(`repair3-${crypto.randomUUID()}`),
    store = new StudyRepository(database);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await database.transact('reviewCards', 'readwrite', (tx) => {
      tx.objectStore('reviewCards').put({ questionId: 'new', moduleId: 'm', questionMode: 'as_stored' });
      tx.objectStore('reviewCards').put({ questionId: 'broken', moduleId: 'm', questionMode: 'as_stored', state: 'review' });
    });
    expect(await store.getReviewCard('new')).toMatchObject({ state: 'new', totalReviews: 0 });
    expect(await store.getReviewCard('broken')).toBeUndefined();
    expect(await database.all('reviewCards')).toHaveLength(1);
    expect(warn).toHaveBeenCalled();
  } finally {
    database.close();
    warn.mockRestore();
  }
});
