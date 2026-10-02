// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Attempt, InputQuestion, LoopDeckPack, StudySettings } from '../src/core/models';
import { judgeQuestion, isNearMissAnswer } from '../src/core/answerJudge';
import { buildGeneratedChoiceOptions } from '../src/core/choiceGenerator';
import { buildAnalyticsOverview, buildMistakeBreakdown } from '../src/core/analyticsEngine';
import { analyzeProblems, getWrongQuestionIds, summarizeWeakModules } from '../src/core/reviewEngine';
import { createSession, filterStudyQuestions } from '../src/core/sessionEngine';
import { encodeStudyCategory } from '../src/core/studyCategory';
import { getSupportedStudyQuestionModes } from '../src/core/questionPresentation';
import { buildWrongAnswerFeedback } from '../src/core/wrongAnswerExplanation';
import { validatePack } from '../src/packs/packValidator';
import { loadBuiltinPacks } from '../src/packs/builtinLoader';
import { resolveActivePacks } from '../src/packs/packResolver';
import { renderHomeScreen } from '../src/screens/homeScreen';
import { disposeInlineQuizzes, renderInlineQuiz } from '../src/screens/inlineQuiz';
import { db } from '../src/storage/db';
import { readStudyPreferences, studyPreferencesKey, writeStudyPreferences } from '../src/storage/studyPreferences';
import { createJapaneseToEnglishWorksheetPlan } from '../src/pdf/worksheetPlanner';

