import type { Attempt, Question, QuizAnswerSource, ReviewCard, ReviewLog } from './models';
import { isSafeImageAssetRef } from '../packs/assetSafety';
import { applyReviewRating, createReviewCard, inferReviewRating } from './scheduler';
import { answerModeFor } from './reviewEngine';

export function buildQuizAnswerSources(
  questions: Question[],
  modulePackIds: ReadonlyMap<string, string>,
  assets: readonly { packId: string; path: string; dataUrl: string }[],
  revisions?: ReadonlyMap<string, string>
): ReadonlyMap<string, QuizAnswerSource> {
  const images = new Map(assets.map((asset) => [JSON.stringify([asset.packId, asset.path]), asset.dataUrl]));
  const sources = new Map<string, QuizAnswerSource>();
  for (const question of questions) {
    const packId = modulePackIds.get(question.moduleId);
    if (!packId) continue;
    sources.set(question.id, {
      packId,
      question,
      ...(revisions ? { packRevision: revisions.get(packId) ?? 'builtin' } : {}),
      ...(revisions ? { resetEpoch: revisions.get('') ?? '0' } : {}),
      ...(question.imageAsset && isSafeImageAssetRef(question.imageAsset)
        ? { imageDataUrl: images.get(JSON.stringify([packId, question.imageAsset])) ?? null }
        : {})
    });
  }
  return sources;
}

export function buildReviewPersistence(attempt: Attempt, existingCard?: ReviewCard): { card: ReviewCard; log: ReviewLog } {
  const answeredAt = new Date(attempt.answeredAt);
  if (!Number.isFinite(answeredAt.getTime())) throw new Error('Review answer timestamp must be a valid date.');
  const now = answeredAt;
  const samePresentation =
    existingCard?.questionId === attempt.questionId &&
    existingCard.moduleId === attempt.moduleId &&
    (existingCard.questionMode ?? 'as_stored') === (attempt.questionMode ?? 'as_stored');
  const baseCard =
    samePresentation && existingCard
      ? existingCard
      : createReviewCard(attempt.questionId, attempt.moduleId, now, attempt.questionMode ?? 'as_stored');
  const rating = inferReviewRating(attempt.result, attempt.elapsedMs, answerModeFor(attempt));
  const result = applyReviewRating(baseCard, rating, attempt.result, attempt.elapsedMs, { attemptId: attempt.attemptId, now });
  result.log.reviewLogId = `answer:${attempt.attemptId}`;
  return result;
}
