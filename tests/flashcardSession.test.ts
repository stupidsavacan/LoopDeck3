// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Attempt, InputQuestion } from '../src/core/models';
import { getCorrectAnswer } from '../src/core/answerJudge';
import { createSession, type QuizSession } from '../src/core/sessionEngine';
import { renderFlashcardSession, disposeFlashcardSessions } from '../src/screens/flashcardSession';
import { readStoredSession, restoreStoredSession, saveStoredSession } from '../src/storage/sessionStorage';
import { readStudyPreferences, sanitizeStudyPreferences, writeStudyPreferences } from '../src/storage/studyPreferences';

const question: InputQuestion = {
  id: 'flash-q',
  moduleId: 'flash-m',
  type: 'input',
  prompt: 'strict',
  answer: '厳しい',
  example: 'a strict rule'
};
const module = { id: 'flash-m', folderId: '', title: 'カード', subject: '英語', questionIds: ['flash-q', 'flash-next'] };
const settings = {
  shuffle: false,
  autoNext: true,
  autoRevealAfterIdle: true,
  questionLimit: 'all' as const,
  answerFormat: 'flashcard' as const,
  questionMode: 'mixed' as const,
  showExample: true
};
let container: HTMLElement;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-04T01:00:00Z'));
  vi.spyOn(performance, 'now').mockImplementation(() => Date.now());
  localStorage.clear();
  container = document.createElement('div');
  document.body.append(container);
});
afterEach(() => {
  disposeFlashcardSessions(container);
  container.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function setup(persist = vi.fn(async (_attempt: Attempt) => {}), session?: QuizSession) {
  const quiz =
    session ?? createSession(module, [question, { ...question, id: 'flash-next', prompt: 'agree', answer: '賛成する' }], settings);
  const callbacks = { onSessionChange: vi.fn(), onSessionCheckpoint: vi.fn(), onComplete: vi.fn() };
  const store = { recordAnswer: persist, hasBookmark: async () => false, setBookmark: async () => {} };
  renderFlashcardSession(container, quiz, callbacks, { store });
  return { session: quiz, callbacks, store, persist, wrap: container.querySelector<HTMLElement>('.flashcard-wrap')! };
}
function pointer(node: HTMLElement, type: string, x: number, y = 0, id = 1): void {
  const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 });
  Object.defineProperty(event, 'pointerId', { value: id });
  node.dispatchEvent(event);
}
function button(label: string): HTMLButtonElement {
  return [...container.querySelectorAll('button')].find((button) => button.textContent === label)!;
}

