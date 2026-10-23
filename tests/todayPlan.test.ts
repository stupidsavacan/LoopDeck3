import { describe, expect, it } from 'vitest';
import { currentStreak } from '../src/core/analyticsEngine';
import { cardMasteryLevel, indexCardsByQuestion, moduleMastery, questionMasteryLevel } from '../src/core/mastery';
import type { Attempt, ModuleInfo, Question, ReviewCard } from '../src/core/models';
import { createReviewCard } from '../src/core/scheduler';
import { buildTodayPlan, countAnsweredToday } from '../src/core/todayPlan';

const NOW = new Date(2026, 9, 23, 9, 0, 0);

function question(id: string, moduleId: string, number: number): Question {
  return { id, moduleId, type: 'input', prompt: `${id}?`, answer: id, number };
}

function moduleOf(id: string, ids: string[]): ModuleInfo {
  return { id, folderId: 'f', title: `Module ${id}`, subject: 'test', questionIds: ids };
}

function card(questionId: string, moduleId: string, patch: Partial<ReviewCard> = {}): ReviewCard {
  return {
    ...createReviewCard(questionId, moduleId, NOW),
    state: 'review',
    intervalDays: 3,
    dueAt: new Date(2026, 9, 22).toISOString(),
    ...patch
  };
}

function attempt(questionId: string, answeredAt: Date, patch: Partial<Attempt> = {}): Attempt {
  return {
    attemptId: `${questionId}-${answeredAt.getTime()}`,
    questionId,
    moduleId: 'a',
    answeredAt: answeredAt.toISOString(),
    result: 'correct',
    input: '',
    answer: '',
    elapsedMs: 1000,
    mode: 'normal',
    ...patch
  };
}

const a = Array.from({ length: 14 }, (_, index) => question(`a${index + 1}`, 'a', index + 1));
const b = Array.from({ length: 3 }, (_, index) => question(`b${index + 1}`, 'b', index + 1));
const modules = [
  moduleOf(
    'a',
    a.map((item) => item.id)
  ),
  moduleOf(
    'b',
    b.map((item) => item.id)
  )
];
const questions = [...a, ...b];

describe('mastery', () => {
  it('ranks cards and keeps the best direction of a question', () => {
    expect(cardMasteryLevel(card('a1', 'a', { state: 'relearning' }))).toBe('weak');
    expect(cardMasteryLevel(card('a1', 'a', { wrongStreak: 1 }))).toBe('weak');
    expect(cardMasteryLevel(card('a1', 'a', { intervalDays: 3 }))).toBe('learning');
    expect(cardMasteryLevel(card('a1', 'a', { intervalDays: 7 }))).toBe('solid');
    expect(cardMasteryLevel(card('a1', 'a', { state: 'mastered', intervalDays: 1 }))).toBe('solid');
    expect(questionMasteryLevel(undefined)).toBe('unseen');
    expect(
      questionMasteryLevel([card('a1', 'a', { state: 'relearning' }), card('a1', 'a', { questionMode: 'back_to_front', intervalDays: 9 })])
    ).toBe('solid');
  });

  it('counts solid questions fully and learning ones half', () => {
    const cards = indexCardsByQuestion([card('b1', 'b', { intervalDays: 10 }), card('b2', 'b', { intervalDays: 2 })]);
    const mastery = moduleMastery(modules[1], cards);
    expect(mastery.counts).toEqual({ unseen: 1, weak: 0, learning: 1, solid: 1 });
    expect(mastery.ratio).toBeCloseTo(0.5);
  });
});

describe('today plan', () => {
  it('puts due reviews first, then unseen questions of the focus module in their own order', () => {
    const plan = buildTodayPlan({
      questions,
      modules,
      cards: [card('a2', 'a'), card('b1', 'b'), card('a3', 'a', { dueAt: new Date(2026, 9, 30).toISOString() })],
      attempts: [attempt('a1', new Date(2026, 9, 20))],
      focusModuleId: 'a',
      now: NOW
    });
    expect(plan.review.map((item) => item.id).sort()).toEqual(['a2', 'b1']);
    expect(plan.fresh.map((item) => item.id)).toEqual(['a4', 'a5', 'a6', 'a7', 'a8', 'a9', 'a10', 'a11', 'a12', 'a13']);
    expect(plan.focusModule?.id).toBe('a');
    expect(plan.estimatedMinutes).toBe(4);
  });

  it('skips suspended cards and cards whose question is gone', () => {
    const plan = buildTodayPlan({
      questions,
      modules,
      cards: [card('a2', 'a', { suspended: true }), card('gone', 'a')],
      attempts: [],
      now: NOW
    });
    expect(plan.review).toEqual([]);
  });

  it('falls back to the first module that still has unseen questions', () => {
    const seen = a.map((item) => attempt(item.id, new Date(2026, 9, 20)));
    const plan = buildTodayPlan({ questions, modules, cards: [], attempts: seen, focusModuleId: 'a', now: NOW });
    expect(plan.focusModule?.id).toBe('b');
    expect(plan.fresh.map((item) => item.id)).toEqual(['b1', 'b2', 'b3']);
  });

  it('can plan new questions only', () => {
    const plan = buildTodayPlan({ questions, modules, cards: [card('a2', 'a')], attempts: [], reviewLimit: 0, freshCount: 2, now: NOW });
    expect(plan.review).toEqual([]);
    expect(plan.fresh.map((item) => item.id)).toEqual(['a1', 'a3']);
  });

  it('counts only answers from the local calendar day', () => {
    const attempts = [
      attempt('a1', new Date(2026, 9, 23, 0, 5)),
      attempt('a2', new Date(2026, 9, 22, 23, 55)),
      attempt('a3', new Date(2026, 9, 23, 8, 0), { contentRetired: true })
    ];
    expect(countAnsweredToday(attempts, NOW)).toBe(1);
  });
});

describe('study streak', () => {
  it('counts consecutive days ending today or yesterday', () => {
    const days = (...dates: number[]) => dates.map((date) => attempt('a1', new Date(2026, 9, date, 12)));
    expect(currentStreak(days(21, 22, 23), NOW)).toBe(3);
    expect(currentStreak(days(20, 21, 22), NOW)).toBe(3);
    expect(currentStreak(days(19, 21, 22), NOW)).toBe(2);
    expect(currentStreak(days(20), NOW)).toBe(0);
  });
});