const q: InputQuestion = { id: 'q', moduleId: 'm', type: 'input', prompt: 'Prompt', answer: 'dog' };
const settings: StudySettings = { shuffle: false, autoNext: false, questionLimit: 'all', answerFormat: 'input' };
function pack(question = q): LoopDeckPack {
  return {
    packVersion: 1,
    packId: 'audit-contracts',
    title: 'Audit',
    folders: [],
    modules: [{ id: question.moduleId, folderId: '', title: 'Module', subject: 'Test', questionIds: [question.id] }],
    questions: [question]
  };
}
const attempt: Attempt = {
  attemptId: 'a',
  questionId: 'q',
  moduleId: 'm',
  answeredAt: '2026-10-02T00:00:00Z',
  result: 'wrong',
  input: 'x',
  answer: 'dog',
  elapsedMs: 1000,
  mode: 'normal'
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function quiz(autoNext = false, question = q) {
  const container = document.createElement('div');
  document.body.append(container);
  const callbacks = { onSessionChange: vi.fn(), onSessionCheckpoint: vi.fn(), onComplete: vi.fn() };
  const data = pack(question);
  const session = createSession(data.modules[0], [question], { ...settings, autoNext });
  renderInlineQuiz(container, session, callbacks);
  return { container, callbacks };
}
beforeEach(() => {
  localStorage.clear();
  vi.spyOn(db, 'hasBookmark').mockResolvedValue(false);
  vi.spyOn(db, 'getReviewCard').mockResolvedValue(undefined);
  vi.spyOn(db, 'saveAttemptWithReview').mockResolvedValue();
});
afterEach(() => {
  disposeInlineQuizzes(document.body);
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('answer and pack contracts from the static audit', () => {
  it.each([2, 3])('honors an authored %i-option choice set', (count) => {
    const question: InputQuestion = { ...q, choiceCandidates: { mode: 'manual', choices: ['dog', 'cat', 'bird'].slice(0, count) } };
    const choices = buildGeneratedChoiceOptions(question, [question], count, () => 0);
    expect(choices).toHaveLength(count);
    expect(new Set(choices!.map((choice) => choice.text))).toEqual(new Set(question.choiceCandidates!.choices));
  });
  it('rejects directional choices that omit that side of the study pair', () => {
    const question: InputQuestion = {
      ...q,
      sides: { front: { label: 'English', text: 'dog' }, back: { label: 'Japanese', text: '犬' } },
      sideChoiceCandidates: { back_to_front: { mode: 'manual', choices: ['cat', 'bird'] } }
    };
    expect(validatePack(pack(question)).ok).toBe(false);
  });
  it('preserves distinct case-sensitive aliases and does not call a case mismatch a typo', () => {
    const question = { ...q, answer: 'US', acceptableAnswers: ['us'], answerJudging: { caseSensitive: true } };
    expect(judgeQuestion(question, 'US')).toBe(true);
    expect(judgeQuestion(question, 'us')).toBe(true);
    expect(judgeQuestion(question, 'Us')).toBe(false);
    expect(isNearMissAnswer(question, 'Us')).toBe(false);
  });
  it('ignores internal Unicode punctuation when configured', () => {
    expect(judgeQuestion({ ...q, answer: 'ab', answerJudging: { ignorePunctuation: true } }, 'a—b')).toBe(true);
  });
  it.each([
    { ...q, number: 0 },
    { ...q, number: 1.5 },
    { ...q, answerJudging: { mode: 'all_of' as const, requiredParts: [] } },
    { ...q, type: 'choice' as const, choices: ['dog', 'hot dog', 'cat'] },
    { ...q, type: 'choice' as const, choices: ['dog', 'cat', 'CAT'] },
    { ...q, type: 'multi_select' as const, choices: ['A', 'a'], correctChoices: ['A'] },
    { ...q, type: 'choice' as const, choices: ['dog', 'cat'], supportedStudyModes: ['front_to_back' as const] }
  ])('rejects unsafe question shape %#', (question) => {
    const data = pack();
    data.questions = [question];
    expect(validatePack(data).ok).toBe(false);
  });
  it('rejects duplicate effective question numbers within a module', () => {
    const data = pack({ ...q, number: 2 });
    data.questions.push({ ...q, id: 'q2' });
    data.modules[0].questionIds.push('q2');
    expect(validatePack(data).ok).toBe(false);
  });
  it('keeps native choice questions out of unsupported reverse sessions', () => {
    expect(
      getSupportedStudyQuestionModes({ ...q, type: 'choice', choices: ['dog', 'cat'], supportedStudyModes: ['front_to_back'] })
    ).toEqual(['as_stored']);
  });
  it('falls back to input when all candidate distractors satisfy the judge', () => {
    expect(buildGeneratedChoiceOptions(q, [q, { ...q, id: 'd', answer: 'hot dog' }])).toBeUndefined();
  });
  it('does not trust a forged origin with an unrelated selected answer', () => {
    const other = { ...q, id: 'other', answer: 'cat' };
    expect(
      buildWrongAnswerFeedback('choice', 'fish', q, [q, other], undefined, { questionId: 'other', moduleId: 'm', studyMode: 'as_stored' })
    ).toMatchObject({ matchKind: 'not_found' });
  });
  it('normalizes authored folder references and categories consistently', () => {
    const data = pack({ ...q, category: '  A  ' });
    data.folders = [{ id: ' folder ', title: 'Folder' }];
    data.modules[0].folderId = 'folder';
    const result = validatePack(data);
    expect(result.ok).toBe(true);
    expect(result.pack!.folders[0].id).toBe('folder');
    expect(result.pack!.questions[0].category).toBe('A');
  });
});
describe('settings and aggregation contracts', () => {
  it('orders repeated mistakes by their latest occurrence', () => {
    expect(getWrongQuestionIds([attempt, { ...attempt, questionId: 'q2' }, attempt])).toEqual(['q', 'q2']);
  });
  it('preserves PDF source positions across skipped, selected and legacy fractional rows', () => {
    const data = pack();
    data.modules[0].questionIds = ['skipped', 'q', 'third'];
    const question: InputQuestion = { ...q, prompt: '犬', number: 1.5 };
    expect(createJapaneseToEnglishWorksheetPlan(data.modules[0], [question], false).rows[0].sourceNumber).toBe(2);
    expect(
      createJapaneseToEnglishWorksheetPlan(data.modules[0], [{ ...question, id: 'third', number: undefined }], false).rows[0].sourceNumber
    ).toBe(3);
  });
  it('persists authored other and fallback shelves independently', () => {
    const data = pack();
    data.folders = [{ id: 'other', title: 'Authored' }];
    data.modules[0].folderId = 'other';
    data.modules.push({ ...data.modules[0], id: 'unfiled', title: 'Unfiled', folderId: '', questionIds: ['q2'] });
    data.questions.push({ ...q, id: 'q2', moduleId: 'unfiled' });
    const root = document.createElement('div');
    const render = () =>
      renderHomeScreen(
        root,
        resolveActivePacks([data]),
        () => {},
        () => {},
        () => {},
        () => {}
      );
    render();
    root.querySelector<HTMLButtonElement>('.folder-head')!.click();
    render();
    expect([...root.querySelectorAll('.folder-head')].map((head) => head.getAttribute('aria-expanded'))).toEqual(['false', 'true']);
  });
  it('selects a literal all category independently of the all-categories sentinel', () => {
    const questions = [
      { ...q, category: 'all' },
      { ...q, id: 'q2', category: 'A' }
    ];
    expect(filterStudyQuestions(questions, { ...settings, selectedCategory: encodeStudyCategory('all') })).toEqual([questions[0]]);
    expect(filterStudyQuestions(questions, { ...settings, selectedCategory: 'all' })).toEqual(questions);
  });
  it('keeps colon-containing pack and module identity pairs independent', () => {
    expect(studyPreferencesKey('a:b', 'c')).not.toBe(studyPreferencesKey('a', 'b:c'));
    writeStudyPreferences('a:b', 'c', { ...settings, shuffle: true });
    writeStudyPreferences('a', 'b:c', settings);
    expect(readStudyPreferences('a:b', 'c')?.shuffle).toBe(true);
    expect(readStudyPreferences('a', 'b:c')?.shuffle).toBe(false);
  });
  it('migrates unambiguous v1 settings but ignores ambiguous legacy identities', () => {
    const value = JSON.stringify({ version: 1, settings: { selectedCategory: 'A' } });
    localStorage.setItem('loopdeck3_study_prefs_v1_p:m', value);
    expect(readStudyPreferences('p', 'm')?.selectedCategory).toBe(encodeStudyCategory('A'));
    localStorage.setItem('loopdeck3_study_prefs_v1_a:b:c', value);
    expect(readStudyPreferences('a:b', 'c')).toBeUndefined();
  });
  it.each(['constructor', '__proto__', 'toString'])('counts module %s safely across summaries', (moduleId) => {
    const record = { ...attempt, moduleId };
    expect(summarizeWeakModules([record])[moduleId]).toBe(1);
    expect(buildAnalyticsOverview([record], [], [{ ...q, moduleId }]).mistakeBreakdown.find((x) => x.id === 'wrong')?.count).toBe(1);
  });
  it.each([
    { input: ['A'], elapsedMs: 6000, result: 'wrong' as const, tag: 'quick_wrong', expected: false },
    { input: ['A'], elapsedMs: 15000, result: 'correct' as const, tag: 'slow_correct', expected: true },
    { input: 'A', elapsedMs: 15000, result: 'correct' as const, tag: 'slow_correct', expected: false }
  ])('uses the same legacy timing policy in both analytics implementations %#', ({ input, elapsedMs, result, tag, expected }) => {
    const record = { ...attempt, input, elapsedMs, result };
    const breakdown = buildMistakeBreakdown([record], [q]);
    expect(breakdown.some((x) => x.id === tag)).toBe(expected);
    expect(buildAnalyticsOverview([record], [], [q]).mistakeBreakdown).toEqual(breakdown);
    if (tag === 'slow_correct') expect(analyzeProblems([record], [q])[0].mistakeTags.includes('正解だが想起が遅い')).toBe(expected);
  });
  it('shows an imported reverse-style module ID on Home', () => {
    const root = document.createElement('div');
    renderHomeScreen(
      root,
      resolveActivePacks([pack({ ...q, moduleId: 'english_reverse' })]),
      () => {},
      () => {},
      () => {},
      () => {}
    );
    expect(root.querySelector('.module-card')).not.toBeNull();
  });
});
describe('quiz asynchronous ownership', () => {
  it.each(['leap', 'leap_final'])('does not opt imported module %s into automatic choices', (moduleId) => {
    const questions = ['dog', 'cat', 'bird', 'fish'].map((answer, index) => ({ ...q, id: 'q' + index, moduleId, answer }));
    const module = { ...pack().modules[0], id: moduleId, questionIds: questions.map((question) => question.id) };
    const session = createSession(module, questions, { ...settings, answerFormat: 'auto' });
    const container = document.createElement('div');
    renderInlineQuiz(container, session, { onSessionChange() {}, onComplete() {} });
    expect(container.querySelector('input.text-input')).not.toBeNull();
    expect(container.querySelectorAll('.choice-btn')).toHaveLength(0);
    disposeInlineQuizzes(container);
  });
  it('reports an explicit choice format fallback and excludes accepted legacy distractors', () => {
    const container = document.createElement('div');
    const session = createSession(pack().modules[0], [{ ...q, type: 'choice', choices: ['dog', 'hot dog'] }], {
      ...settings,
      answerFormat: 'choice'
    });
    renderInlineQuiz(container, session, { onSessionChange() {}, onComplete() {} });
    expect(container.querySelector('input.text-input')).not.toBeNull();
    expect(container.querySelector('.notice')?.textContent).toContain('選択肢が不足');
    disposeInlineQuizzes(container);
  });
  it('ignores a stale bookmark read after the same mount renders a newer question', async () => {
    const read = deferred<boolean>();
    vi.spyOn(db, 'hasBookmark').mockReturnValueOnce(read.promise);
    const { container } = quiz();
    renderInlineQuiz(container, createSession(pack().modules[0], [{ ...q, id: 'new' }], settings), {
      onSessionChange() {},
      onComplete() {}
    });
    await vi.waitFor(() => expect(container.querySelector<HTMLButtonElement>('.bookmark-btn')!.disabled).toBe(false));
    read.resolve(true);
    await read.promise;
    expect(container.querySelector('.bookmark-btn')!.classList.contains('selected')).toBe(false);
  });
  it('cancels an already scheduled auto-next when the route leaves the quiz', async () => {
    const { container, callbacks } = quiz(true);
    container.querySelector<HTMLInputElement>('input')!.value = 'dog';
    [...container.querySelectorAll('button')].find((b) => b.textContent === '回答する')!.click();
    await vi.waitFor(() => expect(callbacks.onSessionCheckpoint).toHaveBeenCalledTimes(1));
    disposeInlineQuizzes(container);
    container.remove();
    window.dispatchEvent(new Event('pagehide'));
    await new Promise((resolve) => setTimeout(resolve, 750));
    expect(callbacks.onSessionCheckpoint).toHaveBeenCalledTimes(1);
    expect(callbacks.onSessionChange).not.toHaveBeenCalled();
  });
  it('disables bookmark toggles until the initial read completes and rolls back failed writes', async () => {
    const read = deferred<boolean>();
    vi.spyOn(db, 'hasBookmark').mockReturnValue(read.promise);
    const write = vi.spyOn(db, 'setBookmark').mockRejectedValue(new Error('disk full'));
    const { container } = quiz();
    const bookmark = container.querySelector<HTMLButtonElement>('.bookmark-btn')!;
    bookmark.click();
    expect(write).not.toHaveBeenCalled();
    expect(bookmark.disabled).toBe(true);
    read.resolve(true);
    await vi.waitFor(() => expect(bookmark.disabled).toBe(false));
    bookmark.click();
    await vi.waitFor(() => expect(bookmark.disabled).toBe(false));
    expect(bookmark.classList.contains('selected')).toBe(true);
    expect(write).toHaveBeenCalledWith('q', false);
  });
  it('does not let an old save completion checkpoint or advance a disposed quiz', async () => {
    const save = deferred<void>();
    vi.spyOn(db, 'saveAttemptWithReview').mockReturnValue(save.promise);
    const { container, callbacks } = quiz(true);
    container.querySelector<HTMLInputElement>('input')!.value = 'dog';
    [...container.querySelectorAll('button')].find((b) => b.textContent === '回答する')!.click();
    await vi.waitFor(() => expect(db.saveAttemptWithReview).toHaveBeenCalledTimes(1));
    disposeInlineQuizzes(container);
    save.resolve();
    await new Promise((resolve) => setTimeout(resolve, 750));
    expect(callbacks.onSessionCheckpoint).not.toHaveBeenCalled();
    expect(callbacks.onSessionChange).not.toHaveBeenCalled();
  });
  it('does not disclose the answer explanation through the hint button', () => {
    const { container } = quiz(false, { ...q, explanation: 'The answer is dog.' });
    expect(container.querySelector<HTMLButtonElement>('[aria-label="ヒント"]')!.disabled).toBe(true);
    expect(container.querySelector('.hint-panel')).toBeNull();
    const leap = loadBuiltinPacks()[0].questions.filter((question) => question.moduleId === 'leap');
    expect(leap).toHaveLength(200);
    expect(leap.every((question) => question.example && !question.explanation)).toBe(true);
  });
});
