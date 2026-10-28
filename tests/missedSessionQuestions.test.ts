import { describe, expect, it } from 'vitest';
import type { Question, ReviewLog } from '../src/core/models';
import { presentQuestionForStudy } from '../src/core/questionPresentation';
import { buildQuizAttempt } from '../src/core/quizAnswer';
import { applyReviewRating, canReviseReviewRating, createReviewCard } from '../src/core/scheduler';
import { createSession, missedSessionQuestions, restartSession } from '../src/core/sessionEngine';

const twoSided: Question = {
  id: 'two-sided',
  moduleId: 'm',
  type: 'input',
  prompt: 'word',
  answer: '単語',
  sides: { front: { label: 'EN', text: 'word' }, back: { label: 'JA', text: '単語' } },
  supportedStudyModes: ['front_to_back', 'back_to_front']
};
const module = { id: 'm', folderId: '', title: 'Words', subject: 'English', questionIds: [twoSided.id] };
const settings = {
  shuffle: false,
  autoNext: true,
  questionLimit: 'all' as const,
  showExample: false,
  showNumber: false,
  showCategory: false
};

describe('missedSessionQuestions', () => {
  it('retries the direction that was missed, not a re-rolled one', () => {
    const session = createSession(module, [twoSided], { ...settings, questionMode: 'mixed' });
    const forward = presentQuestionForStudy(twoSided, 'front_to_back');
    const reverse = presentQuestionForStudy(twoSided, 'back_to_front');
    session.queue = [forward, reverse];
    session.attempts = [
      buildQuizAttempt(forward, 'correct', '単語', 1000, 'normal', 'input', 0),
      buildQuizAttempt(reverse, 'revealed', '', 1000, 'normal', 'input', 0)
    ];

    const missed = missedSessionQuestions(session);
    expect(missed).toEqual([reverse]);
    expect(missed[0]).toBe(reverse);

    const retry = restartSession(session, missed, 100);
    expect(retry).toMatchObject({ index: 0, attempts: [], startedAt: 100, sessionElapsedMs: 0 });
    expect(retry.queue[0].activeStudyMode).toBe('back_to_front');
    expect(retry.choicePool).toBe(session.choicePool);
  });
});

describe('canReviseReviewRating', () => {
  it('treats a log without questionMode like the stored-direction card it came from', () => {
    const now = new Date('2026-10-01T09:00:00Z');
    const { card, log } = applyReviewRating(createReviewCard('q', 'm', now), 'good', 'correct', 3000, { now });
    const legacyLog = { ...log } as Partial<ReviewLog>;
    delete legacyLog.questionMode;
    expect(canReviseReviewRating(card, legacyLog as ReviewLog)).toBe(true);
  });
});
