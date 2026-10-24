import { describe, expect, it } from 'vitest';
import type { AnswerResult, Attempt } from '../src/core/models';
import { getUnresolvedMistakeIds } from '../src/core/unresolvedMistakes';

let clock = Date.parse('2026-10-01T00:00:00.000Z');
function attempt(questionId: string, result: AnswerResult, extra: Partial<Attempt> = {}): Attempt {
  clock += 1000;
  return {
    attemptId: `${questionId}-${clock}`,
    questionId,
    moduleId: 'm',
    answeredAt: new Date(clock).toISOString(),
    result,
    input: '',
    answer: '',
    elapsedMs: 1000,
    mode: 'normal',
    answerMode: 'choice',
    ...extra
  };
}

describe('unresolved mistakes', () => {
  it('keeps a mistake until two consecutive correct answers follow it', () => {
    const wrong = attempt('q', 'wrong');
    const firstCorrect = attempt('q', 'correct');
    expect(getUnresolvedMistakeIds([wrong])).toEqual(new Set(['q']));
    expect(getUnresolvedMistakeIds([wrong, firstCorrect])).toEqual(new Set(['q']));
    expect(getUnresolvedMistakeIds([wrong, firstCorrect, attempt('q', 'correct')])).toEqual(new Set());
  });

  it('restarts the streak on a later mistake or reveal', () => {
    const history = [attempt('q', 'wrong'), attempt('q', 'correct'), attempt('q', 'revealed'), attempt('q', 'correct')];
    expect(getUnresolvedMistakeIds(history)).toEqual(new Set(['q']));
  });

  it('ignores questions that were never missed', () => {
    expect(getUnresolvedMistakeIds([attempt('q', 'correct')])).toEqual(new Set());
  });

  it('never lets flashcard self-ratings add or clear a mistake', () => {
    const flashcard = { answerMode: 'flashcard' as const };
    expect(getUnresolvedMistakeIds([attempt('a', 'wrong', flashcard)])).toEqual(new Set());
    const history = [attempt('b', 'wrong'), attempt('b', 'correct', flashcard), attempt('b', 'correct', flashcard)];
    expect(getUnresolvedMistakeIds(history)).toEqual(new Set(['b']));
  });

  it('shares one streak across study directions', () => {
    const history = [
      attempt('q', 'wrong', { questionMode: 'front_to_back' }),
      attempt('q', 'correct', { questionMode: 'back_to_front' }),
      attempt('q', 'correct', { questionMode: 'front_to_back' })
    ];
    expect(getUnresolvedMistakeIds(history)).toEqual(new Set());
  });

  it('orders by answer time rather than storage order', () => {
    const wrong = attempt('q', 'wrong');
    const correct = [attempt('q', 'correct'), attempt('q', 'correct')];
    expect(getUnresolvedMistakeIds([...correct, wrong])).toEqual(new Set());
  });
});
