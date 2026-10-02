import type { AnswerFormat, AnswerResult, ReviewCard, ReviewLog, ReviewRating } from './models';
import { endOfLocalCalendarDay, startOfLocalCalendarDay } from './calendarDay';

const DEFAULT_EASE = 2.5;
const MIN_EASE = 1.3;
const MAX_EASE = 3.0;
const AGAIN_DELAY_MINUTES = 10;
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
  return card.suspended;
}

export function clampEase(ease: number): number {
  return Math.min(MAX_EASE, Math.max(MIN_EASE, ease));
}

export function inferReviewRating(result: AnswerResult, elapsedMs: number, answerMode: AnswerFormat = 'input'): ReviewRating {
  if (result !== 'correct') return 'again';
  const [fast, slow] = answerMode === 'choice' ? [4500, 12000] : [7000, 20000];
  if (elapsedMs <= fast) return 'easy';
  if (elapsedMs >= slow) return 'hard';
  return 'good';
}

export function createReviewCard(questionId: string, moduleId: string, now = new Date()): ReviewCard {
  const createdAt = iso(now);
  return {
    questionId,
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

  const log: ReviewLog = {
    reviewLogId: reviewLogId(next.questionId, reviewedAt),
    questionId: next.questionId,
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

    if (card.state === 'relearning') buckets.relearning.push(card);
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
  const buckets = bucketReviewCards(cards, now);
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
    relearning: active.filter((card) => card.state === 'relearning').length,
    leech: active.filter((card) => card.state === 'leech').length,
    mastered: active.filter((card) => card.state === 'mastered').length,
    estimatedMinutes: Math.ceil((dueToday * ESTIMATED_SECONDS_PER_CARD) / 60)
  };
}
