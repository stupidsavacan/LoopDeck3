import { describe, expect, it } from 'vitest';
import type { Attempt, Question, ReviewCard } from '../src/core/models';
import { buildReviewCenterModel } from '../src/core/reviewCenterModel';

const questions: Question[] = [
  { id: 'recent', moduleId: 'm', type: 'input', prompt: 'Recent', answer: 'a' },
  { id: 'old', moduleId: 'm', type: 'input', prompt: 'Old', answer: 'b' }
];

function attempt(questionId: string, daysAgo: number): Attempt {
  return {
    attemptId: `a-${questionId}`,
    questionId,
    moduleId: 'm',
    answeredAt: new Date(Date.UTC(2026, 8, 27) - daysAgo * 86400000).toISOString(),
    result: 'wrong',
    input: 'x',
    answer: 'a',
    elapsedMs: 1000,
    mode: 'normal',
    answerMode: 'input'
  };
}

function card(questionId: string): ReviewCard {
  const now = '2026-09-27T00:00:00.000Z';
  return {
    questionId,
    moduleId: 'm',
    state: 'review',
    dueAt: '2026-09-26T00:00:00.000Z',
    lastReviewedAt: now,
    firstReviewedAt: now,
    intervalDays: 1,
    ease: 2.5,
    totalReviews: 1,
    totalCorrect: 0,
    totalWrong: 1,
    correctStreak: 0,
    wrongStreak: 1,
    lapseCount: 0,
    leechLevel: 0,
    suspended: false,
    createdAt: now,
    updatedAt: now
  };
}

describe('review center model', () => {
  it('prepares recent scope without rendering DOM', () => {
    const now = new Date('2026-09-27T00:00:00.000Z');
    const model = buildReviewCenterModel(
      [attempt('recent', 1), attempt('old', 8)],
      [card('recent'), card('old')],
      questions,
      'recent',
      now
    );

    expect(model.queue.map((item) => item.question.id)).toEqual(['recent']);
    expect(model.srsQueue.map((item) => item.questionId)).toEqual(['recent']);
    expect(model.hiddenDueCount).toBe(1);
  });

  it('keeps flashcard AGAIN in SRS while excluding it from objective mistake review', () => {
    const now = new Date('2026-09-27T00:00:00.000Z');
    const flashcard = { ...attempt('recent', 1), attemptId: 'flash-again', answerMode: 'flashcard' as const };
    const model = buildReviewCenterModel([flashcard], [card('recent')], questions, 'recent', now);

    expect(model.queue).toHaveLength(0);
    expect(model.mistakes).toHaveLength(0);
    expect(model.analyses).toHaveLength(0);
    expect(model.weak).toEqual({});
    expect(model.srsQueue.map((item) => item.questionId)).toEqual(['recent']);
  });
});
