import { screenContext } from './support/screenContext';
// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseRoute, routeHash } from '../src/app/context';
import { buildExamPlan, examCountdownLabel, examFolders, examLoopOptions, nearestExamPlan, type ExamFolder } from '../src/core/examPlan';
import { indexCardsByQuestion } from '../src/core/mastery';
import type { LoopDeckPack, ModuleInfo, ReviewCard } from '../src/core/models';
import { createReviewCard } from '../src/core/scheduler';
import { resolveActivePacks } from '../src/packs/packResolver';
import { renderExamPlanScreen } from '../src/screens/examPlanScreen';
import { renderHomeScreen } from '../src/screens/homeScreen';
import { EXAM_PLANS_KEY, readExamSetting, readExamSettings, writeExamSetting } from '../src/storage/examPlans';
import { studyStore } from '../src/storage/studyRepository';

// Friday 23 October 2026, local time.
const NOW = new Date(2026, 9, 23, 9, 0, 0);

function moduleOf(id: string, count: number): ModuleInfo {
  return {
    id,
    folderId: 'midterm',
    title: `Module ${id}`,
    subject: 'test',
    questionIds: Array.from({ length: count }, (_, index) => `${id}-${index + 1}`)
  };
}

function solid(questionId: string, moduleId: string): ReviewCard {
  return { ...createReviewCard(questionId, moduleId, NOW), state: 'review', intervalDays: 10 };
}

const folder: ExamFolder = { id: 'midterm', title: '一学期中間テスト', modules: [moduleOf('a', 40), moduleOf('b', 20)] };
const setAt = new Date(2026, 9, 13, 9).toISOString();

describe('exam plan', () => {
  it('spreads unfinished questions over the study days before the review day', () => {
    const cards = indexCardsByQuestion(Array.from({ length: 20 }, (_, index) => solid(`a-${index + 1}`, 'a')));
    const plan = buildExamPlan(folder, { date: '2026-10-31', setAt, restWeekdays: [] }, cards, NOW);

    expect(plan.daysLeft).toBe(8);
    expect(plan.schedule.map((day) => day.kind)).toEqual(['study', 'study', 'study', 'study', 'study', 'study', 'study', 'review', 'exam']);
    expect(plan.remaining).toBe(40);
    expect(plan.dailyQuota).toBe(6);
    expect(plan.schedule.reduce((sum, day) => sum + day.count, 0)).toBe(40);
    expect(plan.overall).toBeCloseTo(20 / 60);
    expect(plan.goal).toBeCloseTo(10 / 18);
    expect(plan.focusModuleId).toBe('b');
    expect(plan.readiness.map((item) => item.onTrack)).toEqual([false, false]);
  });

  it('skips rest weekdays when planning', () => {
    const plan = buildExamPlan(folder, { date: '2026-10-31', setAt, restWeekdays: [0, 6] }, new Map(), NOW);
    expect(plan.schedule.filter((day) => day.kind === 'rest').map((day) => day.date)).toEqual(['2026-10-24', '2026-10-25']);
    expect(plan.dailyQuota).toBe(12);
  });

  it('plans no new questions on the day before or the day of the exam', () => {
    const tomorrow = buildExamPlan(folder, { date: '2026-10-24', setAt, restWeekdays: [] }, new Map(), NOW);
    expect(tomorrow.schedule.map((day) => day.kind)).toEqual(['review', 'exam']);
    expect(tomorrow.dailyQuota).toBe(0);
    expect(examLoopOptions(tomorrow)).toEqual({ freshCount: 0 });

    const today = buildExamPlan(folder, { date: '2026-10-23', setAt, restWeekdays: [] }, new Map(), NOW);
    expect(today.daysLeft).toBe(0);
    expect(examCountdownLabel(today)).toBe('一学期中間テストは今日');
  });

  it('caps the daily quota and steers the loop to the least ready module', () => {
    const big: ExamFolder = { ...folder, modules: [moduleOf('a', 400)] };
    const plan = buildExamPlan(big, { date: '2026-10-26', setAt, restWeekdays: [] }, new Map(), NOW);
    expect(plan.dailyQuota).toBe(60);
    expect(plan.unplanned).toBe(400 - 60 * 2);
    expect(plan.readiness[0].onTrack).toBe(false);
    expect(examLoopOptions(plan)).toEqual({ focusModuleId: 'a', freshCount: 60 });
  });

  it('picks the nearest upcoming exam and ignores past ones', () => {
    const other: ExamFolder = { ...folder, id: 'final', title: '期末', modules: [moduleOf('c', 5)] };
    const nearest = nearestExamPlan(
      [folder, other],
      {
        midterm: { date: '2026-10-20', setAt, restWeekdays: [] },
        final: { date: '2026-11-30', setAt, restWeekdays: [] }
      },
      new Map(),
      NOW
    );
    expect(nearest?.folder.id).toBe('final');
  });

  it('groups modules under the folders their packs declare', () => {
    const pack: LoopDeckPack = {
      packVersion: 1,
      packId: 'p',
      title: 'p',
      folders: [{ id: 'midterm', title: '一学期中間テスト' }],
      modules: [],
      questions: []
    };
    const folders = examFolders([pack], [moduleOf('a', 1), { ...moduleOf('x', 1), folderId: 'unknown' }]);
    expect(folders.map((item) => [item.id, item.title, item.modules.map((module) => module.id)])).toEqual([
      ['midterm', '一学期中間テスト', ['a']]
    ]);
  });
});

