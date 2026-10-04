import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import type { Attempt } from '../src/core/models';
import { buildReviewPersistence } from '../src/core/reviewPersistence';
import { studyStore } from '../src/storage/studyRepository';
function attempt(id = 'attempt-1'): Attempt {
  return {
    attemptId: id,
    questionId: 'q1',
    moduleId: 'm1',
    answeredAt: '2026-09-27T00:00:00.000Z',
    result: 'wrong',
    input: 'x',
    answer: 'a',
    elapsedMs: 1200,
    mode: 'normal',
    answerMode: 'input'
  };
}
afterEach(async () => {
  await studyStore.clearAttempts();
  await studyStore.clearReviewData();
});
describe('answer persistence boundary', () => {
  it('calculates the same review outcome without any DOM', () => {
    const { card, log } = buildReviewPersistence(attempt());
    expect(card).toMatchObject({
      questionId: 'q1',
      moduleId: 'm1',
      totalReviews: 1,
      totalWrong: 1,
      createdAt: attempt().answeredAt,
      dueAt: '2026-09-27T00:10:00.000Z'
    });
    expect(log).toMatchObject({ questionId: 'q1', attemptId: 'attempt-1', result: 'wrong', reviewedAt: attempt().answeredAt });
  });
  it('does not lose ratings when concurrent answers target the same question', async () => {
    await Promise.all([studyStore.recordAnswer(attempt('parallel-1')), studyStore.recordAnswer(attempt('parallel-2'))]);
    expect(await studyStore.getReviewCard('q1')).toMatchObject({ totalReviews: 2, totalWrong: 2, wrongStreak: 2 });
    expect(await studyStore.getReviewLogsForQuestion('q1')).toHaveLength(2);
    expect(await studyStore.getAttempts()).toHaveLength(2);
  });
  it('records a repeated command only once, including concurrent retries', async () => {
    await Promise.all([studyStore.recordAnswer(attempt()), studyStore.recordAnswer(attempt())]);
    await studyStore.recordAnswer(attempt());
    expect(await studyStore.getReviewCard('q1')).toMatchObject({ totalReviews: 1, totalWrong: 1 });
    expect(await studyStore.getReviewLogsForQuestion('q1')).toHaveLength(1);
    expect(await studyStore.getAttempts()).toHaveLength(1);
  });
});

it('keeps directions independent and rejects invalid answer timestamps atomically', async () => {
  await Promise.all([
    studyStore.recordAnswer({ ...attempt('front'), questionMode: 'front_to_back' }),
    studyStore.recordAnswer({ ...attempt('back'), questionMode: 'back_to_front', result: 'correct' })
  ]);
  expect(await studyStore.getReviewCard('q1', 'front_to_back')).toMatchObject({ totalReviews: 1, totalWrong: 1 });
  expect(await studyStore.getReviewCard('q1', 'back_to_front')).toMatchObject({ totalReviews: 1, totalCorrect: 1 });
  await expect(studyStore.recordAnswer({ ...attempt('invalid'), answeredAt: 'invalid' })).rejects.toThrow('timestamp');
  expect(await studyStore.getReviewCard('q1')).toBeUndefined();
  expect(await studyStore.getAttempts()).toHaveLength(2);
});
