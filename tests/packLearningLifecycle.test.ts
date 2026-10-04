// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Attempt, InputQuestion, LoopDeckPack } from '../src/core/models';
import { buildQuizAnswerSources, buildReviewPersistence } from '../src/core/reviewPersistence';
import { loadBuiltinPacks } from '../src/packs/builtinLoader';
import { resolveActivePacks } from '../src/packs/packResolver';
import { studyStore as db } from '../src/storage/studyRepository';
import type { StudyBackup } from '../src/storage/storageTypes';
const persistAttemptAndReview = (attempt: Attempt, store: typeof db, source?: import('../src/core/models').QuizAnswerSource) =>
  store.recordAnswer(attempt, source);
import { studyPreferencesKey } from '../src/storage/studyPreferences';

const question: InputQuestion = { id: 'life-q', moduleId: 'life-m', type: 'input', prompt: 'Original', answer: 'Answer' };
function pack(questions: InputQuestion[] = [question], packId = 'life-pack'): LoopDeckPack {
  return {
    packVersion: 1,
    packId,
    title: packId,
    folders: [],
    modules: [{ id: 'life-m', folderId: '', title: 'Module', subject: 'Test', questionIds: questions.map((q) => q.id) }],
    questions
  };
}
const emptyBackup: StudyBackup = {
  format: 'loopdeck3.backup',
  schema: 1,
  exportedAt: '2026-10-03T00:00:00.000Z',
  attempts: [],
  bookmarks: [],
  importedPacks: [],
  reviewCards: [],
  reviewLogs: [],
  importedPackAssets: []
};
const attempt: Attempt = {
  attemptId: 'life-attempt',
  questionId: question.id,
  moduleId: question.moduleId,
  answeredAt: '2026-10-03T00:00:00.000Z',
  result: 'wrong',
  input: 'wrong',
  answer: question.answer,
  elapsedMs: 1000,
  mode: 'normal'
};
async function seedProgress() {
  await persistAttemptAndReview(attempt, db);
  await db.setBookmark(question.id, true);
}
async function answerSources() {
  const view = resolveActivePacks([...loadBuiltinPacks(), ...(await db.getImportedPacks())]);
  return buildQuizAnswerSources(
    view.questions,
    view.modulePackIdById,
    await db.getImportedPackAssets(),
    await db.getImportedPackRevisions()
  );
}
async function expectReset() {
  expect(await db.getAttempts()).toEqual([]);
  expect(await db.getBookmarks()).toEqual([]);
  expect(await db.getReviewCards()).toEqual([]);
  expect(await db.getReviewLogs()).toEqual([]);
  expect((await db.exportSnapshot()).attempts).toMatchObject([{ attemptId: attempt.attemptId, contentRetired: true }]);
}
const originalPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const changedPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+Xn9sAAAAASUVORK5CYII=';
const asset = (path: string, data = originalPng) => ({
  packId: 'life-pack',
  path,
  mimeType: 'image/png',
  dataUrl: `data:image/png;base64,${data}`
});
beforeEach(async () => {
  await db.restoreSnapshot(emptyBackup, 'replace');
  localStorage.clear();
});
afterEach(async () => {
  await db.restoreSnapshot(emptyBackup, 'replace');
});

