import { studyStore } from '../src/storage/studyRepository';
// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import type { ModuleInfo, Question } from '../src/core/models';
import { createSession } from '../src/core/sessionEngine';
import { renderInlineQuiz } from '../src/screens/inlineQuiz';

const moduleInfo: ModuleInfo = {
  id: 'biology',
  folderId: 'science',
  title: 'Biology',
  subject: 'Science',
  questionIds: ['q-choice', 'q-input', 'q-other']
};

const mitochondria = '\u30df\u30c8\u30b3\u30f3\u30c9\u30ea\u30a2';
const chloroplast = '\u8449\u7dd1\u4f53';
const chloroplastExplanation =
  '\u8449\u7dd1\u4f53\u306f\u5149\u5408\u6210\u306b\u95a2\u308f\u308b\u7d30\u80de\u5c0f\u5668\u5b98\u3067\u3059\u3002';

const choiceQuestion: Question = {
  id: 'q-choice',
  moduleId: moduleInfo.id,
  type: 'choice',
  prompt: '\u547c\u5438\u306b\u95a2\u308f\u308b\u7d30\u80de\u5c0f\u5668\u5b98',
  choices: [mitochondria, chloroplast],
  answer: mitochondria,
  explanation: '\u30df\u30c8\u30b3\u30f3\u30c9\u30ea\u30a2\u306f\u547c\u5438\u306b\u95a2\u308f\u308a\u307e\u3059\u3002'
};

const inputQuestion: Question = {
  id: 'q-input',
  moduleId: moduleInfo.id,
  type: 'input',
  prompt: '\u547c\u5438\u306b\u95a2\u308f\u308b\u7d30\u80de\u5c0f\u5668\u5b98',
  answer: mitochondria,
  explanation: '\u30df\u30c8\u30b3\u30f3\u30c9\u30ea\u30a2\u306f\u547c\u5438\u306b\u95a2\u308f\u308a\u307e\u3059\u3002'
};

const otherQuestion: Question = {
  id: 'q-other',
  moduleId: moduleInfo.id,
  type: 'input',
  prompt: '\u5149\u5408\u6210\u306b\u95a2\u308f\u308b\u7d30\u80de\u5c0f\u5668\u5b98',
  answer: chloroplast,
  acceptedAnswers: ['\u8449 \u7dd1 \u4f53'],
  explanation: chloroplastExplanation
};

function settle(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 50));
}

