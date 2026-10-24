// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { countReadingChars, timingThresholds } from '../src/core/answerTiming';
import type { Attempt, ModuleInfo, Question } from '../src/core/models';
import { buildReviewPersistence } from '../src/core/reviewPersistence';
import {
  applyReviewRating,
  canReviseReviewRating,
  correctRatingIntervals,
  createReviewCard,
  inferReviewRating,
  reviseReviewRating
} from '../src/core/scheduler';
import { createSession } from '../src/core/sessionEngine';
import { renderInlineQuiz } from '../src/screens/inlineQuiz';
import type { QuizDataStore, SavedReview } from '../src/storage/storageTypes';
import { studyStore } from '../src/storage/studyRepository';
import { describeInterval } from '../src/ui/inlineQuizView';

const NOW = new Date('2026-10-24T09:00:00Z');

describe('speed-based rating', () => {
  it('gives long prompts and choices more time before calling an answer slow', () => {
    const short = timingThresholds('choice', 20);
    const long = timingThresholds('choice', 150);
    expect(short).toEqual({ fast: 4500, slow: 12000 });
    expect(long.fast).toBeGreaterThan(short.fast);
    expect(long.slow).toBeGreaterThan(short.slow);
    expect(inferReviewRating('correct', 13000, 'choice', undefined, { readingChars: 20 })).toBe('hard');
    expect(inferReviewRating('correct', 13000, 'choice', undefined, { readingChars: 150 })).toBe('good');
  });

  it('counts the visible text without spaces', () => {
    expect(countReadingChars('ab c', ['de', ' f '])).toBe(6);
  });

  it('never calls a first-sight multiple-choice pick easy, but keeps easy for recall', () => {
    expect(inferReviewRating('correct', 1000, 'choice', undefined, { firstReview: true })).toBe('good');
    expect(inferReviewRating('correct', 1000, 'choice', undefined, { firstReview: false })).toBe('easy');
    expect(inferReviewRating('correct', 1000, 'input', undefined, { firstReview: true })).toBe('easy');
  });

  it('treats a correct answer after the hint like a guess', () => {
    expect(inferReviewRating('correct', 1000, 'input', undefined, { hintUsed: true })).toBe('hard');
  });

  it('rates the first answer of a new card through buildReviewPersistence', () => {
    const attempt: Attempt = {
      attemptId: 'a1',
      questionId: 'q',
      moduleId: 'm',
      answeredAt: NOW.toISOString(),
      result: 'correct',
      input: 'x',
      answer: 'x',
      elapsedMs: 1200,
      mode: 'normal',
      answerMode: 'choice'
    };
    expect(buildReviewPersistence(attempt).log.rating).toBe('good');
  });
});

describe('re-rating a correct answer', () => {
  function answered(rating: 'good' | 'again' = 'good') {
    let card = createReviewCard('q', 'm', NOW);
    card = applyReviewRating(card, 'good', 'correct', 2000, { now: new Date('2026-10-20T09:00:00Z') }).card;
    return applyReviewRating(card, rating, rating === 'again' ? 'wrong' : 'correct', 2000, { now: NOW });
  }

  it('recomputes ease, interval and due date from the log and keeps every counter', () => {
    const { card, log } = answered();
    const revised = reviseReviewRating(card, log, 'easy', NOW);
    expect(revised.log.rating).toBe('easy');
    expect(revised.card.ease).toBeCloseTo(log.previousEase + 0.15);
    expect(revised.card.intervalDays).toBe(correctRatingIntervals(log).easy);
    expect(revised.card.intervalDays).toBeGreaterThan(card.intervalDays);
    expect(Date.parse(revised.card.dueAt!) - NOW.getTime()).toBe(revised.card.intervalDays * 86_400_000);
    expect(revised.card).toMatchObject({
      totalReviews: card.totalReviews,
      totalCorrect: card.totalCorrect,
      correctStreak: card.correctStreak,
      leechLevel: card.leechLevel
    });
    // Choosing the original rating again restores the original schedule.
    expect(reviseReviewRating(revised.card, revised.log, 'good', NOW).card).toMatchObject({
      ease: card.ease,
      intervalDays: card.intervalDays,
      dueAt: card.dueAt
    });
  });

  it('refuses a wrong answer and a card reviewed again since', () => {
    const wrong = answered('again');
    expect(canReviseReviewRating(wrong.card, wrong.log)).toBe(false);
    const { card, log } = answered();
    const later = applyReviewRating(card, 'good', 'correct', 2000, { now: new Date('2026-10-30T09:00:00Z') }).card;
    expect(canReviseReviewRating(later, log)).toBe(false);
    expect(() => reviseReviewRating(later, log, 'easy')).toThrow();
  });

  it('describes intervals in plain words', () => {
    expect([0, 1, 4, 61].map(describeInterval)).toEqual(['今日中', '明日', '4日後', '約2か月後']);
  });

  it('saves the revised rating in IndexedDB', async () => {
    const attempt: Attempt = {
      attemptId: `qol-${Math.random()}`,
      questionId: 'qol-q',
      moduleId: 'qol-m',
      answeredAt: NOW.toISOString(),
      result: 'correct',
      input: 'x',
      answer: 'x',
      elapsedMs: 9000,
      mode: 'normal',
      answerMode: 'input'
    };
    const saved = await studyStore.recordAnswer(attempt);
    expect(saved).toMatchObject({ log: { rating: 'good' } });
    const revised = await studyStore.reviseAnswerRating(attempt.attemptId, 'hard');
    expect(revised.log.rating).toBe('hard');
    const card = (await studyStore.getReviewCards()).find((row) => row.questionId === 'qol-q');
    expect(card?.intervalDays).toBe(revised.card.intervalDays);
    expect((await studyStore.getReviewLogs()).find((row) => row.reviewLogId === `answer:${attempt.attemptId}`)?.rating).toBe('hard');
  });
});