describe('pack learning lifecycle', () => {
  it('rejects a pending old quiz answer after same-ID content replacement without recreating retired review state', async () => {
    await db.saveImportedPack(pack());
    const source = (await answerSources()).get(question.id);
    await persistAttemptAndReview(attempt, db, source);
    await db.saveImportedPack(pack([{ ...question, answer: 'Replacement' }]));
    await expect(persistAttemptAndReview(attempt, db, source)).rejects.toThrow('教材が変更されたため');
    await expectReset();
  });

  it('rejects a pending answer after identical delete/reinstall using its durable install revision', async () => {
    await db.saveImportedPack(pack());
    const source = (await answerSources()).get(question.id);
    await db.deleteImportedPack('life-pack');
    await db.saveImportedPack(pack());
    await expect(persistAttemptAndReview(attempt, db, source)).rejects.toThrow('教材が変更されたため');
    expect(await db.getAttempts()).toEqual([]);
    expect(await db.getReviewCards()).toEqual([]);
    await persistAttemptAndReview(attempt, db, (await answerSources()).get(question.id));
    expect(await db.getAttempts()).toEqual([attempt]);
  });

  it('checks image bytes atomically even when question source and pack ID remain identical', async () => {
    const imagePack = pack([{ ...question, imageAsset: 'images/image.png' }]);
    await db.saveImportedPackWithAssets(imagePack, [asset('images/image.png')], 'replace');
    const source = (await answerSources()).get(question.id)!;
    const { packRevision: _revision, ...contentSource } = source;
    await db.saveImportedPackWithAssets(imagePack, [asset('images/image.png', changedPng)], 'replace');
    await expect(persistAttemptAndReview(attempt, db, contentSource)).rejects.toThrow('教材が変更されたため');
    expect(await db.getAttempts()).toEqual([]);
  });

  it('rejects pending builtin quiz answers after an empty replacement backup using the reset epoch', async () => {
    const builtinQuestion = loadBuiltinPacks()
      .flatMap((p) => p.questions)
      .find((q) => q.type === 'input' && !q.imageAsset)!;
    const source = (await answerSources()).get(builtinQuestion.id);
    const builtinAttempt = { ...attempt, questionId: builtinQuestion.id, moduleId: builtinQuestion.moduleId };
    await db.restoreSnapshot(emptyBackup, 'replace');
    await expect(persistAttemptAndReview(builtinAttempt, db, source)).rejects.toThrow('教材が変更されたため');
    expect(await db.getAttempts()).toEqual([]);
    await persistAttemptAndReview(builtinAttempt, db, (await answerSources()).get(builtinQuestion.id));
    expect(await db.getAttempts()).toEqual([builtinAttempt]);
  });
  it('does not attach legacy orphan learning rows when a new pack reuses their IDs', async () => {
    await seedProgress();
    await db.saveImportedPack(pack());
    await expectReset();
  });
  it('retires same-ID changed answers and preserves archived history through backup restore', async () => {
    await db.saveImportedPack(pack());
    await seedProgress();
    await db.saveImportedPack(pack([{ ...question, answer: 'Replacement answer' }]));
    await expectReset();
    const backup = await db.exportSnapshot();
    await db.restoreSnapshot(backup, 'replace');
    await expectReset();
  });

  it('does not attach deleted material progress when exactly the same IDs are reinstalled', async () => {
    await db.saveImportedPack(pack());
    await seedProgress();
    await db.deleteImportedPack('life-pack');
    await expectReset();
    await db.saveImportedPack(pack());
    await expectReset();
  });

  it('resets learning when exact canonical content changes, including presentation metadata', async () => {
    await db.saveImportedPack(pack());
    await seedProgress();
    await db.saveImportedPack(
      pack([
        { ...question, number: 2, category: 'Updated', explanation: 'New explanation' },
        { ...question, id: 'life-new', number: 3 }
      ])
    );
    await expectReset();
  });

  it('prunes orphan assets during a plain save while retaining still-referenced image bytes', async () => {
    const imageQuestion = { ...question, imageAsset: 'images/keep.png' };
    const removed = { ...question, id: 'life-removed', imageAsset: 'images/remove.png' };
    await db.saveImportedPackWithAssets(pack([imageQuestion, removed]), [asset('images/keep.png'), asset('images/remove.png')], 'replace');
    localStorage.setItem(studyPreferencesKey('life-pack', 'life-m'), 'stale');
    await db.saveImportedPack(pack([imageQuestion]));
    expect(await db.getPackAsset('life-pack', 'images/keep.png')).toBeDefined();
    expect(await db.getPackAsset('life-pack', 'images/remove.png')).toBeUndefined();
    expect(localStorage.getItem(studyPreferencesKey('life-pack', 'life-m'))).toBeNull();
  });

  it('retires progress when a same-path image changes, but preserves it for identical replacement bytes', async () => {
    const imagePack = pack([{ ...question, imageAsset: 'images/image.png' }]);
    await db.saveImportedPackWithAssets(imagePack, [asset('images/image.png')], 'replace');
    await seedProgress();
    await db.saveImportedPackWithAssets(imagePack, [asset('images/image.png')], 'replace');
    expect(await db.getAttempts()).toEqual([attempt]);
    await db.saveImportedPackWithAssets(imagePack, [asset('images/image.png', changedPng)], 'replace');
    await expectReset();
  });

  it('rolls back retirement, packs, assets and browser cleanup if a merge asset collision aborts', async () => {
    const imagePack = pack([{ ...question, imageAsset: 'images/image.png' }]);
    await db.saveImportedPackWithAssets(imagePack, [asset('images/image.png')], 'replace');
    await seedProgress();
    localStorage.setItem(studyPreferencesKey('life-pack', 'life-m'), 'keep');
    await expect(
      db.saveImportedPackWithAssets(
        pack([{ ...question, imageAsset: 'images/image.png', answer: 'Changed answer' }]),
        [asset('images/image.png', changedPng)],
        'upsert'
      )
    ).rejects.toThrow();
    expect(await db.getAttempts()).toEqual([attempt]);
    expect(await db.getBookmarks()).toEqual([question.id]);
    expect(await db.getReviewCards()).toHaveLength(1);
    expect((await db.getImportedPacks())[0].questions[0]).toMatchObject({ answer: 'Answer' });
    expect((await db.getPackAsset('life-pack', 'images/image.png'))?.dataUrl).toBe(asset('images/image.png').dataUrl);
    expect(localStorage.getItem(studyPreferencesKey('life-pack', 'life-m'))).toBe('keep');
  });

  it('reconciles the active owner according to installation priority when an older pack is updated', async () => {
    await db.saveImportedPack(pack());
    await seedProgress();
    const newer = pack([{ ...question, id: 'newer-q' }], 'newer-pack');
    await db.saveImportedPack(newer);
    await expectReset();
    const newerAttempt = { ...attempt, attemptId: 'newer-attempt', questionId: 'newer-q' };
    await persistAttemptAndReview(newerAttempt, db);
    await db.saveImportedPack(pack());
    expect((await db.getImportedPacks()).map((p) => p.packId)).toEqual(['newer-pack', 'life-pack']);
    expect(await db.getAttempts()).toEqual([]);
    expect((await db.exportSnapshot()).attempts.every((a) => a.contentRetired)).toBe(true);
  });

  it('retires previous changed-content rows before inserting authoritative incoming backup learning rows', async () => {
    await db.saveImportedPack(pack());
    await seedProgress();
    const incomingAttempt = {
      ...attempt,
      attemptId: 'incoming-attempt',
      result: 'correct' as const,
      answer: 'Replacement',
      input: 'Replacement'
    };
    const incoming = buildReviewPersistence(incomingAttempt);
    await db.restoreSnapshot(
      {
        ...emptyBackup,
        importedPacks: [pack([{ ...question, answer: 'Replacement' }])],
        attempts: [incomingAttempt],
        bookmarks: [question.id],
        reviewCards: [incoming.card],
        reviewLogs: [incoming.log]
      },
      'merge'
    );
    expect(await db.getAttempts()).toEqual([incomingAttempt]);
    expect(await db.getBookmarks()).toEqual([question.id]);
    expect(await db.getReviewCards()).toEqual([incoming.card]);
    expect(await db.getReviewLogs()).toEqual([incoming.log]);
    const archived = (await db.exportSnapshot()).attempts.find((row) => row.attemptId === attempt.attemptId);
    expect(archived?.contentRetired).toBe(true);
  });

  it('uses post-restore priority when a merge backup updates an older, currently shadowed pack', async () => {
    await db.saveImportedPack(pack());
    await db.saveImportedPack(pack([{ ...question, id: 'newer-q' }], 'newer-pack'));
    const newerAttempt = { ...attempt, questionId: 'newer-q' };
    await persistAttemptAndReview(newerAttempt, db);
    await db.setBookmark('newer-q', true);
    await db.restoreSnapshot({ ...emptyBackup, importedPacks: [pack()] }, 'merge');
    expect((await db.getImportedPacks()).map((p) => p.packId)).toEqual(['newer-pack', 'life-pack']);
    await expectReset();
  });
});
