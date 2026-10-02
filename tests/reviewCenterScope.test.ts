// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Attempt, LoopDeckPack, ReviewCard } from '../src/core/models';
import { resolveActivePacks } from '../src/packs/packResolver';
import { renderReviewCenter } from '../src/screens/reviewCenter';
import { db } from '../src/storage/db';

const pack: LoopDeckPack = {
  packVersion: 1,
  packId: 'review-scope-pack',
  title: 'Review scope',
  folders: [{ id: 'f', title: 'Folder' }],
  modules: [{ id: 'mixed-module', folderId: 'f', title: 'Mixed-age module', subject: 'test', questionIds: ['recent-q', 'old-q'] }],
  questions: [
    { id: 'recent-q', moduleId: 'mixed-module', type: 'input', prompt: 'RECENT QUESTION', answer: 'a' },
    { id: 'old-q', moduleId: 'mixed-module', type: 'input', prompt: 'OLD QUESTION', answer: 'b' }
  ]
};

function attempt(id: string, questionId: string, moduleId: string, ageDays: number): Attempt {
  return {
    attemptId: id,
    questionId,
    moduleId,
    answeredAt: new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000).toISOString(),
    result: 'wrong',
    input: 'x',
    answer: 'a',
    elapsedMs: 1000,
    mode: 'normal',
    answerMode: 'input'
  };
}

function dueCard(questionId: string, moduleId: string): ReviewCard {
  const now = new Date().toISOString();
  return {
    questionId,
    moduleId,
    state: 'review',
    dueAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
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
  };
}

describe('Review Center scope', () => {
  beforeEach(async () => {
    sessionStorage.removeItem('loopdeck3_review_scope_session_v1');
    await db.clearAttempts();
    await db.clearReviewData();
    await db.addAttempt(attempt('recent-attempt', 'recent-q', 'mixed-module', 1));
    await db.addAttempt(attempt('old-attempt', 'old-q', 'mixed-module', 8));
    await db.putReviewCard(dueCard('recent-q', 'mixed-module'));
    await db.putReviewCard(dueCard('old-q', 'mixed-module'));
  });

  it('hides stale questions even when their module is still active and restores them in all-history scope', async () => {
    const root = document.createElement('div');
    const view = resolveActivePacks([pack]);

    await renderReviewCenter(
      root,
      view,
      () => {},
      () => {}
    );

    expect(root.textContent).toContain('RECENT QUESTION');
    expect(root.textContent).not.toContain('OLD QUESTION');
    expect(root.textContent).not.toContain('学習中');
    expect(root.textContent).toContain('自動の復習日程はSRSだけが決めます');
    expect(root.textContent).toContain('SRSの次回日程は変更しません');
    expect(root.textContent).toContain('過去教材の復習予定 1問は非表示です。');

    const toggle = [...root.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '過去の教材も表示');
    expect(toggle).toBeDefined();

    toggle!.click();
    await new Promise((resolve) => window.setTimeout(resolve, 50));

    expect(root.textContent).toContain('OLD QUESTION');
    expect(sessionStorage.getItem('loopdeck3_review_scope_session_v1')).toBe('all');
  });
});
