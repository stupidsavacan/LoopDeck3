import { screenContext } from './support/screenContext';
// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Attempt, LoopDeckPack, Question, ReviewCard } from '../src/core/models';
import { resolveActivePacks } from '../src/packs/packResolver';
import { renderReviewCenter } from '../src/screens/reviewCenter';
import { studyStore } from '../src/storage/studyRepository';

const QUESTION_COUNT = 120;
const moduleId = 'stress-module';

const questions: Question[] = Array.from({ length: QUESTION_COUNT }, (_, index) => ({
  id: `stress-q-${index + 1}`,
  moduleId,
  type: 'input',
  prompt: `架空の復習問題 ${index + 1}：長めの問題文でも候補一覧が無制限に伸びないことを確認するためのテストです。`,
  answer: `answer-${index + 1}`
}));

const pack: LoopDeckPack = {
  packVersion: 1,
  packId: 'review-stress-pack',
  title: 'Review stress',
  folders: [{ id: 'stress-folder', title: 'Stress' }],
  modules: [{
    id: moduleId,
    folderId: 'stress-folder',
    title: '架空の大量学習データ',
    subject: 'test',
    questionIds: questions.map((question) => question.id)
  }],
  questions
};

function attemptFor(question: Question, index: number): Attempt {
  return {
    attemptId: `stress-a-${index}`,
    questionId: question.id,
    moduleId,
    answeredAt: new Date(Date.now() - (index % 6) * 24 * 60 * 60 * 1000).toISOString(),
    result: index % 9 === 0 ? 'revealed' : 'wrong',
    input: `wrong-${index}`,
    answer: `answer-${index}`,
    elapsedMs: 800 + (index % 5) * 1000,
    mode: 'normal',
    answerMode: 'input'
  };
}

function cardFor(question: Question, index: number): ReviewCard {
  const now = new Date().toISOString();
  return {
    questionId: question.id,
    moduleId,
    state: index % 11 === 0 ? 'leech' : 'review',
    dueAt: new Date(Date.now() - (index % 8 + 1) * 60 * 60 * 1000).toISOString(),
    lastReviewedAt: now,
    firstReviewedAt: now,
    intervalDays: Math.max(1, index % 20),
    ease: 2.3,
    totalReviews: 4,
    totalCorrect: 2,
    totalWrong: 2,
    correctStreak: 0,
    wrongStreak: 1,
    lapseCount: 1,
    leechLevel: index % 11 === 0 ? 3 : 0,
    suspended: false,
    createdAt: now,
    updatedAt: now
  };
}

describe('Review Center large-history layout bounds', () => {
  beforeEach(async () => {
    sessionStorage.removeItem('loopdeck3.review.scope');
    await studyStore.clearAttempts();
    await studyStore.clearReviewData();

    for (let index = 0; index < questions.length; index += 1) {
      const question = questions[index];
      await studyStore.addAttempt(attemptFor(question, index));
      await studyStore.putReviewCard(cardFor(question, index));
    }
  });

  it('keeps hundreds of synthetic review records behind bounded previews', async () => {
    const root = document.createElement('div');
    await renderReviewCenter(screenContext({ root: root, catalog: resolveActivePacks([pack]), navigation: { home: () => {}, graphs: () => {} } }));

    const listCards = [...root.querySelectorAll<HTMLElement>('.review-list-grid > .card')];
    expect(listCards).toHaveLength(2);

    const previewRows = listCards.flatMap((card) => [...card.querySelectorAll('.priority-row')]);
    expect(previewRows.length).toBeLessThanOrEqual(6);

    const analysis = root.querySelector<HTMLDetailsElement>('details.review-analysis');
    expect(analysis).not.toBeNull();
    expect(analysis?.open).toBe(false);

    expect(root.textContent).toContain('ほか ');
    expect(root.textContent).toContain('弱点復習では上位20問を出題します。');
    expect(root.querySelectorAll('.review-action-grid > .action-card')).toHaveLength(2);
  });
});