describe('exam settings storage', () => {
  beforeEach(() => localStorage.clear());

  it('saves, validates and removes a folder exam', () => {
    expect(writeExamSetting('midterm', { date: '2026-10-31', setAt, restWeekdays: [6, 0, 6] })).toBe(true);
    expect(readExamSetting('midterm')).toEqual({ date: '2026-10-31', setAt, restWeekdays: [0, 6] });
    localStorage.setItem(EXAM_PLANS_KEY, JSON.stringify({ ...readExamSettings(), bad: { date: '2026-02-30', setAt, restWeekdays: [] } }));
    expect(Object.keys(readExamSettings())).toEqual(['midterm']);
    writeExamSetting('midterm', undefined);
    expect(readExamSetting('midterm')).toBeUndefined();
  });

  it('survives unreadable storage', () => {
    localStorage.setItem(EXAM_PLANS_KEY, '{not json');
    expect(readExamSettings()).toEqual({});
  });
});

describe('exam route and screens', () => {
  const pack: LoopDeckPack = {
    packVersion: 1,
    packId: 'exam-pack',
    title: 'Exam pack',
    folders: [{ id: 'midterm', title: '一学期中間テスト' }],
    modules: [{ ...moduleOf('a', 3) }],
    questions: ['a-1', 'a-2', 'a-3'].map((id, index) => ({
      id,
      moduleId: 'a',
      type: 'input' as const,
      number: index + 1,
      prompt: id,
      answer: id
    }))
  };

  beforeEach(async () => {
    localStorage.clear();
    await studyStore.clearReviewData();
  });

  it('round-trips the exam route', () => {
    expect(parseRoute('#exam/midterm%2F1')).toEqual({ name: 'exam', folderId: 'midterm/1' });
    expect(routeHash({ name: 'exam', folderId: 'midterm/1' })).toBe('#exam/midterm%2F1');
  });

  it('asks for a date first, then shows the countdown and plan', async () => {
    const root = document.createElement('div');
    const context = screenContext({ root, catalog: resolveActivePacks([pack]) });
    await renderExamPlanScreen({ ...context, folderId: 'midterm' });
    expect(root.querySelector('.exam-hero')).toBeNull();
    const input = root.querySelector<HTMLInputElement>('#exam-date-input')!;
    expect(root.querySelector<HTMLLabelElement>('label[for="exam-date-input"]')).not.toBeNull();

    const inTen = new Date();
    inTen.setDate(inTen.getDate() + 10);
    input.value = `${inTen.getFullYear()}-${String(inTen.getMonth() + 1).padStart(2, '0')}-${String(inTen.getDate()).padStart(2, '0')}`;
    input.dispatchEvent(new Event('change'));

    expect(root.querySelector('.exam-countdown strong')?.textContent).toBe('10');
    expect(root.querySelectorAll('.exam-readiness-row')).toHaveLength(1);
    expect(root.querySelector('.exam-day.is-exam')).not.toBeNull();
    expect(root.querySelector('.exam-start')?.textContent).toContain('今日の 1問 を始める');
  });

  it('links each home folder to its exam and shows the countdown once set', async () => {
    const inNine = new Date();
    inNine.setDate(inNine.getDate() + 9);
    const date = `${inNine.getFullYear()}-${String(inNine.getMonth() + 1).padStart(2, '0')}-${String(inNine.getDate()).padStart(2, '0')}`;
    writeExamSetting('midterm', { date, setAt: new Date().toISOString(), restWeekdays: [] });
    const exam = vi.fn();
    const root = document.createElement('div');
    renderHomeScreen(screenContext({ root, catalog: resolveActivePacks([pack]), navigation: { exam } }));
    expect(root.querySelector('.folder-exam')?.textContent).toBe('試験日を設定');
    await new Promise((resolve) => window.setTimeout(resolve, 80));

    expect(root.querySelector('.folder-exam')?.textContent).toBe('試験まで 9日');
    expect(root.querySelector('.today-exam-chip')?.textContent).toBe('一学期中間テストまで 9日');
    root.querySelector<HTMLButtonElement>('.folder-exam')!.click();
    expect(exam).toHaveBeenCalledWith('midterm');
  });
});