describe('answering without friction', () => {
  const module: ModuleInfo = { id: 'm', title: 'Module', folderId: '', subject: 'Test', questionIds: ['q1', 'q2'] };
  const first: Question = {
    id: 'q1',
    moduleId: 'm',
    type: 'choice',
    prompt: 'Capital of France?',
    choices: ['Rome', 'Berlin', 'Madrid'],
    answer: 'Paris'
  };
  const second: Question = {
    id: 'q2',
    moduleId: 'm',
    type: 'choice',
    prompt: 'Capital of Japan?',
    choices: ['Osaka', 'Kyoto'],
    answer: 'Tokyo'
  };
  const settle = () => new Promise((resolve) => window.setTimeout(resolve, 50));

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  function render(autoNext = false) {
    const reviews = new Map<string, SavedReview>();
    const store: QuizDataStore = {
      recordAnswer: async (attempt) => {
        const review = buildReviewPersistence(attempt);
        reviews.set(attempt.attemptId, review);
        return review;
      },
      reviseAnswerRating: vi.fn(async (attemptId, rating) => {
        const review = reviews.get(attemptId)!;
        return reviseReviewRating(review.card, review.log, rating);
      }),
      hasBookmark: async () => false,
      setBookmark: async () => {}
    };
    const container = document.createElement('div');
    document.body.append(container);
    const changes: unknown[] = [];
    const session = createSession(module, [first, second], { shuffle: false, autoNext, questionLimit: 'all' }, 'normal', [first, second]);
    renderInlineQuiz(container, session, { onSessionChange: (next) => changes.push(next), onComplete() {} }, { store });
    return { container, store, changes };
  }

  it('does not always put the answer first among the options', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const { container } = render();
    const options = [...container.querySelectorAll('.choice-btn')].map((option) => option.textContent);
    expect(options).toHaveLength(4);
    expect(options[0]).not.toBe('Paris');
    expect(options).toContain('Paris');
  });

  it('shows when the card returns and lets the learner correct the feel in one tap', async () => {
    const { container, store } = render();
    [...container.querySelectorAll<HTMLButtonElement>('.choice-btn')].find((option) => option.textContent === 'Paris')!.click();
    await settle();
    expect(container.querySelector('.result')?.textContent).not.toMatch(/秒/);
    const schedule = container.querySelector('.review-schedule')!;
    expect(schedule.textContent).toContain('次の復習は');
    const choices = [...schedule.querySelectorAll<HTMLButtonElement>('.rating-choice')];
    expect(choices.map((choice) => choice.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false']);
    choices[0].click();
    await settle();
    expect(store.reviseAnswerRating).toHaveBeenCalledWith(expect.any(String), 'hard');
    expect(choices.map((choice) => choice.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false']);
  });

  it('offers no correction after a wrong answer', async () => {
    const { container } = render();
    [...container.querySelectorAll<HTMLButtonElement>('.choice-btn')].find((option) => option.textContent !== 'Paris')!.click();
    await settle();
    expect(container.querySelector('.review-schedule')?.textContent).toContain('10分後から復習に並びます');
    expect(container.querySelector('.rating-choice')).toBeNull();
  });

  it('answers with number keys and moves on with Enter', async () => {
    const { container, changes } = render();
    const options = [...container.querySelectorAll<HTMLButtonElement>('.choice-btn')];
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '2', bubbles: true }));
    expect(options[1].classList.contains('is-picked') || options[1].disabled).toBe(true);
    await settle();
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(changes).toHaveLength(1);
  });

  it('waits for the learner once they touch the answered card', async () => {
    const { container, changes } = render(true);
    [...container.querySelectorAll<HTMLButtonElement>('.choice-btn')].find((option) => option.textContent === 'Paris')!.click();
    await settle();
    const next = container.querySelector<HTMLButtonElement>('.prototype-next-ready')!;
    expect(next.classList.contains('is-auto-advancing')).toBe(true);
    container.querySelector('.result')!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(next.classList.contains('is-auto-advancing')).toBe(false);
    await new Promise((resolve) => window.setTimeout(resolve, 1600));
    expect(changes).toHaveLength(0);
  });
});
