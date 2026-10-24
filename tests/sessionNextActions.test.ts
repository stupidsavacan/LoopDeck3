import { screenContext } from './support/screenContext';
// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { LoopDeckPack, ModuleInfo } from '../src/core/models';
import { createSession } from '../src/core/sessionEngine';
import { resolveActivePacks } from '../src/packs/packResolver';
import { renderInlineQuiz } from '../src/screens/inlineQuiz';
import { renderReviewCenter } from '../src/screens/reviewCenter';
import { renderModuleScreen } from '../src/screens/moduleScreen';
import { studyStore } from '../src/storage/studyRepository';

const moduleInfo: ModuleInfo = {
  id: 'next-module',
  folderId: 'folder',
  title: 'Next steps module',
  subject: 'Test',
  questionIds: [],
  preferredAnswerFormat: 'input'
};

function testPack(questionCount: number): LoopDeckPack {
  const questions = Array.from({ length: questionCount }, (_, index) => ({
    id: `next-q-${index + 1}`,
    moduleId: moduleInfo.id,
    type: 'input' as const,
    number: index + 1,
    prompt: `word-${index + 1}`,
    answer: `answer-${index + 1}`
  }));
  return {
    packVersion: 1,
    packId: 'next-pack',
    title: 'Next steps pack',
    folders: [{ id: 'folder', title: 'Folder' }],
    modules: [{ ...moduleInfo, questionIds: questions.map((question) => question.id) }],
    questions
  };
}

async function settle(ms = 60): Promise<void> {
  await new Promise((resolve) => window.setTimeout(resolve, ms));
}

function buttonByText(root: HTMLElement, text: string): HTMLButtonElement {
  const found = [...root.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim().startsWith(text));
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
}

