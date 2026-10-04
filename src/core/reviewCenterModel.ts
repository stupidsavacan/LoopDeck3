import type { Attempt, Question, ReviewCard } from './models';
import { getSupportedStudyQuestionModes } from './questionPresentation';
import {
  aggregateReviewAttempts,
  analyzeProblems,
  buildMistakeQuestions,
  buildReviewQueue,
  DEFAULT_REVIEW_LOOKBACK_DAYS,
  DEFAULT_REVIEW_SCORE_HALF_LIFE_DAYS,
  filterRecentAttempts,
  summarizeWeakModules,
  type ProblemAnalysis,
  type ReviewItem
} from './reviewEngine';
import {
  bucketReviewCards,
  buildSrsReviewQueue,
  summarizeReviewSchedule,
  type ReviewBuckets,
  type ReviewScheduleSummary
} from './scheduler';

export type ReviewScope = 'recent' | 'all';

export interface ReviewCenterModel {
  scope: ReviewScope;
  questionsById: Map<string, Question>;
  activeModuleIds: Set<string>;
  queue: ReviewItem[];
  mistakes: Question[];
  analyses: ProblemAnalysis[];
  weak: Record<string, number>;
  schedule: ReviewScheduleSummary;
  allSchedule: ReviewScheduleSummary;
  buckets: ReviewBuckets;
  srsQueue: ReviewCard[];
  hiddenDueCount: number;
}

export function buildReviewCenterModel(
  attempts: Attempt[],
  reviewCards: ReviewCard[],
  questions: Question[],
  scope: ReviewScope,
  now = new Date()
): ReviewCenterModel {
  const questionsById = new Map(questions.map((question) => [question.id, question]));
  const recentAttempts = filterRecentAttempts(attempts, now, DEFAULT_REVIEW_LOOKBACK_DAYS);
  const scopedAttempts = scope === 'recent' ? recentAttempts : attempts;
  const objectiveAttempts = scopedAttempts.filter((attempt) => attempt.answerMode !== 'flashcard');
  const activeModuleIds = new Set(scopedAttempts.map((attempt) => attempt.moduleId));
  const recentQuestionIds = new Set(recentAttempts.map((attempt) => attempt.questionId));
  const validReviewCards = reviewCards.filter((card) => {
    const question = questionsById.get(card.questionId);
    return question?.moduleId === card.moduleId && getSupportedStudyQuestionModes(question).includes(card.questionMode ?? 'as_stored');
  });
  const scopedReviewCards =
    scope === 'recent' ? validReviewCards.filter((card) => recentQuestionIds.has(card.questionId)) : validReviewCards;
  const scoreOptions = scope === 'recent' ? { now, halfLifeDays: DEFAULT_REVIEW_SCORE_HALF_LIFE_DAYS } : {};
  const aggregation = aggregateReviewAttempts(objectiveAttempts);
  const queue = buildReviewQueue(objectiveAttempts, questions, scoreOptions, aggregation);
  const mistakes = buildMistakeQuestions(questions, objectiveAttempts, aggregation);
  const analyses = analyzeProblems(objectiveAttempts, questions, scoreOptions, aggregation)
    .filter((item) => item.needsAttention)
    .slice(0, 8);
  const weak = summarizeWeakModules(objectiveAttempts, aggregation);
  const schedule = summarizeReviewSchedule(scopedReviewCards, now);
  const allSchedule = summarizeReviewSchedule(validReviewCards, now);
  const buckets = bucketReviewCards(scopedReviewCards, now);
  const srsQueue = buildSrsReviewQueue(scopedReviewCards, now, 30);

  return {
    scope,
    questionsById,
    activeModuleIds,
    queue,
    mistakes,
    analyses,
    weak,
    schedule,
    allSchedule,
    buckets,
    srsQueue,
    hiddenDueCount: scope === 'recent' ? Math.max(0, allSchedule.dueToday - schedule.dueToday) : 0
  };
}
