import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Attempt, ReviewCard, ReviewLog } from '../src/core/models';
import { studyStore } from '../src/storage/studyRepository';
import type { StudyBackup } from '../src/storage/storageTypes';

function attempt(id: string): Attempt {
  return {
    attemptId: id,
    questionId: `q-${id}`,
    moduleId: 'atomic-module',
    answeredAt: '2026-09-27T00:00:00.000Z',
    result: 'correct',
    input: 'a',
    answer: 'a',
    elapsedMs: 1000,
    mode: 'normal'
  };
}

function card(id: string): ReviewCard {
  return {
    questionId: `q-${id}`,
    moduleId: 'atomic-module',
    state: 'relearning',
    dueAt: '2026-09-28T00:00:00.000Z',
    lastReviewedAt: '2026-09-27T00:00:00.000Z',
    firstReviewedAt: '2026-09-27T00:00:00.000Z',
    intervalDays: 1,
    ease: 2.5,
    totalReviews: 1,
    totalCorrect: 1,
    totalWrong: 0,
    correctStreak: 1,
    wrongStreak: 0,
    lapseCount: 0,
    leechLevel: 0,
    suspended: false,
    createdAt: '2026-09-27T00:00:00.000Z',
    updatedAt: '2026-09-27T00:00:00.000Z'
  };
}

function log(id: string): ReviewLog {
  return {
    reviewLogId: `log-${id}`,
    questionId: `q-${id}`,
    moduleId: 'atomic-module',
    reviewedAt: '2026-09-27T00:00:00.000Z',
    rating: 'good',
    result: 'correct',
    previousState: 'new',
    nextState: 'relearning',
    previousDueAt: null,
    nextDueAt: '2026-09-28T00:00:00.000Z',
    previousIntervalDays: 0,
    nextIntervalDays: 1,
    previousEase: 2.5,
    nextEase: 2.5,
    elapsedMs: 1000,
    attemptId: id
  };
}

function emptyBackup(): StudyBackup {
  return {
    format: 'loopdeck3.backup', schema: 1,
    exportedAt: '2026-09-27T00:00:00.000Z',
    attempts: [],
    bookmarks: [],
    importedPacks: [],
    importedPackAssets: [],
    reviewCards: [],
    reviewLogs: []
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await studyStore.restoreSnapshot(emptyBackup(), 'replace');
});

describe('IndexedDB atomic persistence', () => {
  it('rolls back attempt/card/log together when one write cannot be cloned', async () => {
    const badCard = { ...card('atomic-fail'), nonCloneable: () => undefined } as unknown as ReviewCard;

    await expect(studyStore.saveAttemptWithReview(attempt('atomic-fail'), badCard, log('atomic-fail'))).rejects.toBeTruthy();

    expect((await studyStore.getAttempts()).some((row) => row.attemptId === 'atomic-fail')).toBe(false);
    expect(await studyStore.getReviewCard('q-atomic-fail')).toBeUndefined();
    expect(await studyStore.getReviewLogsForQuestion('q-atomic-fail')).toEqual([]);
  });

  it('rolls back a replace restore completely when a later backup row fails', async () => {
    await studyStore.addAttempt(attempt('existing'));
    await studyStore.setBookmark('existing-bookmark', true);
    const backup = emptyBackup();
    backup.attempts = [attempt('incoming')];
    backup.reviewLogs = [log('incoming')];
    const originalPut = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
      if (this.name === 'reviewLogs') throw new DOMException('Disk full', 'QuotaExceededError');
      return originalPut.call(this, value, key);
    });

    await expect(studyStore.restoreSnapshot(backup, 'replace')).rejects.toBeTruthy();

    expect((await studyStore.getAttempts()).map((row) => row.attemptId)).toContain('existing');
    expect((await studyStore.getAttempts()).map((row) => row.attemptId)).not.toContain('incoming');
    expect(await studyStore.getBookmarks()).toContain('existing-bookmark');
  });

  it('keeps unrelated current rows in merge mode and removes them in replace mode', async () => {
    await studyStore.addAttempt(attempt('current'));
    await studyStore.setBookmark('current-bookmark', true);
    const backup = emptyBackup();
    backup.attempts = [attempt('backup')];
    backup.bookmarks = ['backup-bookmark'];

    await studyStore.restoreSnapshot(backup, 'merge');
    expect(new Set((await studyStore.getAttempts()).map((row) => row.attemptId))).toEqual(new Set(['current', 'backup']));
    expect(new Set(await studyStore.getBookmarks())).toEqual(new Set(['current-bookmark', 'backup-bookmark']));

    await studyStore.restoreSnapshot(backup, 'replace');
    expect((await studyStore.getAttempts()).map((row) => row.attemptId)).toEqual(['backup']);
    expect(await studyStore.getBookmarks()).toEqual(['backup-bookmark']);
  });
});
