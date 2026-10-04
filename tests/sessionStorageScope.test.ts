// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoopDeckPack } from '../src/core/models';
import { createSession } from '../src/core/sessionEngine';
import { resolveActivePacks } from '../src/packs/packResolver';
import { defaultStudySettings } from '../src/core/studySettings';
import { renderModuleScreen } from '../src/screens/moduleScreen';
import { screenContext } from './support/screenContext';
import { clearBrowserStudyState } from '../src/storage/browserStudyState';
import {
  clearStoredSession,
  readStoredSession,
  saveStoredSession,
  sessionStorageKey,
  sessionStorageScope
} from '../src/storage/sessionStorage';
import type { SessionStorageScope } from '../src/storage/sessionStorage';
import { readStudyPreferences, writeStudyPreferences } from '../src/storage/studyPreferences';

const module = { id: 'm:c', folderId: '', title: 'Module', subject: 'Test', questionIds: ['q'] };
const question = { id: 'q', moduleId: module.id, type: 'input' as const, prompt: 'Prompt', answer: 'Answer' };
const byId = new Map([[question.id, question]]);
const settings = defaultStudySettings(module);
let scope: SessionStorageScope;
const session = () => createSession(module, [question], settings);
beforeEach(async () => {
  localStorage.clear();
  scope = { ...(await sessionStorageScope('a:b', module, [question])), packRevision: 'builtin', resetEpoch: '0' };
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('content-scoped browser study state', () => {
  it('uses stable compact SHA-256 content identity and includes answer rules', async () => {
    vi.stubGlobal('crypto', webcrypto);
    const original = await sessionStorageScope('pack', module, [question]);
    const reordered = {
      answer: question.answer,
      type: question.type,
      id: question.id,
      moduleId: question.moduleId,
      prompt: question.prompt
    };
    expect(original.contentIdentity).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect((await sessionStorageScope('pack', module, [reordered])).contentIdentity).toBe(original.contentIdentity);
    for (const changed of [
      { ...question, id: 'different-id' },
      { ...question, prompt: 'Different prompt' },
      { ...question, answer: 'Different answer' },
      { ...question, answerJudging: { mode: 'exact_phrase' as const } }
    ]) {
      expect((await sessionStorageScope('pack', module, [changed])).contentIdentity).not.toBe(original.contentIdentity);
    }
  });

  it('falls back to exact content matching when Web Crypto is unavailable', async () => {
    vi.stubGlobal('crypto', {});
    const original = await sessionStorageScope('pack', module, [question]);
    expect(original.contentIdentity).toMatch(/^json:/);
    expect((await sessionStorageScope('pack', module, [{ ...question, answer: 'changed' }])).contentIdentity).not.toBe(
      original.contentIdentity
    );
  });
  it('isolates pack/module pairs and rejects replacements reusing question IDs', async () => {
    expect(saveStoredSession(module.id, session(), scope)).toBe(true);
    expect(readStoredSession(module.id, byId, scope)).toBeDefined();
    expect(readStoredSession(module.id, byId, { ...scope, packId: 'other-pack' })).toBeUndefined();
    expect(sessionStorageKey('c', { ...scope, packId: 'a:b' })).not.toBe(sessionStorageKey('b:c', { ...scope, packId: 'a' }));
    const replacement = await sessionStorageScope(scope.packId, module, [{ ...question, answer: 'Changed' }]);
    expect(readStoredSession(module.id, byId, replacement)).toBeUndefined();
    expect(writeStudyPreferences(scope.packId, module.id, settings, undefined, scope.contentIdentity)).toBe(true);
    expect(readStudyPreferences(scope.packId, module.id, undefined, replacement.contentIdentity)).toBeUndefined();
  });

  it('never offers an ambiguous legacy resume in the module screen', async () => {
    saveStoredSession(module.id, session());
    const pack: LoopDeckPack = {
      packVersion: 1,
      packId: scope.packId,
      title: 'Pack',
      folders: [],
      modules: [module],
      questions: [question]
    };
    const root = document.createElement('div');
    const render = () => renderModuleScreen(screenContext({ root, catalog: resolveActivePacks([pack]), moduleId: module.id }));
    await render();
    expect([...root.querySelectorAll('button')].some((button) => button.textContent?.startsWith('再開'))).toBe(false);
    saveStoredSession(module.id, session(), scope);
    await render();
    expect([...root.querySelectorAll('button')].some((button) => button.textContent?.startsWith('再開'))).toBe(true);
  });

  it.each([
    { index: -1 },
    { index: 0.5 },
    { index: null },
    { settings: [] },
    { settings: { ...settings, shuffle: 'true' } },
    { settings: { ...settings, questionMode: 'unsupported' } },
    { settings: { ...settings, filter: ['all'] } },
    { startedAt: -1 },
    { attempts: [null] },
    { attempts: [{ elapsedMs: -1 }] },
    { questions: [{ questionId: 'q', questionMode: 'back_to_front' }] },
    {
      questions: [
        { questionId: 'q', questionMode: 'as_stored' },
        { questionId: 'q', questionMode: 'as_stored' }
      ]
    }
  ])('rejects malformed payload %#', (patch) => {
    saveStoredSession(module.id, session(), scope);
    const key = sessionStorageKey(module.id, scope);
    const stored = JSON.parse(localStorage.getItem(key)!);
    localStorage.setItem(key, JSON.stringify({ ...stored, ...patch }));
    expect(readStoredSession(module.id, byId, scope)).toBeUndefined();
  });

  it('keeps learning available and reports storage denial for writes and removals', async () => {
    const denied = () => {
      throw new DOMException('denied', 'SecurityError');
    };
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(denied);
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(denied);
    expect(saveStoredSession(module.id, session(), scope)).toBe(false);
    expect(clearStoredSession(module.id, scope)).toBe(false);
    const pack: LoopDeckPack = {
      packVersion: 1,
      packId: scope.packId,
      title: 'Pack',
      folders: [],
      modules: [module],
      questions: [question]
    };
    const root = document.createElement('div');
    await renderModuleScreen(screenContext({ root, catalog: resolveActivePacks([pack]), moduleId: module.id }));
    root.querySelector<HTMLButtonElement>('.v2-start')!.click();
    expect(root.querySelector('.quiz-card')).not.toBeNull();
    expect(document.body.textContent).toContain('再開位置を保存できませんでした');
  });

  it('clears only the deleted pack and clears all study state for replacement backups', () => {
    saveStoredSession(module.id, session(), scope);
    const other = { ...scope, packId: 'other' };
    saveStoredSession(module.id, session(), other);
    writeStudyPreferences(scope.packId, module.id, settings);
    localStorage.setItem('unrelated', 'keep');
    expect(clearBrowserStudyState(scope.packId)).toBe(true);
    expect(readStoredSession(module.id, byId, scope)).toBeUndefined();
    expect(readStoredSession(module.id, byId, other)).toBeDefined();
    saveStoredSession(module.id, session());
    expect(clearBrowserStudyState()).toBe(true);
    expect(Object.keys(localStorage)).toEqual(['unrelated']);
  });
});
