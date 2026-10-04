import { localCalendarDayKey, recentLocalCalendarDayKeys } from './calendarDay';
import type { Attempt, ModuleInfo, Question } from './models';
import { analyzeProblems, answerModeFor, timingBand, type ReviewAttemptAggregation } from './reviewEngine';

export interface DailyStudyStat {
  date: string;
  attempts: number;
  correct: number;
  wrong: number;
  revealed: number;
  accuracy: number;
}

export interface ModuleStudyStat {
  moduleId: string;
  title: string;
  attempts: number;
  correct: number;
  wrong: number;
  revealed: number;
  accuracy: number;
  averageElapsedMs: number;
}

export interface MistakeTrendPoint {
  date: string;
  mistakes: number;
}

export interface MistakeBreakdownItem {
  id: string;
  label: string;
  count: number;
}

export interface AnalyticsOverview {
  totalAttempts: number;
  correct: number;
  mistakes: number;
  dailyStudyStats: DailyStudyStat[];
  moduleStudyStats: ModuleStudyStat[];
  mistakeTrend: MistakeTrendPoint[];
  mistakeBreakdown: MistakeBreakdownItem[];
}

function isObjectiveAttempt(attempt: Attempt): boolean {
  return attempt.answerMode !== 'flashcard';
}

function parseAttemptDay(attempt: Attempt): string | undefined {
  const date = new Date(attempt.answeredAt);
  if (Number.isNaN(date.getTime())) return undefined;
  return localCalendarDayKey(date);
}

function bump(counts: Map<string, MistakeBreakdownItem>, id: string, label: string, amount = 1): void {
  const current = counts.get(id) ?? { id, label, count: 0 };
  current.count += amount;
  counts.set(id, current);
}

export function buildDailyStudyStats(attempts: Attempt[], days = 28, now = new Date()): DailyStudyStat[] {
  const byDay = new Map<string, DailyStudyStat>();
  for (const date of recentLocalCalendarDayKeys(days, now)) {
    byDay.set(date, { date, attempts: 0, correct: 0, wrong: 0, revealed: 0, accuracy: 0 });
  }

  for (const attempt of attempts) {
    if (!isObjectiveAttempt(attempt)) continue;
    const date = parseAttemptDay(attempt);
    const item = date ? byDay.get(date) : undefined;
    if (!item) continue;

    item.attempts += 1;
    if (attempt.result === 'correct') item.correct += 1;
    if (attempt.result === 'wrong') item.wrong += 1;
    if (attempt.result === 'revealed') item.revealed += 1;
  }

  return [...byDay.values()].map((item) => ({
    ...item,
    accuracy: item.attempts ? item.correct / item.attempts : 0
  }));
}

export function buildModuleStudyStats(attempts: Attempt[], modules: ModuleInfo[]): ModuleStudyStat[] {
  const moduleTitles = new Map(modules.map((module) => [module.id, module.title]));
  const byModule = new Map<string, ModuleStudyStat & { elapsedTotal: number }>();

  for (const attempt of attempts) {
    if (!isObjectiveAttempt(attempt)) continue;
    const current = byModule.get(attempt.moduleId) ?? {
      moduleId: attempt.moduleId,
      title: moduleTitles.get(attempt.moduleId) ?? attempt.moduleId,
      attempts: 0,
      correct: 0,
      wrong: 0,
      revealed: 0,
      accuracy: 0,
      averageElapsedMs: 0,
      elapsedTotal: 0
    };

    current.attempts += 1;
    current.elapsedTotal += Math.max(0, attempt.elapsedMs);
    if (attempt.result === 'correct') current.correct += 1;
    if (attempt.result === 'wrong') current.wrong += 1;
    if (attempt.result === 'revealed') current.revealed += 1;
    byModule.set(attempt.moduleId, current);
  }

  return [...byModule.values()]
    .map(({ elapsedTotal, ...item }) => ({
      ...item,
      accuracy: item.attempts ? item.correct / item.attempts : 0,
      averageElapsedMs: item.attempts ? elapsedTotal / item.attempts : 0
    }))
    .sort((a, b) => b.attempts - a.attempts || a.title.localeCompare(b.title));
}

export function buildMistakeTrend(attempts: Attempt[], days = 14, now = new Date()): MistakeTrendPoint[] {
  const byDay = new Map(recentLocalCalendarDayKeys(days, now).map((date) => [date, 0]));
  for (const attempt of attempts) {
    if (!isObjectiveAttempt(attempt) || attempt.result === 'correct') continue;
    const date = parseAttemptDay(attempt);
    if (!date || !byDay.has(date)) continue;
    byDay.set(date, (byDay.get(date) ?? 0) + 1);
  }
  return [...byDay.entries()].map(([date, mistakes]) => ({ date, mistakes }));
}

