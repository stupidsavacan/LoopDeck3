import type { AnswerFormat } from './models';

/** Text a learner reads in the base thresholds without any allowance; about one short prompt. */
const BASE_READING_CHARS = 30;
const MAX_EXTRA_READING_CHARS = 400;
const FAST_MS_PER_EXTRA_CHAR = 50;
const SLOW_MS_PER_EXTRA_CHAR = 120;

/**
 * Answer time stands in for a self-rating so the learner never has to grade every card.
 * A long prompt or long choices take longer to read, not to remember, so the bands widen with the text.
 */
export function timingThresholds(answerMode: AnswerFormat, readingChars = 0): { fast: number; slow: number } {
  const [fast, slow] = answerMode === 'choice' ? [4500, 12000] : [7000, 20000];
  const extra = Math.min(MAX_EXTRA_READING_CHARS, Math.max(0, readingChars - BASE_READING_CHARS));
  return { fast: fast + extra * FAST_MS_PER_EXTRA_CHAR, slow: slow + extra * SLOW_MS_PER_EXTRA_CHAR };
}

export function countReadingChars(prompt: string, choices: readonly string[] = []): number {
  return [prompt, ...choices].reduce((total, text) => total + [...text.replace(/\s+/g, '')].length, 0);
}
