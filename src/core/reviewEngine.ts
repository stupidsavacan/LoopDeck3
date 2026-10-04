import { normalizeAnswer, normalizeAnswerForQuestion } from './answerJudge';
import type { AnswerFormat, AnswerResult, Attempt, Question } from './models';

export interface ReviewItem {
  question: Question;
  score: number;
  label: '最優先' | '要復習' | '確認';
  attempts: number;
  lastAttemptAt: number;
}

export interface WrongAnswerPattern {
  answer: string;
  count: number;
}

export interface ProblemAnalysis {
  question: Question;
  total: number;
  correct: number;
  wrong: number;
  revealed: number;
  accuracy: number;
  averageElapsedMs: number;
  reviewScore: number;
  priorityLabel: ReviewItem['label'] | '安定';
  mistakeTags: string[];
  wrongAnswerPatterns: WrongAnswerPattern[];
  lastAttemptAt: number;
  needsAttention: boolean;
}

type TimingBand = 'fast' | 'normal' | 'slow';

const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_REVIEW_LOOKBACK_DAYS = 7;
export const DEFAULT_REVIEW_SCORE_HALF_LIFE_DAYS = 4;

export interface ReviewQueueOptions {
  now?: Date;
  halfLifeDays?: number;
}

export interface ReviewAttemptAggregation {
  byQuestion: ReadonlyMap<string, readonly Attempt[]>;
  wrongQuestionIds: ReadonlySet<string>;
  weakModules: Readonly<Record<string, number>>;
}

export function aggregateReviewAttempts(attempts: Attempt[]): ReviewAttemptAggregation {
  const byQuestion = new Map<string, Attempt[]>();
  const wrongQuestionIds = new Set<string>();
  const weakModules: Record<string, number> = Object.create(null);

  for (const attempt of attempts) {
    const records = byQuestion.get(attempt.questionId) ?? [];
    records.push(attempt);
    byQuestion.set(attempt.questionId, records);
    if (attempt.result !== 'correct') {
      wrongQuestionIds.add(attempt.questionId);
      weakModules[attempt.moduleId] = (weakModules[attempt.moduleId] ?? 0) + 1;
    }
  }

  return { byQuestion, wrongQuestionIds, weakModules };
}

