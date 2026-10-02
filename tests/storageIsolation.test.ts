// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { db } from '../src/storage/db';
import { readStoredSession } from '../src/storage/sessionStorage';
import { readStudyPreferences, writeStudyPreferences } from '../src/storage/studyPreferences';
import { defaultStudySettings } from '../src/core/studySettings';

afterEach(() => localStorage.clear());

describe('LoopDeck2 and LoopDeck3 in the same browser origin', () => {
  it('writes new bookmarks without touching the old application database', async () => {
    const old = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('loopdeck-db', 4);
      request.onupgradeneeded = () => request.result.createObjectStore('bookmarks', { keyPath: 'questionId' });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = old.transaction('bookmarks', 'readwrite');
        transaction.objectStore('bookmarks').put({ questionId: 'old-question' });
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
      expect(await db.hasBookmark('old-question')).toBe(false);
      await db.setBookmark('new-question', true);
      expect(await db.getBookmarks()).toEqual(['new-question']);
      const oldBookmarks = await new Promise<unknown[]>((resolve, reject) => {
        const request = old.transaction('bookmarks').objectStore('bookmarks').getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      expect(oldBookmarks).toEqual([{ questionId: 'old-question' }]);
    } finally {
      old.close();
    }
  });

  it('does not consume or overwrite LoopDeck2 preferences or resume checkpoints', () => {
    const legacyPreferences = JSON.stringify({ version: 2, settings: { autoNext: false } });
    const settings = defaultStudySettings({ id: 'module', title: 'Module', folderId: 'folder', subject: 'test', questionIds: [] });
    const legacySession = JSON.stringify({ version: 2, questions: [], index: 0, settings, mode: 'normal', startedAt: 0, currentElapsedMs: 0, currentHiddenTimeExcludedMs: 0, attempts: [], savedAt: new Date().toISOString() });
    localStorage.setItem('loopdeck_study_prefs_v2_["pack","module"]', legacyPreferences);
    localStorage.setItem('loopdeck_session_module', legacySession);
    expect(readStudyPreferences('pack', 'module')).toBeUndefined();
    expect(readStoredSession('module', new Map())).toBeUndefined();
    localStorage.setItem('loopdeck3_session_module', legacySession);
    expect(readStoredSession('module', new Map())).toEqual(JSON.parse(legacySession));
    writeStudyPreferences('pack', 'module', settings);
    expect(readStudyPreferences('pack', 'module')?.autoNext).toBe(true);
    expect(localStorage.getItem('loopdeck_study_prefs_v2_["pack","module"]')).toBe(legacyPreferences);
    expect(localStorage.getItem('loopdeck_session_module')).toBe(legacySession);
  });
});
