// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import type { ModuleInfo, Question } from '../src/core/models';
import { createSession } from '../src/core/sessionEngine';
import { renderInlineQuiz } from '../src/screens/inlineQuiz';
import { studyStore } from '../src/storage/studyRepository';

const moduleInfo: ModuleInfo = {
  id: 'input-lock-module',
  folderId: 'f',
  title: 'Input Lock',
  subject: 'test',
  questionIds: ['input-lock-question']
};

const question: Question = {
  id: 'input-lock-question',
  moduleId: moduleInfo.id,
  type: 'input',
  prompt: 'Answer?',
  answer: 'answer'
};

function waitForPersistence(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 50));
}

describe('renderInlineQuiz input lock', () => {
  it('locks input submission after the first answer and prevents duplicate attempts', async () => {
    const container = document.createElement('div');
    const session = createSession(moduleInfo, [question], { shuffle: false, autoNext: false, questionLimit: 'all', answerFormat: 'input' });

    renderInlineQuiz(container, session, { onSessionChange() {}, onComplete() {} }, { store: studyStore });

    const input = container.querySelector<HTMLInputElement>('input.text-input')!;
    const submit = [...container.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === '\u56de\u7b54\u3059\u308b')!;
    input.value = 'answer';

    submit.click();
    submit.click();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await waitForPersistence();

    const attempts = (await studyStore.getAttempts()).filter((attempt) => attempt.questionId === question.id);
    expect(input.disabled).toBe(true);
    expect(input.readOnly).toBe(true);
    expect(submit.disabled).toBe(true);
    expect(container.querySelectorAll('.result')).toHaveLength(1);
    expect(attempts).toHaveLength(1);
  });
});
