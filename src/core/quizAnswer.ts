import { getCorrectAnswer } from './answerJudge';
import type { GeneratedChoiceOption } from './choiceGenerator';
import type { AnswerConfidence, AnswerFormat, Attempt, Question } from './models';
import { scoreAttemptDelta, type AnswerSignals } from './reviewEngine';

export function resolveQuizAnswerMode(
  question: Question,
  requested: AnswerFormat = 'auto',
  generatedChoices?: readonly GeneratedChoiceOption[],
  nativeChoiceCount = 0
): AnswerFormat {
  if (question.type === 'multi_select') return 'choice';
  if (requested === 'input') return 'input';
  if (question.type === 'choice') return nativeChoiceCount >= 2 ? 'choice' : 'input';
  return generatedChoices?.length ? 'choice' : 'input';
}
export function buildQuizAttempt(
  question: Question,
  result: Attempt['result'],
  input: string | string[],
  elapsedMs: number,
  mode: 'normal' | 'review',
  answerMode: AnswerFormat,
  hiddenTimeExcludedMs: number,
  nearMiss = false,
  confidence?: AnswerConfidence,
  signals: AnswerSignals = {}
): Attempt {
  return {
    attemptId: `${Date.now()}-${crypto.randomUUID()}`,
    questionId: question.id,
    moduleId: question.moduleId,
    answeredAt: new Date().toISOString(),
    result,
    input,
    answer: getCorrectAnswer(question),
    elapsedMs,
    mode,
    nearMiss,
    hiddenTimeExcludedMs,
    priorityDelta: scoreAttemptDelta(result, nearMiss, elapsedMs, answerMode, confidence, signals),
    answerMode,
    questionMode: question.activeStudyMode ?? 'as_stored',
    ...(confidence ? { confidence } : {}),
    ...(signals.readingChars ? { readingChars: signals.readingChars } : {}),
    ...(signals.hintUsed ? { hintUsed: true } : {})
  };
}