function attemptTime(attempt: Attempt): number {
  const parsed = Date.parse(attempt.answeredAt);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function filterRecentAttempts(attempts: Attempt[], now = new Date(), lookbackDays = DEFAULT_REVIEW_LOOKBACK_DAYS): Attempt[] {
  const cutoff = now.getTime() - Math.max(0, lookbackDays) * DAY_MS;
  const upperBound = now.getTime();
  return attempts.filter((attempt) => {
    const time = attemptTime(attempt);
    return time > 0 && time >= cutoff && time <= upperBound;
  });
}

function recencyWeight(attempt: Attempt, now: Date, halfLifeDays?: number): number {
  if (!halfLifeDays || halfLifeDays <= 0) return 1;
  const time = attemptTime(attempt);
  if (time <= 0) return 0;
  const ageDays = Math.max(0, (now.getTime() - time) / DAY_MS);
  return Math.pow(0.5, ageDays / halfLifeDays);
}

export function answerModeFor(attempt: Pick<Attempt, 'answerMode' | 'input'>): AnswerFormat {
  if (attempt.answerMode === 'choice' || attempt.answerMode === 'input' || attempt.answerMode === 'flashcard') return attempt.answerMode;
  return Array.isArray(attempt.input) ? 'choice' : 'input';
}

export function timingBand(elapsedMs: number, answerMode: AnswerFormat = 'input'): TimingBand {
  if (answerMode === 'flashcard') return 'normal';
  const [fast, slow] = answerMode === 'choice' ? [4500, 12000] : [7000, 20000];
  if (elapsedMs <= fast) return 'fast';
  if (elapsedMs >= slow) return 'slow';
  return 'normal';
}

export function scoreAttemptDelta(result: AnswerResult, nearMiss: boolean, elapsedMs: number, answerMode: AnswerFormat = 'input'): number {
  if (result === 'revealed') return 10;
  if (answerMode === 'flashcard') return result === 'correct' ? -2 : 6;
  if (result === 'wrong' && nearMiss) return 4;
  if (result === 'wrong') return timingBand(elapsedMs, answerMode) === 'fast' ? 8 : 6;
  if (timingBand(elapsedMs, answerMode) === 'fast') return -4;
  if (timingBand(elapsedMs, answerMode) === 'slow') return 3;
  return -2;
}

function attemptDelta(attempt: Attempt): number {
  return attempt.priorityDelta ?? scoreAttemptDelta(attempt.result, Boolean(attempt.nearMiss), attempt.elapsedMs, answerModeFor(attempt));
}

function reviewLabel(score: number): ReviewItem['label'] {
  if (score >= 12) return '最優先';
  if (score >= 5) return '要復習';
  return '確認';
}

function stringifyAnswer(input: string | string[]): string {
  return Array.isArray(input) ? input.join(' / ') : input;
}

function wrongAnswerPatternKey(question: Question, input: string | string[]): string {
  if (Array.isArray(input)) {
    return [...new Set(input.map(normalizeAnswer).filter(Boolean))].sort().join(' / ');
  }
  if (question.type === 'multi_select') return normalizeAnswer(input);
  return normalizeAnswerForQuestion(question, input);
}

export function getWrongQuestionIds(attempts: Attempt[]): string[] {
  const wrong = attempts
    .filter((attempt) => attempt.result === 'wrong' || attempt.result === 'revealed')
    .map((attempt) => attempt.questionId);
  return [...new Set(wrong.reverse())];
}

export function buildMistakeQuestions(allQuestions: Question[], attempts: Attempt[], aggregation?: ReviewAttemptAggregation): Question[] {
  const wrongIds = aggregation?.wrongQuestionIds ?? new Set(getWrongQuestionIds(attempts));
  return allQuestions.filter((question) => wrongIds.has(question.id));
}

export function summarizeWeakModules(attempts: Attempt[], aggregation?: ReviewAttemptAggregation): Record<string, number> {
  if (aggregation) return { ...aggregation.weakModules };
  return attempts.reduce<Record<string, number>>((acc, attempt) => {
    if (attempt.result === 'correct') return acc;
    acc[attempt.moduleId] = (acc[attempt.moduleId] ?? 0) + 1;
    return acc;
  }, Object.create(null));
}

export function buildReviewQueue(
  attempts: Attempt[],
  questions: Question[],
  options: ReviewQueueOptions = {},
  aggregation: ReviewAttemptAggregation = aggregateReviewAttempts(attempts)
): ReviewItem[] {
  const byQuestion = new Map(questions.map((question) => [question.id, question]));
  const now = options.now ?? new Date();

  return [...aggregation.byQuestion.entries()]
    .map(([questionId, records]) => {
      const question = byQuestion.get(questionId);
      if (!question) return undefined;
      const rawScore = records.reduce(
        (total, attempt) => total + attemptDelta(attempt) * recencyWeight(attempt, now, options.halfLifeDays),
        0
      );
      const score = Math.round(rawScore * 10) / 10;
      if (score <= 0) return undefined;
      return {
        question,
        score,
        label: reviewLabel(score),
        attempts: records.length,
        lastAttemptAt: Math.max(...records.map(attemptTime))
      } satisfies ReviewItem;
    })
    .filter((item): item is ReviewItem => Boolean(item))
    .sort((a, b) => b.score - a.score || b.lastAttemptAt - a.lastAttemptAt);
}

export function analyzeProblems(
  attempts: Attempt[],
  questions: Question[],
  options: ReviewQueueOptions = {},
  aggregation: ReviewAttemptAggregation = aggregateReviewAttempts(attempts)
): ProblemAnalysis[] {
  const queueScores = new Map(buildReviewQueue(attempts, questions, options, aggregation).map((item) => [item.question.id, item.score]));
  const byQuestion = new Map(questions.map((question) => [question.id, question]));

  return [...aggregation.byQuestion.entries()]
    .map(([questionId, rawRecords]) => {
      const question = byQuestion.get(questionId);
      if (!question) return undefined;
      const records = [...rawRecords].sort((a, b) => attemptTime(a) - attemptTime(b));
      const wrongRecords = records.filter((attempt) => attempt.result === 'wrong');
      const correctRecords = records.filter((attempt) => attempt.result === 'correct');
      const revealedRecords = records.filter((attempt) => attempt.result === 'revealed');
      const tags: string[] = [];

      if (revealedRecords.length) tags.push(`答え表示 ${revealedRecords.length}回`);
      const nearMissCount = wrongRecords.filter((attempt) => attempt.nearMiss).length;
      if (nearMissCount) tags.push(`ニアミス ${nearMissCount}回`);
      if (wrongRecords.some((attempt) => timingBand(attempt.elapsedMs, answerModeFor(attempt)) === 'fast')) tags.push('即答ミス');
      if (wrongRecords.some((attempt) => timingBand(attempt.elapsedMs, answerModeFor(attempt)) === 'slow')) tags.push('長考して誤答');
      if (correctRecords.some((attempt) => timingBand(attempt.elapsedMs, answerModeFor(attempt)) === 'slow'))
        tags.push('正解だが想起が遅い');

      const wrongAnswerPatterns = [
        ...wrongRecords
          .reduce<Map<string, WrongAnswerPattern>>((acc, attempt) => {
            const key = wrongAnswerPatternKey(question, attempt.input);
            if (!key) return acc;
            const current = acc.get(key);
            if (current) current.count += 1;
            else acc.set(key, { answer: stringifyAnswer(attempt.input).trim(), count: 1 });
            return acc;
          }, new Map())
          .values()
      ]
        .sort((a, b) => b.count - a.count)
        .slice(0, 3);
      if (wrongAnswerPatterns.some((pattern) => pattern.count >= 2)) tags.push('同じ誤答を反復');

      const firstCorrectIndex = records.findIndex((attempt) => attempt.result === 'correct');
      if (firstCorrectIndex >= 0 && records.slice(firstCorrectIndex + 1).some((attempt) => attempt.result !== 'correct')) {
        tags.push('正解後に再失敗');
      }
      if (!tags.length && wrongRecords.length) tags.push('単発の誤答');

      const reviewScore = queueScores.get(questionId) ?? 0;
      const lastAttemptAt = Math.max(...records.map(attemptTime));
      const averageElapsedMs = records.reduce((total, attempt) => total + Math.max(0, attempt.elapsedMs), 0) / records.length;
      const failures = wrongRecords.length + revealedRecords.length;

      return {
        question,
        total: records.length,
        correct: correctRecords.length,
        wrong: wrongRecords.length,
        revealed: revealedRecords.length,
        accuracy: records.length ? correctRecords.length / records.length : 0,
        averageElapsedMs,
        reviewScore,
        priorityLabel: reviewScore > 0 ? reviewLabel(reviewScore) : '安定',
        mistakeTags: tags,
        wrongAnswerPatterns,
        lastAttemptAt,
        needsAttention: reviewScore > 0 || failures > 0 || tags.includes('正解だが想起が遅い')
      } satisfies ProblemAnalysis;
    })
    .filter((item): item is ProblemAnalysis => Boolean(item))
    .sort(
      (a, b) => Number(b.needsAttention) - Number(a.needsAttention) || b.reviewScore - a.reviewScore || b.lastAttemptAt - a.lastAttemptAt
    );
}
