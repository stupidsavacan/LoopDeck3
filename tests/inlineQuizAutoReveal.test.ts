// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Attempt, ModuleInfo, Question, StudySettings } from '../src/core/models';
import { createSession } from '../src/core/sessionEngine';
import { renderInlineQuiz } from '../src/screens/inlineQuiz';
import { studyStore } from '../src/storage/studyRepository';

const moduleInfo: ModuleInfo = {
  id: 'auto-reveal-module',
  folderId: 'f',
  title: 'Auto reveal',
  subject: 'test',
  questionIds: ['input-question', 'multi-question', 'second-question']
};

const inputQuestion: Question = {
  id: 'input-question',
  moduleId: moduleInfo.id,
  type: 'input',
  prompt: 'Input answer?',
  answer: 'answer',
  example: 'first hint'
};

const multiQuestion: Question = {
  id: 'multi-question',
  moduleId: moduleInfo.id,
  type: 'multi_select',
  prompt: 'Select answers',
  choices: ['A', 'B', 'C'],
  correctChoices: ['A', 'B']
};

const choiceQuestion: Question = {
  id: 'choice-question',
  moduleId: moduleInfo.id,
  type: 'choice',
  prompt: 'Choose one',
  choices: ['A', 'B', 'C'],
  answer: 'B'
};

const secondQuestion: Question = {
  ...inputQuestion,
  id: 'second-question',
  prompt: 'Second answer?'
};

const reversibleQuestion: Question = {
  id: 'reversible-question',
  moduleId: moduleInfo.id,
  type: 'input',
  prompt: 'front',
  answer: 'back',
  supportedStudyModes: ['front_to_back', 'back_to_front'],
  sides: {
    front: { label: 'Front', text: 'front' },
    back: { label: 'Back', text: 'back' }
  }
};

function settings(overrides: Partial<StudySettings> = {}): StudySettings {
  return {
    shuffle: false,
    autoNext: false,
    autoRevealAfterIdle: true,
    questionLimit: 'all',
    answerFormat: 'input',
    ...overrides
  };
}

function render(
  question: Question,
  overrides: Partial<StudySettings> = {}
): { container: HTMLElement; attempts: Attempt[]; onSessionChange: ReturnType<typeof vi.fn> } {
  const container = document.createElement('div');
  document.body.append(container);
  const attempts: Attempt[] = [];
  vi.spyOn(studyStore, 'hasBookmark').mockResolvedValue(false);
  vi.spyOn(studyStore, 'getReviewCard').mockResolvedValue(undefined);
  vi.spyOn(studyStore, 'recordAnswer').mockImplementation(async (attempt) => {
    attempts.push(attempt);
  });
  const onSessionChange = vi.fn();
  renderInlineQuiz(container, createSession(moduleInfo, [question], settings(overrides)), {
    onSessionChange,
    onComplete() {}
  }, { store: studyStore });
  return { container, attempts, onSessionChange };
}

