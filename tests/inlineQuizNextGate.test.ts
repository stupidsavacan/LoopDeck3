// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModuleInfo, Question } from '../src/core/models';
import { createSession } from '../src/core/sessionEngine';
import { renderInlineQuiz } from '../src/screens/inlineQuiz';
import { studyStore } from '../src/storage/studyRepository';

const moduleInfo: ModuleInfo = {
  id: 'next-gate-module',
  folderId: 'test',
  title: 'Next gate',
  subject: 'test',
  questionIds: ['input-q', 'choice-q']
};

const inputQuestion: Question = {
  id: 'input-q',
  moduleId: moduleInfo.id,
  type: 'input',
  prompt: 'Input?',
  answer: 'answer'
};

const choiceQuestion: Question = {
  id: 'choice-q',
  moduleId: moduleInfo.id,
  type: 'choice',
  prompt: 'Choice?',
  choices: ['A', 'B', 'C'],
  answer: 'B'
};

function stubPersistence(): void {
  vi.spyOn(studyStore, 'hasBookmark').mockResolvedValue(false);
  vi.spyOn(studyStore, 'getReviewCard').mockResolvedValue(undefined);
  vi.spyOn(studyStore, 'recordAnswer').mockResolvedValue();
}

describe('inline quiz Next gating', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    stubPersistence();
  });

  it('cannot advance an input question before answering, then advances only after persistence succeeds', async () => {
    let finishSave: () => void = () => {};
    vi.spyOn(studyStore, 'recordAnswer').mockReturnValue(
      new Promise<void>((resolve) => {
        finishSave = resolve;
      })
    );
    const container = document.createElement('div');
    const onSessionChange = vi.fn();
    const onSessionCheckpoint = vi.fn();
    const session = createSession(moduleInfo, [inputQuestion], {
      shuffle: false,
      autoNext: false,
      questionLimit: 'all',
      answerFormat: 'input'
    });

    renderInlineQuiz(container, session, { onSessionChange, onSessionCheckpoint, onComplete() {} }, { store: studyStore });

    const next = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '次へ')!;
    const input = container.querySelector<HTMLInputElement>('input.text-input')!;
    const submit = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '回答する')!;

    expect(next.disabled).toBe(true);
    next.click();
    expect(onSessionChange).not.toHaveBeenCalled();

    input.value = 'answer';
    submit.click();

    expect(next.disabled).toBe(true);
    expect(onSessionCheckpoint).not.toHaveBeenCalled();
    finishSave();
    await vi.waitFor(() => expect(next.disabled).toBe(false));
    expect(onSessionCheckpoint).toHaveBeenCalledTimes(1);
    expect(onSessionCheckpoint.mock.calls[0][0]).toMatchObject({
      index: 1,
      attempts: [expect.objectContaining({ questionId: inputQuestion.id })]
    });
    next.click();

    expect(onSessionChange).toHaveBeenCalledTimes(1);
    const advanced = onSessionChange.mock.calls[0][0];
    expect(advanced.index).toBe(1);
    expect(advanced.attempts).toHaveLength(1);
    expect(advanced.attempts[0]).toMatchObject({
      questionId: inputQuestion.id,
      result: 'correct',
      input: 'answer'
    });
  });

  it('enables Next after revealing the answer and persisting it', async () => {
    const container = document.createElement('div');
    const session = createSession(moduleInfo, [inputQuestion], {
      shuffle: false,
      autoNext: false,
      questionLimit: 'all',
      answerFormat: 'input'
    });

    renderInlineQuiz(container, session, { onSessionChange() {}, onComplete() {} }, { store: studyStore });

    const next = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '次へ')!;
    const reveal = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '答えを見る')!;

    expect(next.disabled).toBe(true);
    reveal.click();
    expect(next.disabled).toBe(true);
    await vi.waitFor(() => expect(next.disabled).toBe(false));
  });

  it('keeps Next disabled for a choice question until an option is durably recorded', async () => {
    const container = document.createElement('div');
    const session = createSession(moduleInfo, [choiceQuestion], {
      shuffle: false,
      autoNext: false,
      questionLimit: 'all',
      answerFormat: 'auto'
    });

    renderInlineQuiz(container, session, { onSessionChange() {}, onComplete() {} }, { store: studyStore });

    const next = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '次へ')!;
    const choiceB = [...container.querySelectorAll<HTMLButtonElement>('.choice-btn')].find((button) => button.textContent === 'B')!;

    expect(next.disabled).toBe(true);
    choiceB.click();
    expect(next.disabled).toBe(true);
    await vi.waitFor(() => expect(next.disabled).toBe(false));
  });

  it('surfaces a failed save, keeps Next gated, and retries the same attempt', async () => {
    const save = vi.spyOn(studyStore, 'recordAnswer').mockRejectedValueOnce(new Error('disk full')).mockResolvedValueOnce();
    const container = document.createElement('div');
    document.body.append(container);
    const onSessionChange = vi.fn();
    const session = createSession(moduleInfo, [inputQuestion], {
      shuffle: false,
      autoNext: false,
      questionLimit: 'all',
      answerFormat: 'input'
    });

    renderInlineQuiz(container, session, { onSessionChange, onComplete() {} }, { store: studyStore });
    const input = container.querySelector<HTMLInputElement>('input.text-input')!;
    const submit = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '回答する')!;
    const next = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '次へ')!;
    input.value = 'answer';
    submit.click();

    await vi.waitFor(() => expect(container.querySelector('.persistence-error')).not.toBeNull());
    expect(next.disabled).toBe(true);
    next.click();
    expect(onSessionChange).not.toHaveBeenCalled();

    const retry = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '保存を再試行')!;
    retry.click();
    await vi.waitFor(() => expect(next.disabled).toBe(false));
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1][0].attemptId).toBe(save.mock.calls[0][0].attemptId);
  });
});