function uncheck(root: HTMLElement, label: string): void {
  const input = [...root.querySelectorAll<HTMLLabelElement>('.check-label')]
    .find((node) => node.textContent?.includes(label))
    ?.querySelector('input');
  if (!input) throw new Error(`Missing checkbox: ${label}`);
  input.checked = false;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

/** Answers the visible question; `mode` decides correct, wrong or revealed. */
async function answer(root: HTMLElement, mode: 'correct' | 'wrong' | 'reveal'): Promise<void> {
  const prompt = root.querySelector('.question-prompt')?.textContent ?? '';
  if (mode === 'reveal') {
    root.querySelector<HTMLButtonElement>('button[aria-label="答えを見る"]')!.click();
  } else {
    const input = root.querySelector<HTMLInputElement>('input.text-input')!;
    input.value = mode === 'correct' ? prompt.replace('word', 'answer') : 'nope';
    buttonByText(root, '回答する').click();
  }
  await settle();
  buttonByText(root, '次へ').click();
  await settle();
}

async function startModule(questionCount: number): Promise<HTMLElement> {
  const pack = testPack(questionCount);
  // Answers are only saved for material that is installed in the repository.
  await studyStore.saveImportedPack(pack);
  const root = document.createElement('div');
  await renderModuleScreen(screenContext({ root, catalog: resolveActivePacks([pack]), moduleId: moduleInfo.id }));
  uncheck(root, 'シャッフル');
  uncheck(root, '正解時');
  buttonByText(root, '10問').click();
  buttonByText(root, '学習を始める').click();
  await settle();
  return root;
}

beforeEach(async () => {
  localStorage.clear();
  await studyStore.clearAttempts();
  await studyStore.clearReviewData();
});

describe('session next steps', () => {
  it('offers a retry of the missed questions, the next questions and a way to stop', async () => {
    const root = await startModule(25);
    for (let index = 0; index < 10; index += 1) await answer(root, index === 1 ? 'wrong' : index === 4 ? 'reveal' : 'correct');

    const actions = [...root.querySelectorAll<HTMLButtonElement>('.next-action')];
    expect(actions.map((action) => action.dataset.action)).toEqual(['retry-mistakes', 'continue', 'finish']);
    expect(actions[0].textContent).toContain('間違えた2問だけもう一周');
    expect(actions[0].classList.contains('primary')).toBe(true);
    expect(actions[1].textContent).toContain('続きの10問');
    await settle();
    expect(root.querySelector('.next-preview')?.textContent).toContain('明日の復習予定');

    actions[0].click();
    await settle();
    expect(root.querySelector('.quiz-meta span')?.textContent).toBe('1 / 2');
    expect(root.querySelector('.question-prompt')?.textContent).toBe('word-2');
  });

  it('continues with questions the finished session did not show', async () => {
    const root = await startModule(25);
    for (let index = 0; index < 10; index += 1) await answer(root, 'correct');

    const actions = [...root.querySelectorAll<HTMLButtonElement>('.next-action')];
    expect(actions.map((action) => action.dataset.action)).toEqual(['continue', 'finish']);
    expect(actions[0].classList.contains('primary')).toBe(true);
    actions[0].click();
    await settle();
    expect(root.querySelector('.quiz-meta span')?.textContent).toBe('1 / 10');
    expect(root.querySelector('.question-prompt')?.textContent).toBe('word-11');
  });

  it('only offers to stop when every question was shown and answered correctly', async () => {
    const root = await startModule(3);
    for (let index = 0; index < 3; index += 1) await answer(root, 'correct');

    expect([...root.querySelectorAll<HTMLButtonElement>('.next-action')].map((action) => action.dataset.action)).toEqual(['finish']);
    root.querySelector<HTMLButtonElement>('[data-action="finish"]')!.click();
    await settle();
    expect(root.querySelector('.quiz-card.done')).toBeNull();
    expect(root.querySelector('.v2-start')).not.toBeNull();
  });

  it('clears the module mistake filter only after two objective correct answers', async () => {
    const root = await startModule(1);
    await answer(root, 'wrong');
    for (let round = 0; round < 2; round += 1) {
      buttonByText(root, '今日はここまで').click();
      await settle();
      buttonByText(root, '間違いだけ 1問').click();
      await settle();
      await answer(root, 'correct');
    }
    buttonByText(root, '今日はここまで').click();
    await settle();
    expect(root.textContent).not.toContain('間違いだけ 1問');
    expect((await studyStore.getAttempts()).filter((attempt) => attempt.questionId === 'next-q-1')).toHaveLength(3);
  });

  it('retries mistakes from the review center and removes retry after a clean round', async () => {
    const pack = testPack(1);
    await studyStore.saveImportedPack(pack);
    await studyStore.addAttempt({
      attemptId: 'review-seed',
      questionId: 'next-q-1',
      moduleId: moduleInfo.id,
      answeredAt: new Date().toISOString(),
      result: 'wrong',
      input: 'nope',
      answer: 'answer-1',
      elapsedMs: 1000,
      mode: 'normal',
      answerMode: 'input'
    });
    const root = document.createElement('div');
    await renderReviewCenter(screenContext({ root, catalog: resolveActivePacks([pack]) }));
    buttonByText(root, '弱点を復習する').click();
    await settle();
    await answer(root, 'reveal');
    buttonByText(root, '間違えた1問だけもう一周').click();
    await settle();
    expect(root.querySelector('.question-prompt')?.textContent).toBe('word-1');
    await answer(root, 'correct');
    expect(root.querySelector('[data-action="retry-mistakes"]')).toBeNull();
    expect(buttonByText(root, '今日はここまで')).toBeTruthy();
  });

  it('keeps the concrete reverse direction when retrying an SRS mistake', async () => {
    const pack = testPack(1);
    const question = pack.questions[0];
    question.sides = { front: { label: 'Front', text: 'word-1' }, back: { label: 'Back', text: 'answer-1' } };
    question.supportedStudyModes = ['front_to_back', 'back_to_front'];
    await studyStore.saveImportedPack(pack);
    await studyStore.addAttempt({
      attemptId: 'reverse-seed',
      questionId: question.id,
      moduleId: moduleInfo.id,
      answeredAt: new Date().toISOString(),
      result: 'wrong',
      input: 'nope',
      answer: 'word-1',
      elapsedMs: 1000,
      mode: 'review',
      answerMode: 'input',
      questionMode: 'back_to_front'
    });
    const now = new Date().toISOString();
    await studyStore.putReviewCard({
      questionId: question.id,
      moduleId: moduleInfo.id,
      questionMode: 'back_to_front',
      state: 'review',
      dueAt: new Date(Date.now() - 86400000).toISOString(),
      lastReviewedAt: now,
      firstReviewedAt: now,
      intervalDays: 1,
      ease: 2.5,
      totalReviews: 1,
      totalCorrect: 0,
      totalWrong: 1,
      correctStreak: 0,
      wrongStreak: 1,
      lapseCount: 0,
      leechLevel: 0,
      suspended: false,
      createdAt: now,
      updatedAt: now
    });
    const root = document.createElement('div');
    await renderReviewCenter(screenContext({ root, catalog: resolveActivePacks([pack]) }));
    buttonByText(root, '今日の復習を始める').click();
    await settle();
    expect(root.querySelector('.question-prompt')?.textContent).toBe('answer-1');
    await answer(root, 'reveal');
    buttonByText(root, '間違えた1問だけもう一周').click();
    await settle();
    expect(root.querySelector('.question-prompt')?.textContent).toBe('answer-1');
  });

  it('keeps the plain return button for callers without next steps', () => {
    const container = document.createElement('div');
    const pack = testPack(1);
    const session = createSession(moduleInfo, pack.questions, { shuffle: false, autoNext: false, questionLimit: 'all' });
    session.index = 1;
    renderInlineQuiz(container, session, { onSessionChange() {}, onComplete() {} }, { store: studyStore });
    expect(buttonByText(container, '教材詳細に戻る')).toBeTruthy();
    expect(container.querySelector('.next-actions')).toBeNull();
  });
});
