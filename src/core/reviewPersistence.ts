import type { Attempt, ReviewCard, ReviewLog } from './models';
import { applyReviewRating, createReviewCard, inferReviewRating } from './scheduler';
import { answerModeFor } from './reviewEngine';

export function buildReviewPersistence(attempt: Attempt, existingCard?: ReviewCard): { card: ReviewCard; log: ReviewLog } {
  const answeredAt = new Date(attempt.answeredAt);
  const now = Number.isFinite(answeredAt.getTime()) ? answeredAt : new Date();
  const baseCard = existingCard ?? createReviewCard(attempt.questionId, attempt.moduleId, now);
  const rating = inferReviewRating(attempt.result, attempt.elapsedMs, answerModeFor(attempt));
  const result = applyReviewRating(baseCard, rating, attempt.result, attempt.elapsedMs, { attemptId: attempt.attemptId, now });
  // A persisted answer owns exactly one log; random collisions cannot block it.
  result.log.reviewLogId = `answer:${attempt.attemptId}`;
  return result;
}
