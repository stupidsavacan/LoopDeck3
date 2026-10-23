import { localCalendarDayKey } from './calendarDay';
import type { Attempt, ModuleInfo, Question } from './models';
import { buildRivalPairs } from './rivalPairs';

/** A module needs this many answers in both weeks before its accuracy change is reported. */
export const MIN_ANSWERS_FOR_GAIN = 5;

export interface WeeklyDay {
  date: string;
  studied: boolean;
}

export interface WeeklyRecap {
  /** Monday of the week, YYYY-MM-DD. */
  weekStart: string;
  days: WeeklyDay[];
  studyDays: number;
  answered: number;
  previousAnswered: number;
  /** The module whose accuracy rose most, or else the one answered most. */
  topModule?: { title: string; kind: 'gain'; gain: number } | { title: string; kind: 'most'; answered: number };
  /** Confused pairs overcome during this week, as the two prompts. */
  defeatedPairs: Array<[string, string]>;
}

/** Monday 00:00 local time of the week containing `date`. */
export function weekStartOf(date: Date): Date {
  const offset = (date.getDay() + 6) % 7;
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() - offset);
}

function inRange(value: string, start: number, end: number): boolean {
  const time = Date.parse(value);
  return Number.isFinite(time) && time >= start && time < end;
}

function accuracyByModule(attempts: readonly Attempt[]): Map<string, { answered: number; correct: number }> {
  const byModule = new Map<string, { answered: number; correct: number }>();
  for (const attempt of attempts) {
    if (attempt.answerMode === 'flashcard') continue;
    const entry = byModule.get(attempt.moduleId) ?? { answered: 0, correct: 0 };
    entry.answered += 1;
    if (attempt.result === 'correct') entry.correct += 1;
    byModule.set(attempt.moduleId, entry);
  }
  return byModule;
}

export function buildWeeklyRecap(
  attempts: readonly Attempt[],
  modules: readonly ModuleInfo[],
  questionsById: ReadonlyMap<string, Question>,
  weekStart: Date
): WeeklyRecap {
  const start = weekStartOf(weekStart);
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7).getTime();
  const previousStart = new Date(start.getFullYear(), start.getMonth(), start.getDate() - 7).getTime();
  const live = attempts.filter((attempt) => !attempt.contentRetired);
  const thisWeek = live.filter((attempt) => inRange(attempt.answeredAt, start.getTime(), end));
  const lastWeek = live.filter((attempt) => inRange(attempt.answeredAt, previousStart, start.getTime()));

  const studiedDays = new Set(thisWeek.map((attempt) => localCalendarDayKey(new Date(attempt.answeredAt))));
  const days = Array.from({ length: 7 }, (_, offset) => {
    const date = localCalendarDayKey(new Date(start.getFullYear(), start.getMonth(), start.getDate() + offset));
    return { date, studied: studiedDays.has(date) };
  });

  const titles = new Map(modules.map((module) => [module.id, module.title]));
  const now = accuracyByModule(thisWeek);
  const before = accuracyByModule(lastWeek);
  let topModule: WeeklyRecap['topModule'];
  let bestGain = 0;
  for (const [moduleId, current] of now) {
    const previous = before.get(moduleId);
    const title = titles.get(moduleId);
    if (!title || !previous || current.answered < MIN_ANSWERS_FOR_GAIN || previous.answered < MIN_ANSWERS_FOR_GAIN) continue;
    const gain = current.correct / current.answered - previous.correct / previous.answered;
    if (gain > bestGain) {
      bestGain = gain;
      topModule = { title, kind: 'gain', gain };
    }
  }
  if (!topModule) {
    const most = [...now].filter(([moduleId]) => titles.has(moduleId)).sort((a, b) => b[1].answered - a[1].answered)[0];
    if (most) topModule = { title: titles.get(most[0]) ?? most[0], kind: 'most', answered: most[1].answered };
  }

  const defeatedPairs = buildRivalPairs(live)
    .filter((pair) => pair.defeated && pair.defeatedAt && inRange(pair.defeatedAt, start.getTime(), end))
    .flatMap((pair) => {
      const [a, b] = pair.questionIds.map((id) => questionsById.get(id)?.prompt);
      return a && b ? [[a, b] as [string, string]] : [];
    });

  return {
    weekStart: localCalendarDayKey(start),
    days,
    studyDays: studiedDays.size,
    answered: thisWeek.length,
    previousAnswered: lastWeek.length,
    topModule,
    defeatedPairs
  };
}
