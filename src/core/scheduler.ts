import type {
  AnswerConfidence,
  AnswerFormat,
  AnswerResult,
  ConcreteStudyQuestionMode,
  ReviewCard,
  ReviewLog,
  ReviewRating
} from './models';
import { timingThresholds } from './answerTiming';
import { endOfLocalCalendarDay, startOfLocalCalendarDay } from './calendarDay';

const DEFAULT_EASE = 2.5;
const MIN_EASE = 1.3;
const MAX_EASE = 3.0;
/** A missed card comes back this many minutes later. */
export const AGAIN_DELAY_MINUTES = 10;
const DAY_MS = 24 * 60 * 60 * 1000;
const ESTIMATED_SECONDS_PER_CARD = 20;
const LEECH_PRESSURE_THRESHOLD = 3;

export interface ApplyReviewOptions {
  now?: Date;
  attemptId?: string;
}

export interface ReviewScheduleResult {
  card: ReviewCard;
  log: ReviewLog;
}

export interface ReviewBuckets {
  relearning: ReviewCard[];
  overdue: ReviewCard[];
  dueToday: ReviewCard[];
  leech: ReviewCard[];
  masteredDue: ReviewCard[];
}

export interface ReviewScheduleSummary {
  total: number;
  dueToday: number;
  overdue: number;
  relearning: number;
  leech: number;
  mastered: number;
  estimatedMinutes: number;
}

function iso(date: Date): string {
  return date.toISOString();
}

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