export function buildMistakeBreakdown(attempts: Attempt[], questions: Question[]): MistakeBreakdownItem[] {
  const questionsById = new Map(questions.map((question) => [question.id, question]));
  const counts = new Map<string, MistakeBreakdownItem>();
  const wrongByQuestion = new Map<string, number>();

  const objectiveAttempts = attempts.filter(isObjectiveAttempt);
  for (const attempt of objectiveAttempts) {
    const question = questionsById.get(attempt.questionId);

    if (attempt.result === 'wrong') {
      bump(counts, 'wrong', '不正解');
      wrongByQuestion.set(attempt.questionId, (wrongByQuestion.get(attempt.questionId) ?? 0) + 1);
      if (question?.type === 'multi_select') bump(counts, 'multi_select', '複数選択ミス');
      if (attempt.nearMiss) bump(counts, 'near_miss', 'ニアミス');
      if (timingBand(attempt.elapsedMs, answerModeFor(attempt)) === 'fast') bump(counts, 'quick_wrong', '即答ミス');
      if (timingBand(attempt.elapsedMs, answerModeFor(attempt)) === 'slow') bump(counts, 'slow_wrong', '長考して誤答');
      continue;
    }

    if (attempt.result === 'revealed') {
      bump(counts, 'revealed', '答え表示');
      wrongByQuestion.set(attempt.questionId, (wrongByQuestion.get(attempt.questionId) ?? 0) + 1);
      continue;
    }

    if (attempt.result === 'correct' && timingBand(attempt.elapsedMs, answerModeFor(attempt)) === 'slow') {
      bump(counts, 'slow_correct', '時間がかかった正解');
    }
  }

  const repeated = [...wrongByQuestion.values()].filter((count) => count >= 2).length;
  if (repeated) bump(counts, 'repeated', '繰り返しミス', repeated);

  const analyses = analyzeProblems(objectiveAttempts, questions);
  const repeatedSameWrong = analyses.filter((item) => item.wrongAnswerPatterns.some((pattern) => pattern.count >= 2)).length;
  if (repeatedSameWrong) bump(counts, 'repeated_same_wrong', '同じ誤答を反復', repeatedSameWrong);
  const relapse = analyses.filter((item) => item.mistakeTags.includes('正解後に再失敗')).length;
  if (relapse) bump(counts, 'failed_after_correct', '正解後に再失敗', relapse);

  return [...counts.values()].filter((item) => item.count > 0);
}

/**
 * Builds all Graphs-screen summaries from one pass over attempt history.
 * Derived problem analysis reuses the by-question groups from that pass instead
 * of scanning the raw attempt array again.
 */