function setHidden(hidden: boolean): void {
  Object.defineProperty(document, 'hidden', { configurable: true, value: hidden });
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-02T00:00:00.000Z'));
  setHidden(false);
});

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('inline quiz idle auto reveal', () => {
  it('reveals after ten seconds, locks partial input, and records one empty-input attempt without auto-next', async () => {
    const { container, attempts, onSessionChange } = render(inputQuestion, { autoNext: true });
    const input = container.querySelector<HTMLInputElement>('input.text-input')!;
    input.value = 'part';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    await vi.advanceTimersByTimeAsync(9_999);
    expect(container.querySelector('.result')).toBeNull();
    await vi.advanceTimersByTimeAsync(1);

    expect(container.querySelector('.result')?.textContent).toContain('答え表示');
    expect(input.value).toBe('part');
    expect(input.disabled).toBe(true);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ result: 'revealed', input: '' });
    expect(attempts[0].elapsedMs).toBe(10_000);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(attempts).toHaveLength(1);
    expect(onSessionChange).not.toHaveBeenCalled();
  });

  it('also reveals a single-choice question in automatic answer-format mode', async () => {
    const { container, attempts } = render(choiceQuestion, { answerFormat: 'auto' });
    expect(container.querySelectorAll('.choice-btn')).toHaveLength(3);

    await vi.advanceTimersByTimeAsync(10_000);

    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ result: 'revealed', input: '', answerMode: 'choice' });
  });

  it('resets on paste activity', async () => {
    const { container, attempts } = render(inputQuestion);
    const input = container.querySelector<HTMLInputElement>('input.text-input')!;
    await vi.advanceTimersByTimeAsync(9_000);
    input.dispatchEvent(new Event('paste', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(9_999);
    expect(attempts).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts).toHaveLength(1);
  });

  it('resets only when the input value actually changes and when the first hint is displayed', async () => {
    const { container, attempts } = render(inputQuestion);
    const input = container.querySelector<HTMLInputElement>('input.text-input')!;
    const hint = [...container.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === 'ヒント')!;

    await vi.advanceTimersByTimeAsync(8_000);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(1_000);
    input.value = 'x';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(9_000);
    hint.click();
    await vi.advanceTimersByTimeAsync(9_000);
    hint.click();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(attempts).toHaveLength(1);
    expect(attempts[0].result).toBe('revealed');
  });

  it('resets after each multi-select selection change', async () => {
    const { container, attempts } = render(multiQuestion, { answerFormat: 'auto' });
    const choice = [...container.querySelectorAll<HTMLButtonElement>('.choice-btn')].find((item) => item.textContent === 'A')!;

    await vi.advanceTimersByTimeAsync(9_000);
    choice.click();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(attempts).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);

    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ result: 'revealed', input: '' });
    expect(choice.disabled).toBe(true);
    expect(choice.classList.contains('selected')).toBe(true);
  });

  it('pauses while hidden, excludes hidden answer time, and resumes from the remaining idle time', async () => {
    const { attempts } = render(inputQuestion);
    await vi.advanceTimersByTimeAsync(6_000);
    setHidden(true);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(attempts).toHaveLength(0);

    setHidden(false);
    await vi.advanceTimersByTimeAsync(3_999);
    expect(attempts).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);

    expect(attempts).toHaveLength(1);
    expect(attempts[0].elapsedMs).toBe(10_000);
    expect(attempts[0].hiddenTimeExcludedMs).toBe(20_000);
  });

  it('excludes hidden time from manual answers even when auto reveal is disabled', async () => {
    const { container, attempts } = render(inputQuestion, { autoRevealAfterIdle: false });
    const input = container.querySelector<HTMLInputElement>('input.text-input')!;
    const submit = [...container.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === '回答する')!;

    await vi.advanceTimersByTimeAsync(2_000);
    setHidden(true);
    await vi.advanceTimersByTimeAsync(20_000);
    setHidden(false);
    await vi.advanceTimersByTimeAsync(1_000);
    input.value = 'answer';
    submit.click();
    await vi.advanceTimersByTimeAsync(0);

    expect(attempts).toHaveLength(1);
    expect(attempts[0].elapsedMs).toBe(3_000);
    expect(attempts[0].hiddenTimeExcludedMs).toBe(20_000);
  });

  it('treats a large visible scheduling gap as suspension instead of idle time', async () => {
    const { attempts } = render(inputQuestion);
    await vi.advanceTimersByTimeAsync(4_000);
    vi.setSystemTime(new Date('2026-09-02T01:00:04.000Z'));
    await vi.advanceTimersByTimeAsync(250);
    expect(attempts).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(5_999);
    expect(attempts).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].elapsedMs).toBe(10_000);
    expect(attempts[0].hiddenTimeExcludedMs).toBeGreaterThan(3_600_000);
  });

  it('does not reveal during IME composition and restarts the full delay after composition ends', async () => {
    const { container, attempts } = render(inputQuestion);
    const input = container.querySelector<HTMLInputElement>('input.text-input')!;
    await vi.advanceTimersByTimeAsync(9_000);
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true }));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(attempts).toHaveLength(0);

    input.value = '入力中';
    input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(9_999);
    expect(attempts).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts).toHaveLength(1);
  });

  it('cleans up stale renders and cannot double-record after a manual answer', async () => {
    const { container, attempts } = render(inputQuestion);
    const secondSession = createSession(moduleInfo, [secondQuestion], settings());
    renderInlineQuiz(container, secondSession, { onSessionChange() {}, onComplete() {} }, { store: studyStore });

    await vi.advanceTimersByTimeAsync(5_000);
    const reveal = [...container.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === '答えを見る')!;
    reveal.click();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(attempts).toHaveLength(1);
    expect(attempts[0].questionId).toBe(secondQuestion.id);
    expect(container.querySelectorAll('.result')).toHaveLength(1);
  });

  it('records the concrete presented question mode on attempts', async () => {
    const { container, attempts } = render(reversibleQuestion, {
      autoRevealAfterIdle: false,
      answerFormat: 'input',
      questionMode: 'back_to_front'
    });
    const input = container.querySelector<HTMLInputElement>('input.text-input')!;
    const submit = [...container.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === '回答する')!;

    expect(container.querySelector('.question-prompt')?.textContent).toBe('back');
    input.value = 'front';
    submit.click();
    await vi.advanceTimersByTimeAsync(0);

    expect(attempts).toHaveLength(1);
    expect(attempts[0].questionMode).toBe('back_to_front');
  });

  it('does not record after the rendered container is detached', async () => {
    const { container, attempts } = render(inputQuestion);
    container.remove();

    await vi.advanceTimersByTimeAsync(30_000);

    expect(attempts).toHaveLength(0);
  });

  it('stays disabled when the optional setting is absent', async () => {
    const { attempts } = render(inputQuestion, { autoRevealAfterIdle: undefined });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(attempts).toHaveLength(0);
  });
});