function dueTime(card: ReviewCard): number | undefined {
  if (!card.dueAt) return undefined;
  const parsed = Date.parse(card.dueAt);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isSuspended(card: ReviewCard): boolean {
  return card.suspended || card.state === 'suspended';
}

export function estimateReviewMinutes(cardCount: number): number {
  return Math.ceil((cardCount * ESTIMATED_SECONDS_PER_CARD) / 60);
}

export function clampEase(ease: number): number {
  return Math.min(MAX_EASE, Math.max(MIN_EASE, ease));
}

export interface RatingContext {
  readingChars?: number;
  hintUsed?: boolean;
  /** The card has never been reviewed before this answer. */
  firstReview?: boolean;
}

/**
 * Rates an answer without asking the learner, so studying never stops for a self-grading step.
 * The learner can still correct a correct answer's rating afterwards with reviseReviewRating.
 */
export function inferReviewRating(
  result: AnswerResult,
  elapsedMs: number,
  answerMode: AnswerFormat = 'input',
  confidence?: AnswerConfidence,
  context: RatingContext = {}
): ReviewRating {
  if (answerMode === 'flashcard') return result === 'correct' ? 'good' : 'again';
  if (result !== 'correct') return 'again';
  // A correct guess, or one reached through the hint, is not knowledge yet.
  if (confidence === 'guess' || context.hintUsed) return 'hard';
  const { fast, slow } = timingThresholds(answerMode, context.readingChars);
  if (elapsedMs >= slow) return 'hard';
  if (elapsedMs > fast) return 'good';
  // Picking the right option the first time it is seen can be recognition or luck, so it is never "easy".
  if (confidence === 'unsure' || (context.firstReview && answerMode === 'choice')) return 'good';
  return 'easy';
}

export function createReviewCard(
  questionId: string,
  moduleId: string,
  now = new Date(),
  questionMode: ConcreteStudyQuestionMode = 'as_stored'
): ReviewCard {
  const createdAt = iso(now);
  return {
    questionId,
    questionMode,
    moduleId,
    state: 'new',
    dueAt: null,
    lastReviewedAt: null,
    firstReviewedAt: null,
    intervalDays: 0,
    ease: DEFAULT_EASE,
    totalReviews: 0,
    totalCorrect: 0,
    totalWrong: 0,
    correctStreak: 0,
    wrongStreak: 0,
    lapseCount: 0,
    leechLevel: 0,
    suspended: false,
    createdAt,
    updatedAt: createdAt
  };
}

function nextIntervalDays(previousIntervalDays: number, ease: number, rating: ReviewRating): number {
  if (rating === 'hard') return Math.max(1, Math.ceil(previousIntervalDays * 1.2));
  if (rating === 'good') return Math.max(1, Math.ceil(previousIntervalDays === 0 ? 1 : previousIntervalDays * ease));
  if (rating === 'easy') return Math.max(3, Math.ceil(previousIntervalDays === 0 ? 3 : previousIntervalDays * ease * 1.3));
  return 0;
}

function nextLeechLevel(currentCard: ReviewCard, rating: ReviewRating, nextWrongStreak: number): number {
  const currentPressure = Math.min(LEECH_PRESSURE_THRESHOLD, Math.max(0, currentCard.leechLevel));
  if (rating === 'again') {
    return Math.min(LEECH_PRESSURE_THRESHOLD, Math.max(currentPressure + 1, nextWrongStreak));
  }
  return Math.max(0, currentPressure - 1);
}

function isMastered(card: ReviewCard): boolean {
  return card.correctStreak >= 5 && card.intervalDays >= 30;
}

function reviewLogId(questionId: string, reviewedAt: string): string {
  return `${reviewedAt}-${questionId}-${Math.random().toString(36).slice(2, 10)}`;
}

export function applyReviewRating(
  currentCard: ReviewCard,
  rating: ReviewRating,
  result: AnswerResult,
  elapsedMs: number,
  options: ApplyReviewOptions = {}
): ReviewScheduleResult {
  const now = options.now ?? new Date();
  const reviewedAt = iso(now);
  const previous = { ...currentCard };
  const next: ReviewCard = {
    ...currentCard,
    totalReviews: currentCard.totalReviews + 1,
    lastReviewedAt: reviewedAt,
    firstReviewedAt: currentCard.firstReviewedAt ?? reviewedAt,
    updatedAt: reviewedAt
  };

  if (rating === 'again') {
    next.totalWrong += 1;
    next.wrongStreak += 1;
    next.correctStreak = 0;
    next.ease = clampEase(next.ease - 0.25);
    if (currentCard.state === 'review' || currentCard.state === 'mastered') next.lapseCount += 1;
    next.intervalDays = 0;
    next.dueAt = iso(addMinutes(now, AGAIN_DELAY_MINUTES));
    next.state = 'relearning';
  } else {
    next.totalCorrect += 1;
    next.correctStreak += 1;
    next.wrongStreak = 0;
    if (rating === 'hard') next.ease = clampEase(next.ease - 0.15);
    if (rating === 'easy') next.ease = clampEase(next.ease + 0.15);
    next.intervalDays = nextIntervalDays(currentCard.intervalDays, next.ease, rating);
    next.dueAt = iso(addDays(now, next.intervalDays));
    next.state = 'review';
  }

  next.leechLevel = nextLeechLevel(currentCard, rating, next.wrongStreak);
  if (rating === 'again' && next.leechLevel >= LEECH_PRESSURE_THRESHOLD) {
    next.state = 'leech';
  } else if (isMastered(next)) {
    next.state = 'mastered';
  }

  if (next.suspended) next.state = 'suspended';

  const log: ReviewLog = {
    reviewLogId: reviewLogId(next.questionId, reviewedAt),
    questionId: next.questionId,
    questionMode: next.questionMode ?? 'as_stored',
    moduleId: next.moduleId,
    reviewedAt,
    rating,
    result,
    previousState: previous.state,
    nextState: next.state,
    previousDueAt: previous.dueAt,
    nextDueAt: next.dueAt,
    previousIntervalDays: previous.intervalDays,
    nextIntervalDays: next.intervalDays,
    previousEase: previous.ease,
    nextEase: next.ease,
    elapsedMs,
    attemptId: options.attemptId
  };

  return { card: next, log };
}

export type CorrectRating = Exclude<ReviewRating, 'again'>;

function correctRatingEase(previousEase: number, rating: CorrectRating): number {
  if (rating === 'hard') return clampEase(previousEase - 0.15);
  if (rating === 'easy') return clampEase(previousEase + 0.15);
  return previousEase;
}

/** Days until the next review for each rating a correct answer could have had. */
export function correctRatingIntervals(log: Pick<ReviewLog, 'previousEase' | 'previousIntervalDays'>): Record<CorrectRating, number> {
  const interval = (rating: CorrectRating) =>
    nextIntervalDays(log.previousIntervalDays, correctRatingEase(log.previousEase, rating), rating);
  return { hard: interval('hard'), good: interval('good'), easy: interval('easy') };
}

/** Only a correct answer whose card has not been reviewed again since can change its rating. */
export function canReviseReviewRating(card: ReviewCard, log: ReviewLog): boolean {
  return (
    log.rating !== 'again' &&
    card.questionId === log.questionId &&
    (card.questionMode ?? 'as_stored') === (log.questionMode ?? 'as_stored') &&
    card.lastReviewedAt === log.reviewedAt
  );
}

/**
 * Re-schedules a correct answer with the rating the learner chose instead of the inferred one.
 * Correct ratings share every counter, so only ease, interval and due date are recomputed from the log.
 */
export function reviseReviewRating(card: ReviewCard, log: ReviewLog, rating: CorrectRating, now = new Date()): ReviewScheduleResult {
  if (!canReviseReviewRating(card, log)) throw new Error('This answer can no longer be re-rated.');
  const ease = correctRatingEase(log.previousEase, rating);
  const intervalDays = nextIntervalDays(log.previousIntervalDays, ease, rating);
  const next: ReviewCard = {
    ...card,
    ease,
    intervalDays,
    dueAt: iso(addDays(new Date(log.reviewedAt), intervalDays)),
    state: 'review',
    updatedAt: iso(now)
  };
  if (isMastered(next)) next.state = 'mastered';
  if (next.suspended) next.state = 'suspended';
  return {
    card: next,
    log: { ...log, rating, nextState: next.state, nextDueAt: next.dueAt, nextIntervalDays: intervalDays, nextEase: ease }
  };
}

export function bucketReviewCards(cards: ReviewCard[], now = new Date()): ReviewBuckets {
  const buckets: ReviewBuckets = {
    relearning: [],
    overdue: [],
    dueToday: [],
    leech: [],
    masteredDue: []
  };
  const todayStart = startOfLocalCalendarDay(now);
  const todayEnd = endOfLocalCalendarDay(now);

  for (const card of cards) {
    if (isSuspended(card)) continue;
    const due = dueTime(card);
    if (due === undefined || due > todayEnd) continue;

    if (card.state === 'relearning' || card.state === 'learning') buckets.relearning.push(card);
    else if (card.state === 'leech') buckets.leech.push(card);
    else if (card.state === 'mastered') buckets.masteredDue.push(card);
    else if (due < todayStart) buckets.overdue.push(card);
    else buckets.dueToday.push(card);
  }

  const byDue = (a: ReviewCard, b: ReviewCard): number => (dueTime(a) ?? 0) - (dueTime(b) ?? 0);
  buckets.relearning.sort(byDue);
  buckets.overdue.sort(byDue);
  buckets.dueToday.sort(byDue);
  buckets.leech.sort((a, b) => b.leechLevel - a.leechLevel || byDue(a, b));
  buckets.masteredDue.sort(byDue);
  return buckets;
}

export function buildSrsReviewQueue(cards: ReviewCard[], now = new Date(), limit = 30): ReviewCard[] {
  const buckets = bucketReviewCards(
    cards.filter((card) => (dueTime(card) ?? Infinity) <= now.getTime()),
    now
  );
  return [...buckets.relearning, ...buckets.overdue, ...buckets.dueToday, ...buckets.leech, ...buckets.masteredDue].slice(
    0,
    Math.max(0, limit)
  );
}

export function summarizeReviewSchedule(cards: ReviewCard[], now = new Date()): ReviewScheduleSummary {
  const active = cards.filter((card) => !isSuspended(card));
  const buckets = bucketReviewCards(active, now);
  const dueToday =
    buckets.relearning.length + buckets.overdue.length + buckets.dueToday.length + buckets.leech.length + buckets.masteredDue.length;
  return {
    total: active.length,
    dueToday,
    overdue: buckets.overdue.length,
    relearning: active.filter((card) => card.state === 'relearning' || card.state === 'learning').length,
    leech: active.filter((card) => card.state === 'leech').length,
    mastered: active.filter((card) => card.state === 'mastered').length,
    estimatedMinutes: estimateReviewMinutes(dueToday)
  };
}
