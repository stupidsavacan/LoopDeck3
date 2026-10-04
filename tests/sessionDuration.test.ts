// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModuleInfo, Question } from '../src/core/models';
import { advanceSession, createSession, elapsedForSession, type QuizSession } from '../src/core/sessionEngine';
import { disposeInlineQuizzes, renderInlineQuiz } from '../src/screens/inlineQuiz';
import { readStoredSession, restoreStoredSession, saveStoredSession } from '../src/storage/sessionStorage';
import type { QuizDataStore } from '../src/storage/storageTypes';
const store: QuizDataStore = { recordAnswer: async () => {}, hasBookmark: async () => false, setBookmark: async () => {} };
import { renderSessionSummary } from '../src/ui/inlineQuizView';

const moduleInfo: ModuleInfo = { id: 'duration', folderId: 'test', title: 'Duration', subject: 'test', questionIds: ['q'] };
const question: Question = { id: 'q', moduleId: moduleInfo.id, type: 'input', prompt: 'Question?', answer: 'answer' };
const byId = new Map([[question.id, question]]);
const settings = { shuffle: false, autoNext: false, questionLimit: 'all' as const, answerFormat: 'input' as const };

function summaryTime(session: QuizSession): string | null | undefined {
  return [...renderSessionSummary(session).querySelectorAll('.summary-stat')]
    .find((item) => item.querySelector('span')?.textContent === '所要時間')
    ?.querySelector('strong')?.textContent;
}
function setHidden(hidden: boolean): void {
  Object.defineProperty(document, 'hidden', { configurable: true, value: hidden });
  document.dispatchEvent(new Event('visibilitychange'));
}
beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-01T09:00:00Z'));
  setHidden(false);
});
afterEach(() => {
  disposeInlineQuizzes(document.body);
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('active session duration', () => {
  it('excludes an eight-hour offline gap and freezes completed summaries across repeated resumes', () => {
    const session = createSession(moduleInfo, [question], settings);
    vi.advanceTimersByTime(5 * 60_000);
    saveStoredSession(moduleInfo.id, session);
    vi.advanceTimersByTime(8 * 60 * 60_000);
    const resumed = restoreStoredSession(moduleInfo, readStoredSession(moduleInfo.id, byId)!, byId, [question])!;
    expect(resumed.startedAt).toBe(session.startedAt);
    expect(elapsedForSession(resumed)).toBe(5 * 60_000);
    vi.advanceTimersByTime(60_000);
    const done = advanceSession(resumed);
    expect(summaryTime(done)).toBe('6分00秒');
    saveStoredSession(moduleInfo.id, done);
    vi.advanceTimersByTime(24 * 60 * 60_000);
    const reopened = restoreStoredSession(moduleInfo, readStoredSession(moduleInfo.id, byId)!, byId, [question])!;
    expect(summaryTime(reopened)).toBe('6分00秒');
    saveStoredSession(moduleInfo.id, reopened);
    expect(readStoredSession(moduleInfo.id, byId)?.sessionElapsedMs).toBe(6 * 60_000);
  });

  it('uses recorded active answer time for older LoopDeck3 records with no duration field', () => {
    const session = createSession(moduleInfo, [question], settings);
    vi.advanceTimersByTime(60_000);
    saveStoredSession(moduleInfo.id, { ...session, currentElapsedMs: 5000 });
    const stored = readStoredSession(moduleInfo.id, byId)!;
    delete stored.sessionElapsedMs;
    vi.advanceTimersByTime(8 * 60 * 60_000);
    const resumed = restoreStoredSession(moduleInfo, stored, byId, [question])!;
    expect(elapsedForSession(resumed)).toBe(5000);
  });

  it.each([-1, Infinity, 'bad'])('rejects invalid accumulated duration %s', (duration) => {
    saveStoredSession(moduleInfo.id, createSession(moduleInfo, [question], settings));
    const stored = JSON.parse(localStorage.getItem(`loopdeck3.session.${moduleInfo.id}`)!);
    stored.sessionElapsedMs = duration;
    localStorage.setItem(`loopdeck3.session.${moduleInfo.id}`, JSON.stringify(stored));
    expect(readStoredSession(moduleInfo.id, byId)).toBeUndefined();
  });

  it('excludes hidden time before and after answering, while counting visible feedback time', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const onSessionChange = vi.fn();
    renderInlineQuiz(
      container,
      createSession(moduleInfo, [question], settings),
      {
        onSessionChange,
        onSessionCheckpoint: (session) => saveStoredSession(moduleInfo.id, session),
        onComplete() {}
      },
      { store }
    );
    vi.advanceTimersByTime(2000);
    setHidden(true);
    vi.advanceTimersByTime(60_000);
    setHidden(false);
    vi.advanceTimersByTime(3000);
    container.querySelector<HTMLInputElement>('.text-input')!.value = 'answer';
    [...container.querySelectorAll('button')].find((button) => button.textContent === '回答する')!.click();
    await vi.advanceTimersByTimeAsync(0);
    vi.advanceTimersByTime(1000);
    setHidden(true);
    vi.advanceTimersByTime(60_000);
    setHidden(false);
    vi.advanceTimersByTime(1000);
    [...container.querySelectorAll('button')].find((button) => button.textContent === '次へ')!.click();
    const done = onSessionChange.mock.calls[0][0] as QuizSession;
    expect(done.attempts[0].elapsedMs).toBe(5000);
    expect(summaryTime(done)).toBe('7秒');
  });
});
