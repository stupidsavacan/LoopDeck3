import { endOfLocalCalendarDay, localCalendarDayKey, startOfLocalCalendarDay } from './calendarDay';
import { indexCardsByQuestion } from './mastery';
import type { Attempt, ModuleInfo, Question, ReviewCard } from './models';
import { getSupportedStudyQuestionModes, presentQuestionForStudy } from './questionPresentation';
import { buildRivalPairs, placeRivalsTogether } from './rivalPairs';
import { buildSrsReviewQueue } from './scheduler';

export const DEFAULT_FRESH_COUNT = 10;
export const DEFAULT_REVIEW_LIMIT = 30;
const ESTIMATED_SECONDS_PER_QUESTION = 20;

export interface TodayPlanInput {
  questions: Question[];
  modules: ModuleInfo[];
  cards: ReviewCard[];
  attempts: Attempt[];
  /** Preferred module for new questions, e.g. the last one opened. */
  focusModuleId?: string;
  freshCount?: number;
  reviewLimit?: number;
  now?: Date;
}

export interface TodayPlan {
  /** Due reviews, already presented in the direction their card tracks. */
  review: Question[];
  /** Questions never answered, from one module in its own order. */
  fresh: Question[];
  focusModule?: ModuleInfo;
  estimatedMinutes: number;
  /** Answers recorded today, so a ring can show done / (done + remaining). */
  answeredToday: number;
}

/** Cards whose question is still active and still supports the tracked direction. */
export function activeReviewCards(cards: readonly ReviewCard[], questionsById: ReadonlyMap<string, Question>): ReviewCard[] {
  return cards.filter((card) => {
    const question = questionsById.get(card.questionId);
    return question?.moduleId === card.moduleId && getSupportedStudyQuestionModes(question).includes(card.questionMode ?? 'as_stored');
  });
}

export function countAnsweredToday(attempts: readonly Attempt[], now = new Date()): number {
  const start = startOfLocalCalendarDay(now);
  const end = endOfLocalCalendarDay(now);
  return attempts.filter((attempt) => {
    const time = Date.parse(attempt.answeredAt);
    return Number.isFinite(time) && time >= start && time <= end && !attempt.contentRetired;
  }).length;
}

export function todayKey(now = new Date()): string {
  return localCalendarDayKey(now);
}

function unseenQuestions(module: ModuleInfo, questionsById: ReadonlyMap<string, Question>, seen: ReadonlySet<string>): Question[] {
  return [...new Set(module.questionIds)].flatMap((id) => {
    const question = questionsById.get(id);
    return question && !seen.has(id) ? [question] : [];
  });
}

/** Today's loop: due reviews first (confused pairs side by side), then new questions from one module. */
export function buildTodayPlan(input: TodayPlanInput): TodayPlan {
  const now = input.now ?? new Date();
  const questionsById = new Map(input.questions.map((question) => [question.id, question]));
  const cards = activeReviewCards(input.cards, questionsById);

  const review: Question[] = [];
  const planned = new Set<string>();
  for (const card of buildSrsReviewQueue(cards, now, input.reviewLimit ?? DEFAULT_REVIEW_LIMIT)) {
    const question = questionsById.get(card.questionId);
    if (!question || planned.has(question.id)) continue;
    planned.add(question.id);
    review.push(presentQuestionForStudy(question, card.questionMode ?? 'as_stored'));
  }

  const seen = new Set([...indexCardsByQuestion(cards).keys(), ...input.attempts.map((attempt) => attempt.questionId), ...planned]);
  const candidates = input.modules.filter((module) => unseenQuestions(module, questionsById, seen).length > 0);
  const focusModule = candidates.find((module) => module.id === input.focusModuleId) ?? candidates[0];
  const fresh = focusModule ? unseenQuestions(focusModule, questionsById, seen).slice(0, input.freshCount ?? DEFAULT_FRESH_COUNT) : [];

  return {
    review: placeRivalsTogether(review, buildRivalPairs(input.attempts)),
    fresh,
    focusModule,
    estimatedMinutes: Math.ceil(((review.length + fresh.length) * ESTIMATED_SECONDS_PER_QUESTION) / 60),
    answeredToday: countAnsweredToday(input.attempts, now)
  };
}
