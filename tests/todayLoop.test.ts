import { screenContext } from './support/screenContext';
// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoopDeckPack, ModuleInfo } from '../src/core/models';
import { resolveActivePacks } from '../src/packs/packResolver';
import { renderHomeScreen } from '../src/screens/homeScreen';
import { renderTodayScreen, TODAY_RECORD_KEY } from '../src/screens/todayScreen';
import { AUTO_RESUME_KEY } from '../src/storage/libraryState';
import { studyStore } from '../src/storage/studyRepository';

const moduleInfo: ModuleInfo = {
  id: 'today-module',
  folderId: 'folder',
  title: 'Today module',
  subject: 'Test',
  questionIds: [],
  preferredAnswerFormat: 'input'
};

function testPack(questionCount: number): LoopDeckPack {
  const questions = Array.from({ length: questionCount }, (_, index) => ({
    id: `today-q-${index + 1}`,
    moduleId: moduleInfo.id,
    type: 'input' as const,
    number: index + 1,
    prompt: `word-${index + 1}`,
    answer: `answer-${index + 1}`
  }));
  return {
    packVersion: 1,
    packId: 'today-pack',
    title: 'Today pack',
    folders: [{ id: 'folder', title: 'Folder' }],
    modules: [{ ...moduleInfo, questionIds: questions.map((question) => question.id) }],
    questions
  };
}

async function settle(ms = 80): Promise<void> {
  await new Promise((resolve) => window.setTimeout(resolve, ms));
}

function buttonByText(root: HTMLElement, text: string): HTMLButtonElement {
  const found = [...root.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim().startsWith(text));
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
}

const meta = (root: HTMLElement) => root.querySelector('.quiz-meta span')?.textContent;
const prompt = (root: HTMLElement) => root.querySelector('.question-prompt')?.textContent;

async function openToday(pack: LoopDeckPack | undefined, navigation = {}): Promise<HTMLElement> {
  const root = document.createElement('div');
  await renderTodayScreen(screenContext({ root, catalog: resolveActivePacks(pack ? [pack] : []), navigation }));
  await settle();
  return root;
}

async function answerCurrent(root: HTMLElement): Promise<void> {
  const input = root.querySelector<HTMLInputElement>('input.text-input')!;
  input.value = (prompt(root) ?? '').replace('word', 'answer');
  buttonByText(root, '回答する').click();
  await settle();
  // Do not wait for the 650 ms auto-advance; move on like a learner tapping Next.
  buttonByText(root, '次へ').click();
  await settle();
}

beforeEach(async () => {
  localStorage.clear();
  sessionStorage.clear();
  await studyStore.clearAttempts();
  await studyStore.clearReviewData();
});

describe("today's loop screen", () => {
  it('starts with new questions when nothing is due', async () => {
    const pack = testPack(12);
    await studyStore.saveImportedPack(pack);
    const root = await openToday(pack);

    expect(meta(root)).toBe('1 / 10');
    expect(prompt(root)).toBe('word-1');
    expect(JSON.parse(localStorage.getItem(TODAY_RECORD_KEY) ?? '{}').items).toHaveLength(10);
  });

  it('resumes the same loop when reopened on the same day', async () => {
    const pack = testPack(12);
    await studyStore.saveImportedPack(pack);
    const first = await openToday(pack);
    await answerCurrent(first);
    expect(meta(first)).toBe('2 / 10');

    const again = await openToday(pack);
    expect(meta(again)).toBe('2 / 10');
    expect(prompt(again)).toBe('word-2');
  });

  it('plans again on a new day and skips questions already answered', async () => {
    const pack = testPack(12);
    await studyStore.saveImportedPack(pack);
    const first = await openToday(pack);
    await answerCurrent(first);
    const record = JSON.parse(localStorage.getItem(TODAY_RECORD_KEY) ?? '{}');
    localStorage.setItem(TODAY_RECORD_KEY, JSON.stringify({ ...record, date: '2000-01-01' }));

    const next = await openToday(pack);
    expect(meta(next)).toBe('1 / 10');
    expect(prompt(next)).toBe('word-2');
  });

  it('says so when there is nothing to study', async () => {
    const root = await openToday(undefined);
    expect(root.querySelector('.today-empty')?.textContent).toContain('今日の分は終わりました');
  });

  it('leaves for home from the exit button', async () => {
    const pack = testPack(3);
    await studyStore.saveImportedPack(pack);
    const home = vi.fn();
    const root = await openToday(pack, { home });
    root.querySelector<HTMLButtonElement>('.quiz-exit')!.click();
    expect(home).toHaveBeenCalledTimes(1);
  });
});

describe('home today hero', () => {
  it('shows a loading hero first, then the plan and a start button', async () => {
    const pack = testPack(12);
    await studyStore.saveImportedPack(pack);
    const today = vi.fn();
    const root = document.createElement('div');
    renderHomeScreen(screenContext({ root, catalog: resolveActivePacks([pack]), navigation: { today } }));
    expect(root.querySelector('.today-hero.is-loading')).not.toBeNull();
    expect(root.querySelector('.module-card')).not.toBeNull();

    await settle();
    expect(root.querySelector('.today-heading')?.textContent).toBe('今日はこれだけ。');
    expect(root.querySelector('.today-plan')?.textContent).toContain('Today moduleの新出 10問');
    expect(root.querySelector('.module-progress-label')?.textContent).toContain('習熟 0%');
    root.querySelector<HTMLButtonElement>('.today-start')!.click();
    expect(today).toHaveBeenCalledTimes(1);
  });

  it('offers to resume a module session left midway', async () => {
    const pack = testPack(3);
    await studyStore.saveImportedPack(pack);
    localStorage.setItem(
      `loopdeck3.session.${JSON.stringify([pack.packId, moduleInfo.id])}`,
      JSON.stringify({ format: 'loopdeck3.session', version: 1, questions: [{}, {}, {}], index: 1, savedAt: new Date().toISOString() })
    );
    const module = vi.fn();
    const root = document.createElement('div');
    renderHomeScreen(screenContext({ root, catalog: resolveActivePacks([pack]), navigation: { module } }));
    await settle();

    const banner = root.querySelector<HTMLButtonElement>('.resume-banner')!;
    expect(banner.textContent).toContain('中断中：Today module');
    expect(banner.textContent).toContain('2 / 3');
    banner.click();
    expect(sessionStorage.getItem(AUTO_RESUME_KEY)).toBe(moduleInfo.id);
    expect(module).toHaveBeenCalledWith(moduleInfo.id);
  });
});
