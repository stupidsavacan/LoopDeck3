import { describe, expect, it } from 'vitest';
import type { ReviewCard } from '../src/core/models';
import {
  applyReviewRating,
  bucketReviewCards,
  buildSrsReviewQueue,
  clampEase,
  createReviewCard,
  inferReviewRating
} from '../src/core/scheduler';

const now = new Date('2026-06-05T09:00:00.000Z');

function card(overrides: Partial<ReviewCard> = {}): ReviewCard {
  return { ...createReviewCard('q1', 'm1', now), ...overrides };
}

describe('SRS scheduler', () => {
  it('new card + good becomes review with dueAt and intervalDays >= 1', () => {
    const result = applyReviewRating(card(), 'good', 'correct', 9000, { now });

    expect(result.card.state).toBe('review');
    expect(result.card.dueAt).toBeTruthy();
    expect(result.card.intervalDays).toBeGreaterThanOrEqual(1);
    expect(result.log.previousState).toBe('new');
    expect(result.log.nextState).toBe('review');
  });

  it('new card + again becomes relearning', () => {
    const result = applyReviewRating(card(), 'again', 'wrong', 3000, { now });

    expect(result.card.state).toBe('relearning');
    expect(result.card.totalWrong).toBe(1);
    expect(result.card.correctStreak).toBe(0);
    expect(result.card.dueAt).toBe('2026-06-05T09:10:00.000Z');
  });

  it('review card + again increments lapseCount', () => {
    const result = applyReviewRating(card({ state: 'review', intervalDays: 10, lapseCount: 0 }), 'again', 'wrong', 3000, { now });

    expect(result.card.lapseCount).toBe(1);
    expect(result.card.state).toBe('relearning');
  });

  it('hard lowers ease', () => {
    const result = applyReviewRating(card({ ease: 2.5, intervalDays: 5 }), 'hard', 'correct', 21000, { now });

    expect(result.card.ease).toBeCloseTo(2.35);
    expect(result.card.intervalDays).toBeGreaterThanOrEqual(6);
  });

  it('easy raises ease', () => {
    const result = applyReviewRating(card({ ease: 2.5 }), 'easy', 'correct', 2000, { now });

    expect(result.card.ease).toBeCloseTo(2.65);
    expect(result.card.intervalDays).toBeGreaterThanOrEqual(3);
  });

  it('clamps ease between 1.3 and 3.0', () => {
    expect(clampEase(0.5)).toBe(1.3);
    expect(clampEase(9)).toBe(3.0);
  });

  it('historical totalWrong alone does not make leech permanent', () => {
    const result = applyReviewRating(card({ totalWrong: 4 }), 'again', 'wrong', 1000, { now });

    expect(result.card.totalWrong).toBe(5);
    expect(result.card.leechLevel).toBe(1);
    expect(result.card.state).toBe('relearning');
  });

  it('recent repeated failures create a recoverable leech state', () => {
    const result = applyReviewRating(card({ wrongStreak: 2, totalWrong: 2, leechLevel: 2 }), 'again', 'wrong', 1000, { now });

    expect(result.card.wrongStreak).toBe(3);
    expect(result.card.leechLevel).toBe(3);
    expect(result.card.state).toBe('leech');
  });

  it('a correct answer releases a leech even when historical counters stay high', () => {
    const result = applyReviewRating(
      card({ state: 'leech', leechLevel: 3, totalWrong: 12, lapseCount: 7, wrongStreak: 3 }),
      'good',
      'correct',
      9000,
      { now }
    );

    expect(result.card.totalWrong).toBe(12);
    expect(result.card.lapseCount).toBe(7);
    expect(result.card.leechLevel).toBe(2);
    expect(result.card.state).toBe('review');
  });

  it('treats legacy learning cards as relearning in the due buckets', () => {
    const learning = card({ state: 'relearning', dueAt: now.toISOString() });
    const buckets = bucketReviewCards([learning], now);

    expect(buckets.relearning.map((item) => item.questionId)).toEqual(['q1']);
  });

  it('mastered conditions create mastered', () => {
    const result = applyReviewRating(card({ correctStreak: 4, intervalDays: 12, lapseCount: 0 }), 'good', 'correct', 7000, { now });

    expect(result.card.correctStreak).toBe(5);
    expect(result.card.intervalDays).toBeGreaterThanOrEqual(30);
    expect(result.card.state).toBe('mastered');
  });

  it('historical lapses do not permanently block mastery', () => {
    const result = applyReviewRating(
      card({ state: 'review', correctStreak: 4, intervalDays: 12, lapseCount: 7 }),
      'good',
      'correct',
      7000,
      { now }
    );

    expect(result.card.lapseCount).toBe(7);
    expect(result.card.state).toBe('mastered');
  });

  it('suspended cards are excluded from due queue', () => {
    const dueCard = card({ state: 'review', dueAt: now.toISOString(), intervalDays: 1 });
    const suspended = card({ questionId: 'q2', state: 'review', suspended: true, dueAt: now.toISOString(), intervalDays: 1 });

    expect(buildSrsReviewQueue([dueCard, suspended], now).map((item) => item.questionId)).toEqual(['q1']);
  });

  it('infers ratings without manual review buttons', () => {
    expect(inferReviewRating('wrong', 1000, 'input')).toBe('again');
    expect(inferReviewRating('revealed', 1000, 'input')).toBe('again');
    expect(inferReviewRating('correct', 25000, 'input')).toBe('hard');
    expect(inferReviewRating('correct', 9000, 'input')).toBe('good');
    expect(inferReviewRating('correct', 3000, 'choice')).toBe('easy');
  });
});

it('starts due reviews only at the actual due instant, including same-day relearning and leech cards', () => {
  const now = new Date('2026-10-03T10:00:00Z');
  const future = ['relearning', 'leech', 'review'].map(
    (state, index) => ({ ...createReviewCard(`future-${index}`, 'm', now), state, dueAt: '2026-10-03T10:10:00Z' }) as ReviewCard
  );
  expect(buildSrsReviewQueue(future, now)).toEqual([]);
  expect(buildSrsReviewQueue(future, new Date('2026-10-03T10:10:00Z'))).toHaveLength(3);
});
