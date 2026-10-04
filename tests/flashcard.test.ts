import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import type { LoopDeckPack, Question } from '../src/core/models';
import { resolveFlashcardGesture, restartFlashcardSession } from '../src/core/flashcard';
import { getPresentedStudyPair, presentQuestionForStudy } from '../src/core/questionPresentation';
import { createSession } from '../src/core/sessionEngine';
import { buildQuizAttempt } from '../src/core/quizAnswer';
import { inferReviewRating } from '../src/core/scheduler';
import { analyzeProblems, answerModeFor, scoreAttemptDelta, timingBand } from '../src/core/reviewEngine';
import { LocalDatabase } from '../src/storage/indexedDb';
import { StudyRepository } from '../src/storage/studyRepository';
import { validatePack } from '../src/packs/packValidator';

const english: Question = { id: 'fc-q', moduleId: 'fc-m', type: 'input', prompt: 'strict', answer: '厳しい' };
const module = { id: 'fc-m', folderId: '', title: 'Cards', subject: 'English', questionIds: ['fc-q'] };
const settings = {
  shuffle: false,
  autoNext: true,
  autoRevealAfterIdle: true,
  questionLimit: 'all' as const,
  answerFormat: 'flashcard' as const,
  questionMode: 'mixed' as const
};

describe('flashcard core', () => {
  it.each(['as_stored', 'front_to_back', 'back_to_front'] as const)('uses presented text and semantic labels for %s', (mode) => {
    const question = presentQuestionForStudy(english, mode);
    const pair = getPresentedStudyPair(question);
    const reverse = mode === 'back_to_front';
    expect(pair).toEqual({
      front: { label: reverse ? '日本語' : '英語', text: reverse ? '厳しい' : 'strict' },
      back: { label: reverse ? '英語' : '日本語', text: reverse ? 'strict' : '厳しい' }
    });
  });
  it('honors a Japanese-to-English as-stored question rather than canonicalizing its direction', () => {
    expect(getPresentedStudyPair({ ...english, prompt: '厳しい', answer: 'strict' })).toEqual({
      front: { label: '日本語', text: '厳しい' },
      back: { label: '英語', text: 'strict' }
    });
  });
  it('uses explicit side labels and falls back for unrelated as-stored text', () => {
    const question: Question = {
      ...english,
      prompt: '別の問題',
      answer: '別の答え',
      sides: { front: { label: '語', text: '古語' }, back: { label: '意味', text: '現代語' } },
      supportedStudyModes: ['front_to_back', 'back_to_front']
    };
    expect(getPresentedStudyPair(presentQuestionForStudy(question, 'back_to_front'))).toEqual({
      front: { label: '意味', text: '現代語' },
      back: { label: '語', text: '古語' }
    });
    expect(getPresentedStudyPair(question)).toEqual({
      front: { label: '問題', text: '別の問題' },
      back: { label: '答え', text: '別の答え' }
    });
  });
  it('supports choice and multi-select fallback', () => {
    const choice: Question = { id: 'c', moduleId: module.id, type: 'choice', prompt: '国名', answer: 'A', choices: ['A', 'B'] };
    const multi: Question = { ...choice, type: 'multi_select', correctChoices: ['A', 'B'] };
    expect(getPresentedStudyPair(choice).back.text).toBe('A');
    expect(getPresentedStudyPair(multi).back.text).toBe('A / B');
  });
  it('restarts only missed cards without re-presenting or re-randomizing concrete mixed directions', () => {
    const other: Question = { ...english, id: 'fc-other', prompt: 'agree', answer: '賛成する' };
    const session = createSession({ ...module, questionIds: [english.id, other.id] }, [english, other], settings);
    session.attempts = session.queue.map((question, index) =>
      buildQuizAttempt(question, index ? 'wrong' : 'correct', '', 1000, 'normal', 'flashcard', 0)
    );
    session.index = 2;
    const random = vi.spyOn(Math, 'random');
    const again = restartFlashcardSession(session, true, 100);
    const all = restartFlashcardSession(session, false, 100);
    expect(random).not.toHaveBeenCalled();
    random.mockRestore();
    expect(again.queue).toEqual([session.queue[1]]);
    expect(again.queue[0]).toBe(session.queue[1]);
    expect(all.queue).toEqual(session.queue);
    expect(all).toMatchObject({ index: 0, attempts: [], startedAt: 100, sessionElapsedMs: 0, currentElapsedMs: 0 });
  });
  it.each([
    [0, 0, 100, false, 'flip'],
    [2, 1, 1, false, 'flip'],
    [9, 0, 100, false, 'none'],
    [0, 0, 500, false, 'none'],
    [0, 0, 100, true, 'none'],
    [105, 0, 1000, true, 'none'],
    [106, 0, 1000, true, 'known'],
    [-106, 0, 1000, true, 'again'],
    [68, 0, 100, true, 'none'],
    [69, 0, 100, true, 'known'],
    [-69, 0, 100, true, 'again'],
    [30, 100, 20, true, 'none']
  ] as const)('classifies gesture %j,%j,%j,%j as %s', (dx, dy, duration, moved, expected) => {
    expect(resolveFlashcardGesture(dx, dy, duration, moved)).toBe(expected);
  });
  it.each([100, 10000, 120000])('uses binary ratings and priorities independent of %dms study duration', (elapsed) => {
    expect(inferReviewRating('correct', elapsed, 'flashcard')).toBe('good');
    expect(inferReviewRating('wrong', elapsed, 'flashcard')).toBe('again');
    expect(scoreAttemptDelta('correct', false, elapsed, 'flashcard')).toBe(-2);
    expect(scoreAttemptDelta('wrong', true, elapsed, 'flashcard')).toBe(6);
    expect(scoreAttemptDelta('revealed', false, elapsed, 'flashcard')).toBe(10);
    expect(timingBand(elapsed, 'flashcard')).toBe('normal');
  });
  it('keeps card self-grades out of timing-based mistake tags', () => {
    const records = [
      buildQuizAttempt(english, 'wrong', '', 1, 'normal', 'flashcard', 0),
      buildQuizAttempt(english, 'wrong', '', 120000, 'normal', 'flashcard', 0),
      buildQuizAttempt(english, 'correct', '', 120000, 'normal', 'flashcard', 0)
    ];
    expect(answerModeFor(records[0])).toBe('flashcard');
    expect(analyzeProblems(records, [english])[0].mistakeTags.join()).not.toMatch(/即答ミス|長考して誤答|正解だが想起が遅い/);
  });
  it('persists flashcard self-grades in the same atomic attempt/SRS/backup path', async () => {
    const database = new LocalDatabase(`flashcard-srs-${crypto.randomUUID()}`);
    const store = new StudyRepository(database);
    try {
      await store.saveImportedPack({
        packVersion: 1,
        packId: 'cards-srs',
        title: 'Cards',
        folders: [],
        modules: [module],
        questions: [english]
      });
      const known = buildQuizAttempt(english, 'correct', '', 120000, 'normal', 'flashcard', 0);
      const again = buildQuizAttempt(english, 'wrong', '', 1, 'normal', 'flashcard', 0);
      await store.recordAnswer(known);
      await store.recordAnswer(again);
      expect((await store.getReviewLogsForQuestion(english.id)).map((log) => log.rating).sort()).toEqual(['again', 'good']);
      const backup = JSON.parse(JSON.stringify(await store.exportSnapshot()));
      await store.restoreSnapshot(backup, 'replace');
      expect(await store.getAttempts()).toEqual(expect.arrayContaining([known, again]));
    } finally {
      database.close();
    }
  });
  it('allows a module card default while keeping flashcard out of question types', () => {
    const pack: LoopDeckPack = {
      packVersion: 1,
      packId: 'cards',
      title: 'Cards',
      folders: [],
      modules: [{ ...module, preferredAnswerFormat: 'flashcard' }],
      questions: [english]
    };
    expect(validatePack(pack).ok).toBe(true);
    expect(validatePack({ ...pack, questions: [{ ...english, type: 'flashcard' }] }).ok).toBe(false);
  });
});
