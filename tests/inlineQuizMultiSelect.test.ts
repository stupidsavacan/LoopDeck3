// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ModuleInfo, Question } from '../src/core/models';
import { createSession } from '../src/core/sessionEngine';
import { renderInlineQuiz } from '../src/screens/inlineQuiz';
import { studyStore } from '../src/storage/studyRepository';

const moduleInfo: ModuleInfo = {
  id: 'multi-select-toggle-module',
  folderId: 'test',
  title: 'Multi select',
  subject: 'test',
  questionIds: ['multi-select-toggle-question']
};

const question: Question = {
  id: 'multi-select-toggle-question',
  moduleId: moduleInfo.id,
  type: 'multi_select',
  prompt: 'Select A and B',
  choices: ['A', 'B', 'C'],
  correctChoices: ['A', 'B']
};

function render(): HTMLElement {
  const container = document.createElement('div');
  const session = createSession(moduleInfo, [question], {
    shuffle: false,
    autoNext: false,
    questionLimit: 'all'
  });
  renderInlineQuiz(container, session, { onSessionChange() {}, onComplete() {} }, { store: studyStore });
  return container;
}

describe('multi-select interaction state', () => {
  beforeEach(async () => {
    await studyStore.clearAttempts();
    await studyStore.clearReviewData();
  });

  it('toggles off a selected option immediately', () => {
    const container = render();
    const optionA = [...container.querySelectorAll<HTMLButtonElement>('.choice-btn')]
      .find((button) => button.textContent === 'A')!;

    expect(optionA.getAttribute('aria-pressed')).toBe('false');
    optionA.click();
    expect(optionA.classList.contains('selected')).toBe(true);
    expect(optionA.getAttribute('aria-pressed')).toBe('true');

    optionA.click();
    expect(optionA.classList.contains('selected')).toBe(false);
    expect(optionA.getAttribute('aria-pressed')).toBe('false');
  });

  it('submits the current state after deselection and locks options', async () => {
    const container = render();
    const options = [...container.querySelectorAll<HTMLButtonElement>('.choice-btn')];
    const optionA = options.find((button) => button.textContent === 'A')!;
    const optionB = options.find((button) => button.textContent === 'B')!;
    const submit = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === '選択を確定')!;

    optionA.click();
    optionB.click();
    optionA.click();
    submit.click();

    await new Promise((resolve) => window.setTimeout(resolve, 50));
    const attempts = (await studyStore.getAttempts()).filter((attempt) => attempt.questionId === question.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].input).toEqual(['B']);
    expect(attempts[0].result).toBe('wrong');
    expect(options.every((button) => button.disabled)).toBe(true);

    optionB.click();
    expect(optionB.getAttribute('aria-pressed')).toBe('true');
  });

  it('locks multi-select options after revealing the answer', async () => {
    const container = render();
    const options = [...container.querySelectorAll<HTMLButtonElement>('.choice-btn')];
    const optionA = options.find((button) => button.textContent === 'A')!;
    const reveal = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === '答えを見る')!;

    optionA.click();
    expect(optionA.getAttribute('aria-pressed')).toBe('true');

    reveal.click();
    await new Promise((resolve) => window.setTimeout(resolve, 50));

    expect(options.every((button) => button.disabled)).toBe(true);
    optionA.click();
    expect(optionA.getAttribute('aria-pressed')).toBe('true');

    const attempts = (await studyStore.getAttempts()).filter((attempt) => attempt.questionId === question.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].result).toBe('revealed');
  });
});
