import { describe, expect, it } from 'vitest';
import type { Attempt, Question, ReviewCard } from '../src/core/models';
import { buildReviewCenterModel } from '../src/core/reviewCenterModel';
import { applyReviewRating, createReviewCard } from '../src/core/scheduler';

const NOW = new Date('2026-10-24T12:00:00');

describe('review center counts', () => {
  it('separates misses coming back later today from reviews that can start now', () => {
    const questions: Question[] = ['a', 'b'].map((id) => ({ id, moduleId: 'm', type: 'input', prompt: id, answer: id }));
    const attempts: Attempt[] = questions.map((question) => ({
      attemptId: question.id,
      questionId: question.id,
      moduleId: 'm',
      answeredAt: new Date(NOW.getTime() - 60_000).toISOString(),
      result: 'wrong',
      input: '',
      answer: question.id,
      elapsedMs: 3000,
      mode: 'normal'
    }));
    // 'a' was missed a minute ago and returns in nine minutes; 'b' has been due since this morning.
    const missed: ReviewCard = applyReviewRating(createReviewCard('a', 'm', NOW), 'again', 'wrong', 3000, {
      now: new Date(NOW.getTime() - 60_000)
    }).card;
    const due: ReviewCard = { ...createReviewCard('b', 'm', NOW), state: 'review', intervalDays: 1, dueAt: '2026-10-24T08:00:00' };

    const model = buildReviewCenterModel(attempts, [missed, due], questions, 'recent', NOW);
    expect(model.srsQueue.map((card) => card.questionId)).toEqual(['b']);
    expect(model.laterToday.count).toBe(1);
    expect(model.laterToday.firstDueAt?.getTime()).toBe(Date.parse(missed.dueAt!));
  });
});