describe('flashcard session rendering and lifecycle', () => {
  it('pre-renders both faces, flips next frame on a tap, and does not save a judgment', async () => {
    const { wrap, persist, session } = setup();
    expect(container.querySelector('.flashcard-front')?.textContent).toContain(session.queue[0].prompt);
    expect(container.querySelector('.flashcard-back')?.textContent).toContain(String(getCorrectAnswer(session.queue[0])));
    expect(container.querySelector('.flashcard-back')?.textContent).toContain('a strict rule');
    expect(container.querySelectorAll('select')).toHaveLength(0);
    pointer(wrap, 'pointerdown', 10);
    await vi.advanceTimersByTimeAsync(100);
    pointer(wrap, 'pointerup', 10);
    expect(wrap.classList.contains('is-flipped')).toBe(false);
    await vi.advanceTimersByTimeAsync(17);
    expect(wrap.classList.contains('is-flipped')).toBe(true);
    expect(container.querySelector('.flashcard-front')?.getAttribute('aria-hidden')).toBe('true');
    expect(persist).not.toHaveBeenCalled();
  });
  it('keeps drag and flip on separate layers and restores an unconfirmed drag', async () => {
    const { wrap, persist } = setup();
    wrap.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    await vi.advanceTimersByTimeAsync(40);
    pointer(wrap, 'pointerdown', 0);
    pointer(wrap, 'pointermove', 20);
    await vi.advanceTimersByTimeAsync(1000);
    pointer(wrap, 'pointerup', 20);
    expect(wrap.classList.contains('is-flipped')).toBe(true);
    expect(wrap.style.transform).toBe('none');
    expect(wrap.style.transition).toContain('180ms');
    expect(persist).not.toHaveBeenCalled();
  });
  it.each([
    [120, 'correct'],
    [-120, 'wrong']
  ] as const)('self-grades swipe %d and locks double gestures', async (dx, result) => {
    const { wrap, persist, callbacks } = setup();
    pointer(wrap, 'pointerdown', 0);
    pointer(wrap, 'pointermove', dx);
    expect(container.querySelector(`.flashcard-judge-label.${dx > 0 ? 'known' : 'again'}`)?.classList.contains('show')).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    pointer(wrap, 'pointerup', dx);
    pointer(wrap, 'pointerdown', 0);
    pointer(wrap, 'pointerup', dx);
    wrap.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await vi.advanceTimersByTimeAsync(280);
    expect(persist).toHaveBeenCalledOnce();
    expect(persist.mock.calls[0][0]).toMatchObject({
      result,
      input: '',
      nearMiss: false,
      answerMode: 'flashcard',
      questionMode: expect.any(String)
    });
    expect(callbacks.onSessionChange).toHaveBeenCalledOnce();
    expect(callbacks.onSessionCheckpoint.mock.calls.at(-1)?.[0].index).toBe(1);
    expect(wrap.classList.contains('is-flipped')).toBe(false);
  });
  it('cancels an aborted pointer without flipping or judging', async () => {
    const { wrap, persist } = setup();
    pointer(wrap, 'pointerdown', 0);
    pointer(wrap, 'pointermove', 150);
    pointer(wrap, 'pointercancel', 150);
    await vi.advanceTimersByTimeAsync(500);
    expect(persist).not.toHaveBeenCalled();
    expect(wrap.style.transform).toBe('none');
    expect(wrap.classList.contains('is-flipped')).toBe(false);
  });
  it('supports keyboard flip/judgment and ignores key repeat', async () => {
    const { wrap, persist } = setup();
    wrap.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.advanceTimersByTimeAsync(40);
    expect(wrap.classList.contains('is-flipped')).toBe(true);
    wrap.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', repeat: true, bubbles: true }));
    expect(persist).not.toHaveBeenCalled();
    wrap.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    await vi.advanceTimersByTimeAsync(280);
    expect(persist.mock.calls[0][0].result).toBe('wrong');
  });
  it('waits for the atomic save even when the exit animation has finished', async () => {
    let resolve!: () => void;
    const persist = vi.fn(
      (_attempt: Attempt) =>
        new Promise<void>((done) => {
          resolve = done;
        })
    );
    const { callbacks } = setup(persist);
    button('知ってる →').click();
    await vi.advanceTimersByTimeAsync(1000);
    expect(callbacks.onSessionChange).not.toHaveBeenCalled();
    expect(callbacks.onSessionCheckpoint).not.toHaveBeenCalled();
    resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(callbacks.onSessionChange).toHaveBeenCalledOnce();
    expect(callbacks.onSessionCheckpoint.mock.calls.at(-1)?.[0].index).toBe(1);
  });
  it('retries the same failed attempt without changing the card or allowing a second grade', async () => {
    const persist = vi.fn(async (_attempt: Attempt) => {});
    persist.mockRejectedValueOnce(new Error('disk full'));
    const { callbacks } = setup(persist);
    button('知ってる →').click();
    await vi.advanceTimersByTimeAsync(300);
    expect(callbacks.onSessionChange).not.toHaveBeenCalled();
    expect(button('知ってる →').disabled).toBe(true);
    button('保存を再試行').click();
    await vi.advanceTimersByTimeAsync(300);
    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist.mock.calls[0][0]).toBe(persist.mock.calls[1][0]);
    expect(callbacks.onSessionChange).toHaveBeenCalledOnce();
  });
  it('cleans up stale persistence completions and document keyboard handlers', async () => {
    let resolve!: () => void;
    const persist = vi.fn(
      (_attempt: Attempt) =>
        new Promise<void>((done) => {
          resolve = done;
        })
    );
    const { callbacks } = setup(persist);
    button('知ってる →').click();
    disposeFlashcardSessions(container);
    resolve();
    await vi.advanceTimersByTimeAsync(1000);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(callbacks.onSessionChange).not.toHaveBeenCalled();
    expect(callbacks.onSessionCheckpoint).not.toHaveBeenCalled();
    expect(persist).toHaveBeenCalledOnce();
  });
  it('renders the full result and repeats missed/all queues with concrete directions preserved', async () => {
    const { callbacks } = setup();
    button('知ってる →').click();
    await vi.advanceTimersByTimeAsync(280);
    const next = callbacks.onSessionChange.mock.calls[0][0];
    const second = setup(undefined, next);
    button('← 知らない').click();
    await vi.advanceTimersByTimeAsync(280);
    const complete = second.callbacks.onSessionChange.mock.calls[0][0];
    const result = setup(undefined, complete);
    expect(container.querySelector('h1')?.textContent).toBe('おつかれさま。');
    expect(container.querySelector('.flashcard-donut-center')?.textContent).toBe('50%KNOWN');
    expect(container.querySelectorAll('.flashcard-stat')).toHaveLength(2);
    expect(container.querySelector('.flashcard-missed-chip')?.textContent).toBe(complete.queue[1].prompt);
    expect([...container.querySelectorAll('.flashcard-result-actions button')].map((button) => button.textContent)).toEqual([
      'AGAINだけもう一度',
      '全部やり直す',
      '教材へ戻る'
    ]);
    button('AGAINだけもう一度').click();
    expect(result.callbacks.onSessionChange.mock.calls[0][0].queue).toEqual([complete.queue[1]]);
    expect(result.callbacks.onSessionChange.mock.calls[0][0].attempts).toEqual([]);
    button('全部やり直す').click();
    expect(result.callbacks.onSessionChange.mock.calls[1][0].queue).toEqual(complete.queue);
  });
  it('round-trips flashcard preferences and resumes the exact mixed direction from the existing session schema', () => {
    expect(writeStudyPreferences('pack', module.id, settings)).toBe(true);
    const stored = readStudyPreferences('pack', module.id);
    expect(
      sanitizeStudyPreferences(settings, stored, { validRanges: ['all'], categories: [], questionModes: ['as_stored', 'mixed'] })
        .answerFormat
    ).toBe('flashcard');
    const { session } = setup();
    expect(saveStoredSession(module.id, session)).toBe(true);
    const originals = session.choicePool;
    const byId = new Map(originals.map((question) => [question.id, question]));
    const checkpoint = readStoredSession(module.id, byId)!;
    expect(checkpoint.version).toBe(1);
    const restored = restoreStoredSession(module, checkpoint, byId, originals)!;
    expect(restored.settings.answerFormat).toBe('flashcard');
    expect(restored.queue.map((question) => question.activeStudyMode)).toEqual(session.queue.map((question) => question.activeStudyMode));
    setup(undefined, restored);
    expect(container.querySelector('.flashcard-wrap.is-flipped')).toBeNull();
  });
});
