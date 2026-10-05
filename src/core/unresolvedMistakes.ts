import type { Attempt } from './models';

/** Consecutive objective correct answers that clear a question from "間違いだけ". */
export const MISTAKE_CLEAR_STREAK = 2;

function attemptTime(attempt: Attempt): number {
  const parsed = Date.parse(attempt.answeredAt);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Questions whose latest objective mistake has not yet been followed by enough consecutive correct answers.
 * Flashcard self-ratings never add or clear a mistake, and study directions share one history.
 */
export function getUnresolvedMistakeIds(attempts: readonly Attempt[], clearStreak = MISTAKE_CLEAR_STREAK): Set<string> {
  const ordered = attempts
    .map((attempt, index) => ({ attempt, index, time: attemptTime(attempt) }))
    .filter(({ attempt }) => attempt.answerMode !== 'flashcard')
    .sort((left, right) => left.time - right.time || left.index - right.index);
  const correctStreak = new Map<string, number>();
  for (const { attempt } of ordered) {
    if (attempt.result === 'correct') {
      const streak = correctStreak.get(attempt.questionId);
      if (streak !== undefined) correctStreak.set(attempt.questionId, streak + 1);
    } else {
      correctStreak.set(attempt.questionId, 0);
    }
  }
  const unresolved = new Set<string>();
  for (const [questionId, streak] of correctStreak) if (streak < clearStreak) unresolved.add(questionId);
  return unresolved;
}
