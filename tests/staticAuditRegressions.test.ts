import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import type { Attempt, InputQuestion, LoopDeckPack, StudySettings } from '../src/core/models';
import { studyStore } from '../src/storage/studyRepository';
import { validatePack } from '../src/packs/packValidator';
import { resolveActivePacks } from '../src/packs/packResolver';
import { buildHomeFolders } from '../src/screens/homeFolders';
import { aggregateReviewAttempts } from '../src/core/reviewEngine';
import { judgeQuestion } from '../src/core/answerJudge';
import { buildGeneratedChoiceOptions } from '../src/core/choiceGenerator';
import { buildRangeOptions, filterStudyQuestions } from '../src/core/sessionEngine';
import { buildWorksheetRangeOptions, filterWorksheetQuestionsByRange } from '../src/pdf/worksheetSelection';

const question = (id: string, answer = 'dog', moduleId = 'm'): InputQuestion => ({ id, moduleId, type: 'input', prompt: 'prompt', answer });
const settings: StudySettings = { shuffle: false, autoNext: false, questionLimit: 'all' };
function pack(id: string): LoopDeckPack {
  return {
    packVersion: 1,
    packId: id,
    title: id,
    folders: [],
    modules: [{ id: 'm', title: id, subject: 'test', folderId: '', questionIds: [id + '-q'] }],
    questions: [question(id + '-q')]
  };
}

describe('static audit regressions', () => {
  it('newly imported pack overrides the older module regardless of packId sorting', async () => {
    await studyStore.saveImportedPack(pack('z-old'));
    await studyStore.saveImportedPack(pack('a-new'));
    const loaded = await studyStore.getImportedPacks();
    expect(loaded.map((p) => p.packId)).toEqual(['z-old', 'a-new']);
    expect(resolveActivePacks(loaded).modulePackIdById.get('m')).toBe('a-new');
  });

  it('valid constructor module id produces numeric weak-module count', () => {
    const raw = pack('p');
    raw.modules[0].id = 'constructor';
    raw.questions[0].moduleId = 'constructor';
    expect(validatePack(raw).ok).toBe(true);
    const attempt: Attempt = {
      attemptId: 'a',
      questionId: 'p-q',
      moduleId: 'constructor',
      answeredAt: '2026-10-02T00:00:00Z',
      result: 'wrong',
      input: 'x',
      answer: 'dog',
      elapsedMs: 1000,
      mode: 'normal'
    };
    expect(aggregateReviewAttempts([attempt]).weakModules.constructor).toBe(1);
  });

  it('authored other folder and fallback folder have independent identities', () => {
    const raw = pack('p');
    raw.folders = [{ id: 'other', title: 'Authored folder' }];
    raw.modules[0].folderId = 'other';
    raw.modules.push({ id: 'unfiled', title: 'Unfiled', subject: 'test', folderId: '', questionIds: ['unfiled-q'] });
    raw.questions.push(question('unfiled-q', 'cat', 'unfiled'));
    const validated = validatePack(raw);
    expect(validated.ok).toBe(true);
    const folders = buildHomeFolders([validated.pack!], validated.pack!.modules);
    expect(folders).toHaveLength(2);
    expect(new Set(folders.map((f) => JSON.stringify([f.kind, f.id]))).size).toBe(2);
  });

  it('case-sensitive single judging accepts the exact uppercase primary answer', () => {
    const q = { ...question('q', 'US'), answerJudging: { mode: 'single' as const, caseSensitive: true } };
    expect(validatePack({ ...pack('p'), questions: [q], modules: [{ ...pack('p').modules[0], questionIds: ['q'] }] }).ok).toBe(true);
    expect(judgeQuestion(q, 'US')).toBe(true);
  });

  it('generated distractor is actually wrong under the current judge', () => {
    const q = question('q');
    const options = buildGeneratedChoiceOptions(
      q,
      [q, question('d', 'hot dog'), question('c', 'cat'), question('f', 'fish'), question('b', 'bird')],
      4,
      () => 0
    );
    expect(options).toHaveLength(4);
    expect(options!.some((option) => option.text === 'hot dog')).toBe(false);
    for (const option of options!) expect(judgeQuestion(q, option.text)).toBe(option.kind === 'correct');
  });

  it('combined bookmark filter and numeric range retain original unnumbered ordinals (API path)', () => {
    const questions = Array.from({ length: 30 }, (_, index) => question('q' + (index + 1)));
    expect(
      filterStudyQuestions(
        questions,
        { ...settings, selectedRange: '26-30', filter: 'bookmarked' },
        { bookmarkedQuestionIds: ['q26'] }
      ).map((q) => q.id)
    ).toEqual(['q26']);
  });
});

describe('audit: correction of existing Issue #106 claims', () => {
  it('two sparse worksheet questions do not create 41 PDF range options', () => {
    const questions = [
      { ...question('q1'), number: 1 },
      { ...question('q2'), number: 1000 }
    ];
    expect(buildWorksheetRangeOptions(questions)).toHaveLength(1);
    expect(buildRangeOptions(questions)).toHaveLength(3);
  });
  it('legacy same-number worksheet questions remain selectable as separate chunks', () => {
    const questions = Array.from({ length: 26 }, (_, i) => ({ ...question('q' + i), number: 1 }));
    const options = buildWorksheetRangeOptions(questions);
    expect(new Set(options.map((option) => option.value)).size).toBe(3);
    expect(filterWorksheetQuestionsByRange(questions, options[1].value)).toEqual(questions.slice(0, 25));
    expect(filterWorksheetQuestionsByRange(questions, options[2].value)).toEqual(questions.slice(25));
  });
});
