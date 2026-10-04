import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Attempt, LoopDeckPack } from '../src/core/models';
import { applyReviewRating, createReviewCard } from '../src/core/scheduler';
import { loadBuiltinPacks } from '../src/packs/builtinLoader';
import { validateBackupPayload } from '../src/storage/backupValidator';
import { studyStore as db } from '../src/storage/studyRepository';
import type { StudyBackup } from '../src/storage/storageTypes';
import { database, USER_DATA_STORES } from '../src/storage/indexedDb';

const stamp = '2026-01-01T00:00:00.000Z';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
function pack(packId = 'backup-integrity', questionId = 'integrity-q', moduleId = 'integrity-m'): LoopDeckPack {
  return {
    packVersion: 1,
    packId,
    title: packId,
    folders: [],
    modules: [{ id: moduleId, folderId: '', title: moduleId, subject: 'test', questionIds: [questionId] }],
    questions: [{ id: questionId, moduleId, type: 'input', prompt: 'Prompt', answer: 'Answer' }]
  };
}
function attempt(attemptId = 'integrity-attempt'): Attempt {
  return {
    attemptId,
    questionId: 'integrity-q',
    moduleId: 'integrity-m',
    answeredAt: stamp,
    result: 'correct',
    input: 'Answer',
    answer: 'Answer',
    elapsedMs: 1000,
    mode: 'normal'
  };
}
function backup(overrides: Partial<StudyBackup> = {}): StudyBackup {
  return {
    format: 'loopdeck3.backup',
    schema: 1,
    exportedAt: stamp,
    attempts: [],
    bookmarks: [],
    importedPacks: [],
    importedPackAssets: [],
    reviewCards: [],
    reviewLogs: [],
    ...overrides
  };
}
beforeEach(async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  await db.restoreSnapshot(backup(), 'replace');
});
afterEach(() => vi.restoreAllMocks());