export function buildAnalyticsOverview(
  attempts: Attempt[],
  modules: ModuleInfo[],
  questions: Question[],
  options: { dailyDays?: number; trendDays?: number; now?: Date } = {}
): AnalyticsOverview {
  const now = options.now ?? new Date();
  const dailyDays = options.dailyDays ?? 28;
  const trendDays = options.trendDays ?? 14;
  const dailyByDay = new Map<string, DailyStudyStat>(
    recentLocalCalendarDayKeys(dailyDays, now).map((date) => [date, { date, attempts: 0, correct: 0, wrong: 0, revealed: 0, accuracy: 0 }])
  );
  const trendByDay = new Map<string, number>(recentLocalCalendarDayKeys(trendDays, now).map((date) => [date, 0]));
  const moduleTitles = new Map(modules.map((module) => [module.id, module.title]));
  const moduleById = new Map<string, ModuleStudyStat & { elapsedTotal: number }>();
  const questionsById = new Map(questions.map((question) => [question.id, question]));
  const breakdownCounts = new Map<string, MistakeBreakdownItem>();
  const wrongByQuestion = new Map<string, number>();
  const reviewByQuestion = new Map<string, Attempt[]>();
  const reviewWrongQuestionIds = new Set<string>();
  const reviewWeakModules: Record<string, number> = Object.create(null);
  const objectiveAttempts = attempts.filter(isObjectiveAttempt);
  let correct = 0;
  let mistakes = 0;

  for (const attempt of objectiveAttempts) {
    if (attempt.result === 'correct') correct += 1;
    else mistakes += 1;
    const reviewRecords = reviewByQuestion.get(attempt.questionId) ?? [];
    reviewRecords.push(attempt);
    reviewByQuestion.set(attempt.questionId, reviewRecords);
    if (attempt.result !== 'correct') {
      reviewWrongQuestionIds.add(attempt.questionId);
      reviewWeakModules[attempt.moduleId] = (reviewWeakModules[attempt.moduleId] ?? 0) + 1;
    }

    const date = parseAttemptDay(attempt);
    const daily = date ? dailyByDay.get(date) : undefined;
    if (daily) {
      daily.attempts += 1;
      if (attempt.result === 'correct') daily.correct += 1;
      if (attempt.result === 'wrong') daily.wrong += 1;
      if (attempt.result === 'revealed') daily.revealed += 1;
    }
    if (date && attempt.result !== 'correct' && trendByDay.has(date)) {
      trendByDay.set(date, (trendByDay.get(date) ?? 0) + 1);
    }

    const moduleStat = moduleById.get(attempt.moduleId) ?? {
      moduleId: attempt.moduleId,
      title: moduleTitles.get(attempt.moduleId) ?? attempt.moduleId,
      attempts: 0,
      correct: 0,
      wrong: 0,
      revealed: 0,
      accuracy: 0,
      averageElapsedMs: 0,
      elapsedTotal: 0
    };
    moduleStat.attempts += 1;
    moduleStat.elapsedTotal += Math.max(0, attempt.elapsedMs);
    if (attempt.result === 'correct') moduleStat.correct += 1;
    if (attempt.result === 'wrong') moduleStat.wrong += 1;
    if (attempt.result === 'revealed') moduleStat.revealed += 1;
    moduleById.set(attempt.moduleId, moduleStat);

    const question = questionsById.get(attempt.questionId);
    if (attempt.result === 'wrong') {
      bump(breakdownCounts, 'wrong', '不正解');
      wrongByQuestion.set(attempt.questionId, (wrongByQuestion.get(attempt.questionId) ?? 0) + 1);
      if (question?.type === 'multi_select') bump(breakdownCounts, 'multi_select', '複数選択ミス');
      if (attempt.nearMiss) bump(breakdownCounts, 'near_miss', 'ニアミス');
      if (timingBand(attempt.elapsedMs, answerModeFor(attempt)) === 'fast') bump(breakdownCounts, 'quick_wrong', '即答ミス');
      if (timingBand(attempt.elapsedMs, answerModeFor(attempt)) === 'slow') bump(breakdownCounts, 'slow_wrong', '長考して誤答');
    } else if (attempt.result === 'revealed') {
      bump(breakdownCounts, 'revealed', '答え表示');
      wrongByQuestion.set(attempt.questionId, (wrongByQuestion.get(attempt.questionId) ?? 0) + 1);
    } else if (timingBand(attempt.elapsedMs, answerModeFor(attempt)) === 'slow') {
      bump(breakdownCounts, 'slow_correct', '時間がかかった正解');
    }
  }

  const repeated = [...wrongByQuestion.values()].filter((count) => count >= 2).length;
  if (repeated) bump(breakdownCounts, 'repeated', '繰り返しミス', repeated);

  const reviewAggregation: ReviewAttemptAggregation = {
    byQuestion: reviewByQuestion,
    wrongQuestionIds: reviewWrongQuestionIds,
    weakModules: reviewWeakModules
  };
  const analyses = analyzeProblems(objectiveAttempts, questions, {}, reviewAggregation);
  const repeatedSameWrong = analyses.filter((item) => item.wrongAnswerPatterns.some((pattern) => pattern.count >= 2)).length;
  if (repeatedSameWrong) bump(breakdownCounts, 'repeated_same_wrong', '同じ誤答を反復', repeatedSameWrong);
  const relapse = analyses.filter((item) => item.mistakeTags.includes('正解後に再失敗')).length;
  if (relapse) bump(breakdownCounts, 'failed_after_correct', '正解後に再失敗', relapse);

  return {
    totalAttempts: objectiveAttempts.length,
    correct,
    mistakes,
    dailyStudyStats: [...dailyByDay.values()].map((item) => ({
      ...item,
      accuracy: item.attempts ? item.correct / item.attempts : 0
    })),
    moduleStudyStats: [...moduleById.values()]
      .map(({ elapsedTotal, ...item }) => ({
        ...item,
        accuracy: item.attempts ? item.correct / item.attempts : 0,
        averageElapsedMs: item.attempts ? elapsedTotal / item.attempts : 0
      }))
      .sort((a, b) => b.attempts - a.attempts || a.title.localeCompare(b.title)),
    mistakeTrend: [...trendByDay.entries()].map(([date, mistakes]) => ({ date, mistakes })),
    mistakeBreakdown: [...breakdownCounts.values()].filter((item) => item.count > 0)
  };
}
