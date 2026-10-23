// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { Attempt, ModuleInfo, Question, StudySettings } from '../src/core/models';
import { scoreAttemptDelta } from '../src/core/reviewEngine';
import { inferReviewRating } from '../src/core/scheduler';
import { createSession } from '../src/core/sessionEngine';
import { renderInlineQuiz } from '../src/screens/inlineQuiz';
import { parseAttempt } from '../src/storage/backupValidator';
import { sanitizeStudyPreferences } from '../src/storage/studyPreferences';
import { defaultStudySettings } from '../src/core/studySettings';
import type { QuizDataStore } from '../src/storage/storageTypes';

describe('confidence in scheduling', () => {
  it('never rates a guessed or unsure correct answer as easy', () => {
    expect(inferReviewRating('correct', 1000, 'choice')).toBe('easy');
    expect(inferReviewRating('correct', 1000, 'choice', 'unsure')).toBe('good');
    expect(inferReviewRating('correct', 1000, 'choice', 'guess')).toBe('hard');
    expect(inferReviewRating('wrong', 1000, 'choice', 'sure')).toBe('again');
    expect(inferReviewRating('correct', 1000, 'flashcard', 'guess')).toBe('good');
  });

  it('puts confident mistakes first and lifts lucky guesses', () => {
    expect(scoreAttemptDelta('wrong', false, 9000, 'choice', 'sure')).toBe(12);
    expect(scoreAttemptDelta('wrong', false, 9000, 'choice')).toBe(6);
    expect(scoreAttemptDelta('correct', false, 1000, 'choice', 'guess')).toBe(3);
    expect(scoreAttemptDelta('correct', false, 1000, 'choice')).toBe(-4);
  });

  it('keeps confidence in backups and preferences', () => {
    const attempt: Attempt = {
      attemptId: 'a',
      questionId: 'q',
      moduleId: 'm',
      answeredAt: new Date().toISOString(),
      result: 'wrong',
      input: 'x',
      answer: 'y',
      elapsedMs: 1,
      mode: 'normal',
      confidence: 'sure'
    };
    expect(parseAttempt(attempt, 0).confidence).toBe('sure');
    expect(() => parseAttempt({ ...attempt, confidence: 'maybe' }, 0)).toThrow();
    const module: ModuleInfo = { id: 'm', folderId: 'f', title: 'M', subject: 's', questionIds: [] };
    const settings = sanitizeStudyPreferences(defaultStudySettings(module), { askConfidence: true } as Partial<StudySettings>, {
      validRanges: ['all'],
      categories: [],
      questionModes: ['as_stored']
    });
    expect(settings.askConfidence).toBe(true);
  });
});

describe('confidence picker in the inline quiz', () => {
  const module: ModuleInfo = { id: 'm', folderId: 'f', title: 'M', subject: 's', questionIds: ['q'] };
  const question: Question = {
    id: 'q',
    moduleId: 'm',
    type: 'choice',
    prompt: '3B政策の本国側は？',
    choices: ['ベルリン', 'カイロ'],
    answer: 'ベルリン'
  };

  function render(askConfidence: boolean) {
    const saved: Attempt[] = [];
    const store: QuizDataStore = {
      recordAnswer: async (attempt) => {
        saved.push(attempt);
      },
      hasBookmark: async () => false,
      setBookmark: async () => {}
    };
    const container = document.createElement('div');
    document.body.append(container);
    const session = createSession(module, [question], { shuffle: false, autoNext: false, questionLimit: 'all', askConfidence }, 'normal', [
      question
    ]);
    renderInlineQuiz(container, session, { onSessionChange() {}, onComplete() {} }, { store });
    return { container, saved };
  }

  const settle = () => new Promise((resolve) => window.setTimeout(resolve, 50));

  it('is hidden unless the module asks for it', () => {
    expect(render(false).container.querySelector('.confidence-picker')).toBeNull();
  });

  it('starts at うろ覚え, records the chosen confidence and locks after answering', async () => {
    const { container, saved } = render(true);
    const options = [...container.querySelectorAll<HTMLButtonElement>('.confidence-option')];
    expect(options.map((option) => option.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false']);
    options[0].click();
    [...container.querySelectorAll<HTMLButtonElement>('.choice-btn')].find((item) => item.textContent?.startsWith('カイロ'))!.click();
    await settle();
    expect(saved[0]).toMatchObject({ result: 'wrong', confidence: 'sure', priorityDelta: 12 });
    expect(options.every((option) => option.disabled)).toBe(true);
  });

  it('does not record confidence when the answer is only revealed', async () => {
    const { container, saved } = render(true);
    container.querySelector<HTMLButtonElement>('button[aria-label="答えを見る"]')!.click();
    await settle();
    expect(saved[0].result).toBe('revealed');
    expect(saved[0].confidence).toBeUndefined();
  });
});