describe('backup integrity', () => {
  it('retires prior content state on merge and preserves incoming learning rows as authority', async () => {
    const original = pack();
    await db.saveImportedPack(original);
    const oldAttempt = attempt('old-content');
    await db.recordAnswer(oldAttempt);
    await db.setBookmark(oldAttempt.questionId, true);
    const replacement = { ...original, questions: original.questions.map((question) => ({ ...question, prompt: 'Changed prompt' })) };
    await db.restoreSnapshot(backup({ importedPacks: [replacement] }), 'merge');
    expect(await db.getAttempts()).toEqual([]);
    expect(await db.getBookmarks()).toEqual([]);
    expect(await db.getReviewCards()).toEqual([]);
    expect(await db.getReviewLogs()).toEqual([]);
    expect((await db.exportSnapshot()).attempts).toEqual([{ ...oldAttempt, contentRetired: true }]);

    const newAttempt = attempt('new-content');
    const newReview = applyReviewRating(
      createReviewCard(newAttempt.questionId, newAttempt.moduleId, new Date(stamp)),
      'good',
      'correct',
      1000,
      { now: new Date(stamp), attemptId: newAttempt.attemptId }
    );
    const changedAgain = { ...replacement, questions: replacement.questions.map((question) => ({ ...question, prompt: 'Changed again' })) };
    await db.restoreSnapshot(
      backup({
        importedPacks: [changedAgain],
        attempts: [newAttempt],
        bookmarks: [newAttempt.questionId],
        reviewCards: [newReview.card],
        reviewLogs: [newReview.log]
      }),
      'merge'
    );
    expect(await db.getAttempts()).toEqual([newAttempt]);
    expect(await db.getBookmarks()).toEqual([newAttempt.questionId]);
    expect(await db.getReviewCards()).toEqual([newReview.card]);
    expect(await db.getReviewLogs()).toEqual([newReview.log]);
  });
  it('rejects duplicate primary keys after legacy identity normalization', () => {
    const review = applyReviewRating(createReviewCard('integrity-q', 'integrity-m', new Date(stamp)), 'good', 'correct', 1000, {
      now: new Date(stamp)
    });
    const cases: Partial<StudyBackup>[] = [
      { attempts: [attempt(), attempt()] },
      { bookmarks: ['q', 'q'] },
      { reviewCards: [review.card, { ...review.card, questionMode: undefined }] },
      { reviewLogs: [review.log, review.log] },
      { importedPacks: [pack(), pack()] },
      {
        importedPacks: [pack()],
        importedPackAssets: [
          {
            assetId: 'backup-integrity:images/a.png',
            packId: 'backup-integrity',
            path: 'images/a.png',
            mimeType: 'image/png',
            dataUrl: PNG
          },
          {
            assetId: JSON.stringify(['backup-integrity', 'images/a.png']),
            packId: 'backup-integrity',
            path: 'images/a.png',
            mimeType: 'image/png',
            dataUrl: PNG
          }
        ]
      }
    ];
    for (const entry of cases) expect(() => validateBackupPayload(backup(entry))).toThrow(/duplicate/);
  });

  it('rejects internal/builtin/merged active identity collisions before any replacement', async () => {
    expect(() => validateBackupPayload(backup({ importedPacks: [pack('first'), pack('second', 'integrity-q', 'second-m')] }))).toThrow(
      /identity conflict/
    );
    const builtin = loadBuiltinPacks()[0];
    expect(() => validateBackupPayload(backup({ importedPacks: [{ ...builtin, packId: 'builtin-collision' }] }))).toThrow(
      /identity conflict/
    );
    await db.saveImportedPack(pack('current'));
    await db.setBookmark('preserved', true);
    await expect(
      db.restoreSnapshot(backup({ importedPacks: [pack('incoming', 'integrity-q', 'new-module')] }), 'merge')
    ).rejects.toBeTruthy();
    expect((await db.getImportedPacks()).map((item) => item.packId)).toEqual(['current']);
    expect(await db.getBookmarks()).toEqual(['preserved']);
  });

  it('validates live ownership and linked attempts while preserving deleted-content history', () => {
    expect(() => validateBackupPayload(backup({ importedPacks: [pack()], attempts: [{ ...attempt(), moduleId: 'wrong' }] }))).toThrow(
      /wrong module/
    );
    const review = applyReviewRating(createReviewCard('integrity-q', 'integrity-m', new Date(stamp)), 'good', 'correct', 1000, {
      now: new Date(stamp),
      attemptId: attempt().attemptId
    });
    expect(() => validateBackupPayload(backup({ attempts: [attempt()], reviewLogs: [{ ...review.log, questionId: 'other' }] }))).toThrow(
      /does not match/
    );
    expect(() => validateBackupPayload(backup({ reviewLogs: [review.log] }))).not.toThrow();
    expect(
      validateBackupPayload(
        backup({ attempts: [attempt()], bookmarks: ['removed-question'], reviewCards: [review.card], reviewLogs: [review.log] })
      ).attempts
    ).toHaveLength(1);
  });

  it('rejects inconsistent counters, non-integer intervals, missing due dates and out-of-range ease', () => {
    const review = applyReviewRating(createReviewCard('integrity-q', 'integrity-m', new Date(stamp)), 'good', 'correct', 1000, {
      now: new Date(stamp)
    });
    for (const change of [
      { ease: 0.2 },
      { intervalDays: 1.5 },
      { totalReviews: 2 },
      { correctStreak: 5 },
      { leechLevel: 4 },
      { dueAt: null }
    ]) {
      expect(() => validateBackupPayload(backup({ reviewCards: [{ ...review.card, ...change }] }))).toThrow();
    }
    expect(() => validateBackupPayload(backup({ reviewLogs: [{ ...review.log, nextEase: 5 }] }))).toThrow(/nextEase/);
  });

  it('exports one readonly snapshot even when an import begins between individual store reads', async () => {
    await db.addAttempt(attempt('before'));
    await db.setBookmark('before-bookmark', true);
    const original = IDBObjectStore.prototype.getAll;
    const transactions = new Set<IDBTransaction>();
    let writing: Promise<void> | undefined;
    vi.spyOn(IDBObjectStore.prototype, 'getAll').mockImplementation(function (this: IDBObjectStore, query, count) {
      const request = original.call(this, query, count);
      if (this.transaction.mode === 'readonly') {
        transactions.add(this.transaction);
        if (this.name === 'attempts')
          request.addEventListener('success', () => {
            writing = db.restoreSnapshot(backup({ attempts: [attempt('after')], bookmarks: ['after-bookmark'] }), 'replace');
          });
      }
      return request;
    });
    const exported = await db.exportSnapshot();
    expect(transactions.size).toBe(1);
    expect([...[...transactions][0].objectStoreNames]).toEqual(expect.arrayContaining([...USER_DATA_STORES]));
    expect(exported.attempts.map((row) => row.attemptId)).toEqual(['before']);
    expect(exported.bookmarks).toEqual(['before-bookmark']);
    await writing;
    expect((await db.getAttempts()).map((row) => row.attemptId)).toEqual(['after']);
  });

  it('omits malformed/orphan assets and repairs legacy reviews without mutating the snapshot', async () => {
    await database.transact(['packs', 'packAssets', 'reviewCards'], 'readwrite', (tx) => {
      tx.objectStore('packs').put({ packId: 'invalid-pack' });
      tx.objectStore('packAssets').put({
        assetId: 'orphan',
        packId: 'invalid-pack',
        path: 'images/a.png',
        mimeType: 'image/png',
        dataUrl: 'data:image/png;base64,YQ=='
      });
      tx.objectStore('reviewCards').put({ questionId: 'historical-q', questionMode: 'as_stored', moduleId: 'historical-m' });
    });
    const exported = await db.exportSnapshot();
    expect(exported.importedPacks).toEqual([]);
    expect(exported.importedPackAssets).toEqual([]);
    expect(exported.reviewCards).toEqual([createReviewCard('historical-q', 'historical-m', new Date('1970-01-01T00:00:00.000Z'))]);
    expect(validateBackupPayload(exported)).toEqual(exported);
    expect(console.warn).toHaveBeenCalled();
    await db.restoreSnapshot(exported, 'replace');
    expect(await db.getReviewCards()).toEqual(exported.reviewCards);
  });
});
