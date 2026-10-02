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
    } finally { database.close(); open.mockRestore(); }
  });
  it('creates one current schema without migrating old stores', async () => {
    const database = new LocalDatabase('fresh-schema-test');
    try {
      const shape = await database.transact('attempts', 'readonly', tx => ({ version: tx.db.version, stores: [...tx.db.objectStoreNames], indexes: [...tx.objectStore('attempts').indexNames] }));
      expect(shape.version).toBe(1);
      expect(shape.stores).toEqual(['attempts', 'bookmarks', 'packAssets', 'packs', 'reviewCards', 'reviewLogs']);
      expect(shape.indexes).toEqual(['byQuestionId', 'byResult']);
    } finally { database.close(); }
  });
  it('rolls back earlier requests when scheduling throws', async () => {
    const database = new LocalDatabase('abort-scheduling-test');
    try {
      await expect(database.transact('bookmarks', 'readwrite', tx => {
        tx.objectStore('bookmarks').put({ questionId: 'should-not-commit' });
        throw new Error('Cannot complete this command');
      })).rejects.toThrow('Cannot complete this command');
      expect(await database.all('bookmarks')).toEqual([]);
    } finally { database.close(); }
  });
});
