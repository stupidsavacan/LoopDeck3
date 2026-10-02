// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import type { ModuleInfo, Question } from '../src/core/models';
import { createSession } from '../src/core/sessionEngine';
import { defaultStudySettings } from '../src/core/studySettings';
import { questionRevision } from '../src/core/questionRevision';
import { readStoredSession, saveStoredSession } from '../src/storage/sessionStorage';

afterEach(() => localStorage.clear());
const module: ModuleInfo = { id: 'revision-module', folderId: 'folder', title: 'Study', subject: 'test', questionIds: ['q'] };
const question: Question = { id: 'q', moduleId: module.id, type: 'input', prompt: 'Before', answer: 'A' };

describe('checkpoint material identity', () => {
  it('resumes unchanged data but rejects a replacement that reuses the same question ID', () => {
    saveStoredSession(module.id, createSession(module, [question], defaultStudySettings(module)));
    expect(readStoredSession(module.id, new Map([['q', question]]))).toBeDefined();
    expect(readStoredSession(module.id, new Map([['q', { ...question, answer: 'B' }]]))).toBeUndefined();
  });
  it('compares semantic content regardless of JSON field order', () => {
    const reordered: Question = { answer: 'A', prompt: 'Before', type: 'input', moduleId: module.id, id: 'q' };
    expect(questionRevision(reordered)).toBe(questionRevision(question));
  });
});