describe('renderInlineQuiz wrong answer feedback', () => {
  it('shows the matched problem/answer pair and keeps explanation as supplemental information', async () => {
    const container = document.createElement('div');
    const session = createSession(moduleInfo, [choiceQuestion], { shuffle: false, autoNext: false, questionLimit: 'all' }, 'normal', [
      choiceQuestion,
      otherQuestion
    ]);
    renderInlineQuiz(container, session, { onSessionChange() {}, onComplete() {} }, { store: studyStore });

    [...container.querySelectorAll<HTMLButtonElement>('.choice-btn')].find((button) => button.textContent === chloroplast)!.click();
    await settle();

    const feedback = container.querySelector('.wrong-answer-explanation')?.textContent ?? '';
    expect(feedback).toContain('\u9078\u3093\u3060\u7b54\u3048\u306b\u3064\u3044\u3066');
    expect(feedback).toContain('\u554f\u984c:');
    expect(feedback).toContain('\u5149\u5408\u6210');
    expect(feedback).toContain('\u7b54\u3048:');
    expect(feedback).toContain(chloroplast);
    expect(feedback).toContain('\u8907\u6570\u306e\u767b\u9332\u6b04\u306b\u4e00\u81f4');
    expect(container.querySelector('.wrong-answer-supplement')?.textContent).toContain(chloroplastExplanation);
    expect(feedback).not.toContain('\u89e3\u8aac\u306f\u672a\u767b\u9332');
  });

  it('shows the matched pair for a wrong input answer', async () => {
    const container = document.createElement('div');
    const session = createSession(
      moduleInfo,
      [inputQuestion],
      { shuffle: false, autoNext: false, questionLimit: 'all', answerFormat: 'input' },
      'normal',
      [inputQuestion, otherQuestion]
    );
    renderInlineQuiz(container, session, { onSessionChange() {}, onComplete() {} }, { store: studyStore });

    const input = container.querySelector<HTMLInputElement>('input.text-input')!;
    input.value = '\u8449 \u7dd1\u4f53';
    [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === '\u56de\u7b54\u3059\u308b')!
      .click();
    await settle();

    const feedback = container.querySelector('.wrong-answer-explanation')?.textContent ?? '';
    expect(feedback).toContain('\u5165\u529b\u3057\u305f\u7b54\u3048\u306b\u3064\u3044\u3066');
    expect(feedback).toContain('\u5149\u5408\u6210');
    expect(container.querySelector('.wrong-answer-supplement')?.textContent).toContain(chloroplastExplanation);
  });

  it('uses generated-choice origin even when another question has the same answer text', async () => {
    const container = document.createElement('div');
    const current: Question = {
      id: 'q-generated',
      moduleId: moduleInfo.id,
      type: 'input',
      prompt: 'pollution',
      answer: '\u6c5a\u67d3'
    };
    const first: Question = {
      id: 'q-pollen-first',
      moduleId: moduleInfo.id,
      type: 'input',
      prompt: 'pollen-first',
      answer: '\u82b1\u7c89'
    };
    const second: Question = {
      id: 'q-pollen-second',
      moduleId: moduleInfo.id,
      type: 'input',
      prompt: 'pollen-second',
      answer: '\u82b1\u7c89'
    };
    const third: Question = {
      id: 'q-sight',
      moduleId: moduleInfo.id,
      type: 'input',
      prompt: 'sight',
      answer: '\u8996\u754c'
    };
    const fourth: Question = {
      id: 'q-job',
      moduleId: moduleInfo.id,
      type: 'input',
      prompt: 'job',
      answer: '\u4ed5\u4e8b'
    };
    const pool = [current, first, second, third, fourth];
    const session = createSession(
      moduleInfo,
      [current],
      { shuffle: false, autoNext: false, questionLimit: 'all', answerFormat: 'choice' },
      'normal',
      pool
    );
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      renderInlineQuiz(container, session, { onSessionChange() {}, onComplete() {} }, { store: studyStore });
      [...container.querySelectorAll<HTMLButtonElement>('.choice-btn')].find((button) => button.textContent === '\u82b1\u7c89')!.click();
      await settle();

      const feedback = container.querySelector('.wrong-answer-explanation')?.textContent ?? '';
      expect(feedback).toContain('pollen-second');
      expect(feedback).not.toContain('pollen-first');
      expect(feedback).toContain('\u82f1\u8a9e:');
      expect(feedback).toContain('\u65e5\u672c\u8a9e:');
    } finally {
      random.mockRestore();
    }
  });

  it('shows a helpful fallback when a wrong answer does not match another question', async () => {
    const container = document.createElement('div');
    const session = createSession(
      moduleInfo,
      [inputQuestion],
      { shuffle: false, autoNext: false, questionLimit: 'all', answerFormat: 'input' },
      'normal',
      [inputQuestion, otherQuestion]
    );
    renderInlineQuiz(container, session, { onSessionChange() {}, onComplete() {} }, { store: studyStore });

    const input = container.querySelector<HTMLInputElement>('input.text-input')!;
    input.value = '\u5168\u304f\u9055\u3046\u7b54\u3048';
    [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === '\u56de\u7b54\u3059\u308b')!
      .click();
    await settle();

    expect(container.querySelector('.wrong-answer-explanation')?.textContent).toContain(
      '\u3053\u306e\u554f\u984c\u306e\u7b54\u3048\u3067\u306f\u3042\u308a\u307e\u305b\u3093'
    );
  });

  it('does not show wrong-answer feedback on a correct answer', async () => {
    const container = document.createElement('div');
    const session = createSession(
      moduleInfo,
      [inputQuestion],
      { shuffle: false, autoNext: false, questionLimit: 'all', answerFormat: 'input' },
      'normal',
      [inputQuestion, otherQuestion]
    );
    renderInlineQuiz(container, session, { onSessionChange() {}, onComplete() {} }, { store: studyStore });

    const input = container.querySelector<HTMLInputElement>('input.text-input')!;
    input.value = mitochondria;
    [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === '\u56de\u7b54\u3059\u308b')!
      .click();
    await settle();

    expect(container.querySelector('.correct-answer-explanation')?.textContent).toContain('\u6b63\u89e3\u306e\u89e3\u8aac');
    expect(container.querySelector('.wrong-answer-explanation')).toBeNull();
  });
});
