// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import type { AnswerResult, Attempt, ModuleInfo, Question } from '../src/core/models';
import { createSession, restartWithSessionMistakes, sessionMistakeQuestions, type QuizSession } from '../src/core/sessionEngine';
import { getUnresolvedMistakeIds } from '../src/core/unresolvedMistakes';
import { renderInlineQuiz } from '../src/screens/inlineQuiz';
import { studyStore } from '../src/storage/studyRepository';

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

const moduleInfo: ModuleInfo = { id: 'm', folderId: 'test', title: 'Mistakes', subject: 'test', questionIds: ['a', 'b', 'c'] };
const questions: Question[] = ['a', 'b', 'c'].map((id) => ({ id, moduleId: 'm', type: 'input', prompt: `${id}?`, answer: `${id}!` }));
const settings = { shuffle: false, autoNext: false, questionLimit: 'all' as const, answerFormat: 'input' as const };

function completedSession(results: Record<string, AnswerResult>): QuizSession {
  const session = createSession(moduleInfo, questions, settings);
  return { ...session, index: session.queue.length, attempts: session.queue.map((q) => attempt(q.id, results[q.id])) };
}

describe("retrying this round's mistakes", () => {
  it('keeps only wrong or revealed questions, in queue order, as a fresh round', () => {
    const done = completedSession({ a: 'wrong', b: 'correct', c: 'revealed' });
    expect(sessionMistakeQuestions(done).map((q) => q.id)).toEqual(['a', 'c']);
    const next = restartWithSessionMistakes(done, 42);
    expect(next.queue.map((q) => q.id)).toEqual(['a', 'c']);
    expect(next).toMatchObject({ index: 0, attempts: [], startedAt: 42, sessionElapsedMs: 0 });
  });

  it('offers the retry on the completion card and starts the narrowed round', () => {
    vi.spyOn(studyStore, 'hasBookmark').mockResolvedValue(false);
    const container = document.createElement('div');
    const onSessionChange = vi.fn();
    renderInlineQuiz(
      container,
      completedSession({ a: 'wrong', b: 'correct', c: 'correct' }),
      { onSessionChange, onComplete: vi.fn() },
      { store: studyStore }
    );
    expect(container.querySelector('.session-mistake')?.textContent).toContain('a!');
    const retry = [...container.querySelectorAll('button')].find((b) => b.textContent === 'ミスだけもう一度 (1問)');
    retry?.click();
    expect(onSessionChange).toHaveBeenCalledTimes(1);
    expect((onSessionChange.mock.calls[0][0] as QuizSession).queue.map((q) => q.id)).toEqual(['a']);
  });

  it('shows no retry when the round had no mistakes', () => {
    const container = document.createElement('div');
    renderInlineQuiz(
      container,
      completedSession({ a: 'correct', b: 'correct', c: 'correct' }),
      { onSessionChange: vi.fn(), onComplete: vi.fn() },
      { store: studyStore }
    );
    expect(container.querySelector('.session-mistakes')).toBeNull();
    expect([...container.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['教材詳細に戻る']);
  });
});
