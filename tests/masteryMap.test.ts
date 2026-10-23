import { screenContext } from './support/screenContext';
// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildDueForecast, buildMasteryGrid } from '../src/core/analyticsEngine';
import { indexCardsByQuestion } from '../src/core/mastery';
import type { LoopDeckPack, Question, ReviewCard } from '../src/core/models';
import { createReviewCard } from '../src/core/scheduler';
import { resolveActivePacks } from '../src/packs/packResolver';
import { renderGraphsScreen } from '../src/screens/graphsScreen';
import { studyStore } from '../src/storage/studyRepository';

const NOW = new Date(2026, 9, 23, 9, 0, 0);

function card(questionId: string, moduleId: string, patch: Partial<ReviewCard> = {}): ReviewCard {
  return { ...createReviewCard(questionId, moduleId, NOW), state: 'review', intervalDays: 2, ...patch };
}

function day(offset: number, hour = 12): string {
  return new Date(2026, 9, 23 + offset, hour).toISOString();
}

const questions: Question[] = [
  { id: 'q1', moduleId: 'm', type: 'input', prompt: 'one', answer: '1', category: 'A' },
  { id: 'q2', moduleId: 'm', type: 'input', prompt: 'two', answer: '2', category: 'A' },
  { id: 'q3', moduleId: 'm', type: 'input', prompt: 'three', answer: '3' },
  { id: 'q4', moduleId: 'm', type: 'input', prompt: 'four', answer: '4', category: 'B' }
];

describe('mastery grid and due forecast', () => {
  it('groups questions by category in module order and grades each one', () => {
    const grid = buildMasteryGrid(
      { questionIds: ['q1', 'q2', 'q3', 'q4', 'gone'] },
      new Map(questions.map((question) => [question.id, question])),
      indexCardsByQuestion([card('q1', 'm', { intervalDays: 10 }), card('q2', 'm', { state: 'relearning' })])
    );
    expect(grid.map((row) => [row.category, row.cells.map((cell) => cell.level)])).toEqual([
      ['A', ['solid', 'weak']],
      ['その他', ['unseen']],
      ['B', ['unseen']]
    ]);
  });

  it('accumulates cards that fall due by the end of each day', () => {
    const forecast = buildDueForecast(
      [
        card('a', 'm', { dueAt: day(-1) }),
        card('b', 'm', { dueAt: day(0, 23) }),
        card('c', 'm', { dueAt: day(2) }),
        card('d', 'm', { dueAt: day(1), suspended: true })
      ],
      4,
      NOW
    );
    expect(forecast.map((item) => item.due)).toEqual([2, 2, 3, 3]);
    expect(forecast[0].date).toBe('2026-10-23');
  });
});

describe('graphs screen', () => {
  const pack: LoopDeckPack = {
    packVersion: 1,
    packId: 'graph-pack',
    title: 'Graph pack',
    folders: [{ id: 'f', title: 'F' }],
    modules: [{ id: 'm', folderId: 'f', title: 'Module M', subject: 's', questionIds: questions.map((question) => question.id) }],
    questions
  };

  beforeEach(async () => {
    localStorage.clear();
    await studyStore.clearAttempts();
    await studyStore.clearReviewData();
  });

  it('explains empty states before anything is studied', async () => {
    const root = document.createElement('div');
    await renderGraphsScreen(screenContext({ root, catalog: resolveActivePacks([pack]) }));
    expect(root.querySelector('.due-forecast .empty')).not.toBeNull();
    expect(root.querySelector('.mastery-map .empty')).not.toBeNull();
  });

  it('shows the forecast, a cell per question and a way into today’s loop', async () => {
    const now = new Date();
    const at = (offset: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, 12).toISOString();
    await studyStore.putReviewCard(card('q1', 'm', { dueAt: at(-1) }));
    await studyStore.putReviewCard(card('q2', 'm', { dueAt: at(2) }));
    const today = vi.fn();
    const root = document.createElement('div');
    await renderGraphsScreen(screenContext({ root, catalog: resolveActivePacks([pack]), navigation: { today } }));

    expect(root.querySelector('.due-forecast-lead')?.textContent).toBe('このまま復習しないと、あさってには 2問 が期限切れになります。');
    expect(root.querySelectorAll('.due-forecast-day')).toHaveLength(7);
    expect(root.querySelectorAll('.mastery-cell')).toHaveLength(4);
    expect(root.querySelector<HTMLSelectElement>('#mastery-module')?.value).toBe('m');
    [...root.querySelectorAll<HTMLButtonElement>('.due-forecast button')][0].click();
    expect(today).toHaveBeenCalledTimes(1);
  });
});
