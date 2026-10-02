import { questionRevision } from '../src/core/questionRevision';
// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import type { Question, StudySettings } from '../src/core/models';
import { readStoredSession } from '../src/storage/sessionStorage';
import { runtimeSettings } from '../src/core/studySettings';

const question: Question = {
  id: 'resume-question',
  moduleId: 'resume-module',
  type: 'input',
  prompt: 'Question?',
  answer: 'Answer'
};

function store(settings: StudySettings): void {
  localStorage.setItem('loopdeck3.session.resume-module', JSON.stringify({
    format: 'loopdeck3.session', version: 1,
    questions: [{ questionId: question.id, revision: questionRevision(question), questionMode: 'as_stored' }],
    startedAt: 0, currentElapsedMs: 0, currentHiddenTimeExcludedMs: 0, attempts: [],
    index: 0,
    mode: 'normal',
    settings,
    savedAt: '2026-09-02T00:00:00.000Z'
  }));
}

beforeEach(() => localStorage.clear());

describe('session idle reveal settings', () => {
  it('keeps an omitted optional idle reveal setting disabled', () => {
    store({ shuffle: false, autoNext: false, questionLimit: 'all' });
    const restored = readStoredSession(question.moduleId, new Map([[question.id, question]]));

    expect(restored).toBeDefined();
    expect(restored?.settings.autoRevealAfterIdle).toBeUndefined();
    expect(runtimeSettings(restored!.settings).autoRevealAfterIdle).toBeUndefined();
  });

  it('round-trips the enabled setting only through the stored session settings', () => {
    store({ shuffle: true, autoNext: true, autoRevealAfterIdle: true, questionLimit: 'all' });
    const restored = readStoredSession(question.moduleId, new Map([[question.id, question]]));

    expect(restored?.settings.autoRevealAfterIdle).toBe(true);
    expect(runtimeSettings(restored!.settings).autoRevealAfterIdle).toBe(true);
  });
});
