import { screenContext } from './support/screenContext';
// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Attempt, LoopDeckPack, ModuleInfo, Question } from '../src/core/models';
import { buildWeeklyRecap, weekStartOf } from '../src/core/weeklyRecap';
import { resolveActivePacks } from '../src/packs/packResolver';
import { renderHomeScreen } from '../src/screens/homeScreen';
import { WEEKLY_SEEN_KEY } from '../src/storage/libraryState';
import { studyStore } from '../src/storage/studyRepository';
import { openWeeklyStory, weeklySlides } from '../src/ui/weeklyStory';

const modules: ModuleInfo[] = [
  { id: 'kobun', folderId: 'f', title: '古文', subject: '国語', questionIds: [] },
  { id: 'leap', folderId: 'f', title: 'LEAP', subject: '英語', questionIds: [] }
];
const questionsById = new Map<string, Question>([
  ['3b', { id: '3b', moduleId: 'kobun', type: 'input', prompt: '3B政策', answer: 'b' }],
  ['3c', { id: '3c', moduleId: 'kobun', type: 'input', prompt: '3C政策', answer: 'c' }]
]);

let sequence = 0;
function attempt(moduleId: string, at: Date, result: Attempt['result'] = 'correct', patch: Partial<Attempt> = {}): Attempt {
  sequence += 1;
  return {
    attemptId: `a${sequence}`,
    questionId: `q${sequence}`,
    moduleId,
    answeredAt: at.toISOString(),
    result,
    input: '',
    answer: '',
    elapsedMs: 1000,
    mode: 'normal',
    ...patch
  };
}

// Week of Monday 19 October 2026; the previous week starts 12 October.
const day = (date: number, hour = 12) => new Date(2026, 9, date, hour);

describe('weekly recap', () => {
  it('finds the Monday of a week', () => {
    expect(weekStartOf(day(25)).getDate()).toBe(19);
    expect(weekStartOf(day(19, 0)).getDate()).toBe(19);
    expect(weekStartOf(day(18)).getDate()).toBe(12);
  });

  it('counts study days, answers and the module that improved most', () => {
    const previous = [
      ...Array.from({ length: 5 }, (_, index) => attempt('kobun', day(13), index < 2 ? 'correct' : 'wrong')),
      ...Array.from({ length: 6 }, () => attempt('leap', day(14)))
    ];
    const current = [
      ...Array.from({ length: 5 }, () => attempt('kobun', day(20))),
      ...Array.from({ length: 8 }, () => attempt('leap', day(22))),
      attempt('leap', day(26, 1))
    ];
    const recap = buildWeeklyRecap([...previous, ...current], modules, questionsById, day(21));
    expect(recap.weekStart).toBe('2026-10-19');
    expect(recap.days.map((item) => item.studied)).toEqual([false, true, false, true, false, false, false]);
    expect(recap.studyDays).toBe(2);
    expect(recap.answered).toBe(13);
    expect(recap.previousAnswered).toBe(11);
    expect(recap.topModule).toEqual({ title: '古文', kind: 'gain', gain: 0.6 });
  });

  it('falls back to the most answered module and reports overcome confusions', () => {
    const history = [
      attempt('kobun', day(15), 'wrong', { questionId: '3b', confusedWithQuestionId: '3c' }),
      ...[20, 20, 21].map((date) => attempt('kobun', day(date), 'correct', { questionId: '3b' })),
      ...[20, 21, 22].map((date) => attempt('kobun', day(date, 18), 'correct', { questionId: '3c' }))
    ];
    const recap = buildWeeklyRecap(history, modules, questionsById, day(21));
    expect(recap.topModule).toEqual({ title: '古文', kind: 'most', answered: 6 });
    expect(recap.defeatedPairs).toEqual([['3B政策', '3C政策']]);
    expect(weeklySlides(recap, '今週のあなた').map((slide) => slide.kicker)).toEqual([
      '今週のあなた',
      '解いた問題',
      '一番解いた教材',
      '克服した取り違え'
    ]);
  });

  it('opens a story that pages through its cards and closes', () => {
    const recap = buildWeeklyRecap([attempt('leap', day(20))], modules, questionsById, day(21));
    let closed = false;
    const dialog = openWeeklyStory(recap, '今週のあなた', () => {
      closed = true;
    });
    expect(dialog.querySelector('.weekly-kicker')?.textContent).toBe('今週のあなた');
    expect(dialog.querySelectorAll('.weekly-day.is-studied')).toHaveLength(1);
    dialog.querySelector<HTMLButtonElement>('.weekly-next')!.click();
    expect(dialog.querySelector('.weekly-kicker')?.textContent).toBe('解いた問題');
    dialog.querySelector<HTMLButtonElement>('.weekly-close')!.click();
    expect(closed).toBe(true);
    expect(document.querySelector('.weekly-story')).toBeNull();
  });
});

describe('home weekly banner', () => {
  const pack: LoopDeckPack = {
    packVersion: 1,
    packId: 'weekly-pack',
    title: 'Weekly',
    folders: [{ id: 'f', title: 'F' }],
    modules: [{ id: 'm', folderId: 'f', title: 'Module', subject: 's', questionIds: ['w1'] }],
    questions: [{ id: 'w1', moduleId: 'm', type: 'input', prompt: 'w1', answer: 'w1' }]
  };

  beforeEach(async () => {
    localStorage.clear();
    await studyStore.clearAttempts();
  });

  it('offers last week once, then remembers it was seen', async () => {
    const now = new Date();
    const lastWeek = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7, 12);
    await studyStore.addAttempt(attempt('m', lastWeek, 'correct', { questionId: 'w1' }));
    const render = async () => {
      const root = document.createElement('div');
      renderHomeScreen(screenContext({ root, catalog: resolveActivePacks([pack]) }));
      await new Promise((resolve) => window.setTimeout(resolve, 80));
      return root;
    };

    const first = await render();
    const banner = first.querySelector<HTMLButtonElement>('.weekly-banner')!;
    expect(banner.textContent).toContain('先週のふりかえり');
    banner.click();
    expect(localStorage.getItem(WEEKLY_SEEN_KEY)).toBe(buildWeeklyRecap([], [], new Map(), lastWeek).weekStart);
    document.querySelector<HTMLButtonElement>('.weekly-close')?.click();

    const second = await render();
    expect(second.querySelector('.weekly-banner')).toBeNull();
  });
});
