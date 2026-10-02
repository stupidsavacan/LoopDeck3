import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalDatabase } from '../src/storage/indexedDb';
import { StudyRepository } from '../src/storage/studyRepository';
import type { Attempt } from '../src/core/models';
const attempt: Attempt = { attemptId: 'a', questionId: 'q', moduleId: 'm', answeredAt: '2026-10-02T00:00:00Z', result: 'correct', input: 'A', answer: 'A', elapsedMs: 2000, mode: 'normal' };
afterEach(() => vi.restoreAllMocks());
describe('repository ownership', () => {
  it('serializes review updates across independent database connections', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const name = `concurrent-repository-${crypto.randomUUID()}`;
    const first = new LocalDatabase(name), second = new LocalDatabase(name);
    const left = new StudyRepository(first), right = new StudyRepository(second);
    try {
      await Promise.all([left.recordAnswer(attempt), right.recordAnswer({ ...attempt, attemptId: 'b' })]);
      expect(await left.getReviewCard('q')).toMatchObject({ totalReviews: 2, totalCorrect: 2 });
      expect(await right.getReviewLogsForQuestion('q')).toHaveLength(2);
    } finally { first.close(); second.close(); }
  });
  it('keeps separate application repositories isolated through writes and snapshot restore', async () => {
    const first = new LocalDatabase(`isolated-left-${crypto.randomUUID()}`), second = new LocalDatabase(`isolated-right-${crypto.randomUUID()}`);
    const left = new StudyRepository(first), right = new StudyRepository(second);
    try {
      await left.recordAnswer(attempt); await left.setBookmark('q', true);
      expect(await right.getAttempts()).toEqual([]); expect(await right.hasBookmark('q')).toBe(false);
      await right.restoreSnapshot(await left.exportSnapshot(), 'replace');
      await right.recordAnswer({ ...attempt, attemptId: 'b', result: 'wrong' });
      expect(await left.getReviewCard('q')).toMatchObject({ totalReviews: 1, totalWrong: 0 });
      expect(await right.getReviewCard('q')).toMatchObject({ totalReviews: 2, totalWrong: 1 });
    } finally { first.close(); second.close(); }
  });
});
