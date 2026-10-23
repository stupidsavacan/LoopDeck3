import { studyStore } from '../src/storage/studyRepository';
// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import type { ModuleInfo, Question } from '../src/core/models';
import { createSession } from '../src/core/sessionEngine';
import { renderInlineQuiz, type InlineQuizCallbacks } from '../src/screens/inlineQuiz';

const moduleInfo: ModuleInfo = {
  id: 'history',
  folderId: 'social',
  title: '歴史総合',
  subject: '社会',
  questionIds: ['q-3b', 'q-3c', 'q-multi']
};

const threeB: Question = {
  id: 'q-3b',
  moduleId: moduleInfo.id,
  type: 'choice',
  prompt: '3B政策の3都市のうち、ドイツ本国側の都市はどこか。',
  choices: ['ベルリン', 'カイロ', 'ケープタウン', 'カルカッタ'],
  answer: 'ベルリン',
  explanation: 'ドイツの3B政策はベルリン・ビザンティウム・バグダードを結ぶ構想。'
};

const threeC: Question = {
  id: 'q-3c',
  moduleId: moduleInfo.id,
  type: 'input',
  prompt: '3C政策の3都市のうち、エジプト側の都市はどこか。',
  answer: 'カイロ',
  explanation: 'イギリスの3C政策はカイロ・ケープタウン・カルカッタを結ぶ構想。'
};

const multi: Question = {
  id: 'q-multi',
  moduleId: moduleInfo.id,
  type: 'multi_select',
  prompt: '3C政策の都市をすべて選べ。',
  choices: ['カイロ', 'ベルリン', 'カルカッタ'],
  correctChoices: ['カイロ', 'カルカッタ']
};

function settle(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 50));
}

// The multi-select question also answers カイロ, so it stays out of the pool unless it is the question itself.
function render(question: Question, callbacks: Partial<InlineQuizCallbacks> = {}): HTMLElement {
  const container = document.createElement('div');
  document.body.append(container);
  const pool = question.type === 'multi_select' ? [threeB, threeC, multi] : [threeB, threeC];
  const session = createSession(moduleInfo, [question], { shuffle: false, autoNext: false, questionLimit: 'all' }, 'normal', pool);
  renderInlineQuiz(container, session, { onSessionChange() {}, onComplete() {}, ...callbacks }, { store: studyStore });
  return container;
}

function choiceButton(container: HTMLElement, text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>('.choice-btn')].find((item) => item.textContent?.startsWith(text));
  if (!found) throw new Error(`Missing choice ${text}`);
  return found;
}

describe('inline quiz answer feedback', () => {
  it('marks the picked wrong choice and the correct choice', async () => {
    const container = render(threeB);
    choiceButton(container, 'カイロ').click();
    await settle();

    expect(choiceButton(container, 'カイロ').className).toContain('is-wrong-pick');
    expect(choiceButton(container, 'カイロ').querySelector('.choice-mark')?.textContent).toBe('あなたの答え');
    expect(choiceButton(container, 'ベルリン').className).toContain('is-correct');
    expect(choiceButton(container, 'ベルリン').querySelector('.choice-mark')?.textContent).toBe('正解');
    expect(choiceButton(container, 'ケープタウン').className).not.toMatch(/is-correct|is-wrong-pick/);
  });

  it('marks a correct pick as both correct and chosen', async () => {
    const container = render(threeB);
    choiceButton(container, 'ベルリン').click();
    await settle();

    expect(choiceButton(container, 'ベルリン').classList.contains('is-picked')).toBe(true);
    expect(choiceButton(container, 'ベルリン').querySelector('.choice-mark')?.textContent).toBe('正解・あなたの答え');
    expect(container.querySelector('.is-wrong-pick')).toBeNull();
  });

  it('only marks the correct choice when the answer is revealed', async () => {
    const container = render(threeB);
    [...container.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.getAttribute('aria-label') === '答えを見る')!.click();
    await settle();

    expect(choiceButton(container, 'ベルリン').className).toContain('is-correct');
    expect(container.querySelector('.is-wrong-pick')).toBeNull();
    expect(container.querySelector('.is-picked')).toBeNull();
  });

  it('marks every correct choice of a multi-select question', async () => {
    const container = render(multi);
    choiceButton(container, 'カイロ').click();
    choiceButton(container, 'ベルリン').click();
    [...container.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === '選択を確定')!.click();
    await settle();

    expect(choiceButton(container, 'カイロ').className).toContain('is-correct');
    expect(choiceButton(container, 'カルカッタ').className).toContain('is-correct');
    expect(choiceButton(container, 'カルカッタ').classList.contains('is-picked')).toBe(false);
    expect(choiceButton(container, 'ベルリン').className).toContain('is-wrong-pick');
  });

  it('splits explanations into tabs and opens the learner answer first after a miss', async () => {
    const container = render(threeB);
    choiceButton(container, 'カイロ').click();
    await settle();

    const tabs = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    expect(tabs.map((tab) => tab.textContent)).toEqual(['正解の解説', '選んだ答え', '補足']);
    expect(tabs.map((tab) => tab.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false']);
    const visible = () => [...container.querySelectorAll<HTMLElement>('[role="tabpanel"]')].filter((panel) => !panel.hidden);
    expect(visible().map((panel) => panel.dataset.panel)).toEqual(['picked']);
    expect(visible()[0].querySelector('.confusion-table')?.textContent).toContain('エジプト側');

    tabs[0].click();
    expect(visible().map((panel) => panel.dataset.panel)).toEqual(['correct']);

    tabs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(visible().map((panel) => panel.dataset.panel)).toEqual(['more']);
    expect(document.activeElement).toBe(tabs[2]);
  });

  it('keeps a single explanation without tabs', async () => {
    const container = render(threeB);
    choiceButton(container, 'ベルリン').click();
    await settle();

    expect(container.querySelector('[role="tablist"]')).toBeNull();
    expect(container.querySelector('.correct-answer-explanation')?.textContent).toContain('3B政策');
  });

  it('offers an exit button only when the caller can resume the session', () => {
    expect(render(threeB).querySelector('.quiz-exit')).toBeNull();

    const onExit = vi.fn();
    const container = render(threeB, { onExit });
    container.querySelector<HTMLButtonElement>('.quiz-exit')!.click();
    expect(onExit).toHaveBeenCalledTimes(1);
  });
});
