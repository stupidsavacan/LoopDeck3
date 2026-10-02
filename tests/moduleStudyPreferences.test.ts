// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { LoopDeckPack, ModuleInfo, StudySettings } from '../src/core/models';
import { resolveActivePacks } from '../src/packs/packResolver';
import { defaultStudySettings, renderModuleScreen } from '../src/screens/moduleScreen';
import { db } from '../src/storage/db';
import {
  readStudyPreferences,
  sanitizeStudyPreferences,
  studyPreferencesKey,
  writeStudyPreferences
} from '../src/storage/studyPreferences';

const moduleInfo: ModuleInfo = {
  id: 'prefs-module',
  folderId: 'folder',
  title: 'Preferences module',
  subject: 'Test',
  questionIds: [],
  preferredAnswerFormat: 'auto'
};

const defaults = defaultStudySettings(moduleInfo);
const sanitizeContext = {
  validRanges: ['all', '1-25', '26-50'],
  categories: ['A', 'B'],
  questionModes: ['as_stored', 'front_to_back', 'back_to_front', 'mixed'] as const
};

function testPack(questionCount = 30): LoopDeckPack {
  const questions = Array.from({ length: questionCount }, (_, index) => ({
    id: `prefs-q-${index + 1}`,
    moduleId: moduleInfo.id,
    type: 'input' as const,
    number: index + 1,
    category: index < 25 ? 'A' : 'B',
    prompt: `word-${index + 1}`,
    answer: `\u610f\u5473${index + 1}`
  }));
  return {
    packVersion: 1,
    packId: 'prefs-pack',
    title: 'Preferences pack',
    folders: [{ id: 'folder', title: 'Folder' }],
    modules: [{ ...moduleInfo, questionIds: questions.map((question) => question.id) }],
    questions
  };
}

function fieldSelect(root: HTMLElement, label: string): HTMLSelectElement {
  const field = [...root.querySelectorAll<HTMLLabelElement>('.field-label')].find(
    (node) => node.querySelector('span')?.textContent === label
  );
  const select = field?.querySelector('select');
  if (!(select instanceof HTMLSelectElement)) throw new Error(`Missing select: ${label}`);
  return select;
}

function settingCheckbox(root: HTMLElement, label: string): HTMLInputElement {
  const wrap = [...root.querySelectorAll<HTMLLabelElement>('.check-label')].find((node) => node.textContent?.includes(label));
  const input = wrap?.querySelector('input');
  if (!(input instanceof HTMLInputElement)) throw new Error(`Missing checkbox: ${label}`);
  return input;
}

function change(element: HTMLInputElement | HTMLSelectElement): void {
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

async function settle(ms = 80): Promise<void> {
  await new Promise((resolve) => window.setTimeout(resolve, ms));
}

beforeEach(async () => {
  localStorage.clear();
  await db.clearAttempts();
  await db.clearBookmarks();
});

describe('study preference storage', () => {
  it('returns undefined for missing, malformed, or unknown-version data', () => {
    expect(readStudyPreferences('pack', 'module')).toBeUndefined();
    localStorage.setItem(studyPreferencesKey('pack', 'module'), '{broken');
    expect(readStudyPreferences('pack', 'module')).toBeUndefined();
    localStorage.setItem(studyPreferencesKey('pack', 'module'), JSON.stringify({ version: 99, settings: {} }));
    expect(readStudyPreferences('pack', 'module')).toBeUndefined();
  });

  it('stores reusable settings independently by pack and module without session-only filter state', () => {
    const settings: StudySettings = {
      ...defaults,
      shuffle: false,
      autoNext: false,
      autoRevealAfterIdle: true,
      questionLimit: 20,
      selectedRange: '1-25',
      selectedCategory: 'A',
      filter: 'wrong',
      answerFormat: 'input',
      questionMode: 'mixed',
      showExample: false,
      showNumber: false,
      showCategory: false
    };

    expect(writeStudyPreferences('pack-a', 'module-a', settings)).toBe(true);
    expect(readStudyPreferences('pack-a', 'module-a')).toMatchObject({
      shuffle: false,
      autoNext: false,
      autoRevealAfterIdle: true,
      questionLimit: 20,
      selectedRange: '1-25',
      selectedCategory: 'A',
      answerFormat: 'input',
      questionMode: 'mixed',
      showExample: false,
      showNumber: false,
      showCategory: false
    });
    expect(readStudyPreferences('pack-a', 'module-a')).not.toHaveProperty('filter');
    expect(readStudyPreferences('pack-a', 'module-b')).toBeUndefined();
    expect(readStudyPreferences('pack-b', 'module-a')).toBeUndefined();
  });

  it('sanitizes stale or invalid values against the current module', () => {
    const stored = {
      shuffle: 'no',
      autoNext: false,
      autoRevealAfterIdle: true,
      questionLimit: 999,
      selectedRange: '999-1000',
      selectedCategory: 'removed-category',
      answerFormat: 'unsupported',
      questionMode: 'removed-mode',
      showExample: false,
      showNumber: 1,
      showCategory: false,
      filter: 'wrong'
    } as unknown as Partial<StudySettings>;
    const sanitized = sanitizeStudyPreferences(defaults, stored, sanitizeContext);

    expect(sanitized).toMatchObject({
      shuffle: true,
      autoNext: false,
      autoRevealAfterIdle: true,
      questionLimit: 'all',
      selectedRange: 'all',
      selectedCategory: 'all',
      answerFormat: 'auto',
      questionMode: 'as_stored',
      showExample: false,
      showNumber: true,
      showCategory: false,
      filter: 'all'
    });
  });
});

describe('module screen study preferences', () => {
  it('persists changes immediately and restores them without starting a session', async () => {
    const pack = testPack();
    const view = resolveActivePacks([pack]);
    const root = document.createElement('div');
    await renderModuleScreen(
      root,
      view,
      moduleInfo.id,
      () => {},
      () => {},
      () => {}
    );

    const count = fieldSelect(root, '\u554f\u984c\u6570');
    const range = fieldSelect(root, '\u7bc4\u56f2');
    const category = fieldSelect(root, '\u30ab\u30c6\u30b4\u30ea');
    const answer = fieldSelect(root, '\u56de\u7b54\u5f62\u5f0f');
    const shuffle = settingCheckbox(root, '\u30b7\u30e3\u30c3\u30d5\u30eb');

    count.value = '20';
    change(count);
    range.value = '1-25';
    change(range);
    category.value = JSON.stringify(['category', 'A']);
    change(category);
    answer.value = 'input';
    change(answer);
    shuffle.checked = false;
    change(shuffle);

    const stored = readStudyPreferences(pack.packId, moduleInfo.id);
    expect(stored).toMatchObject({
      questionLimit: 20,
      selectedRange: '1-25',
      selectedCategory: JSON.stringify(['category', 'A']),
      answerFormat: 'input',
      shuffle: false
    });

    await renderModuleScreen(
      root,
      view,
      moduleInfo.id,
      () => {},
      () => {},
      () => {}
    );
    expect(fieldSelect(root, '\u554f\u984c\u6570').value).toBe('20');
    expect(fieldSelect(root, '\u7bc4\u56f2').value).toBe('1-25');
    expect(fieldSelect(root, '\u30ab\u30c6\u30b4\u30ea').value).toBe(JSON.stringify(['category', 'A']));
    expect(fieldSelect(root, '\u56de\u7b54\u5f62\u5f0f').value).toBe('input');
    expect(settingCheckbox(root, '\u30b7\u30e3\u30c3\u30d5\u30eb').checked).toBe(false);
  });

  it('clears only resume state when a session completes and keeps reusable preferences', async () => {
    const pack = testPack(1);
    const view = resolveActivePacks([pack]);
    const root = document.createElement('div');
    await renderModuleScreen(
      root,
      view,
      moduleInfo.id,
      () => {},
      () => {},
      () => {}
    );

    const answerFormat = fieldSelect(root, '\u56de\u7b54\u5f62\u5f0f');
    answerFormat.value = 'input';
    change(answerFormat);
    const autoNext = settingCheckbox(root, '\u6b63\u89e3\u6642\u306b\u81ea\u52d5\u3067\u6b21\u3078');
    autoNext.checked = false;
    change(autoNext);
    const preferenceKey = studyPreferencesKey(pack.packId, moduleInfo.id);
    expect(localStorage.getItem(preferenceKey)).not.toBeNull();

    [...root.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('\u5b66\u7fd2\u3092\u59cb\u3081\u308b'))!
      .click();
    const input = root.querySelector<HTMLInputElement>('input.text-input')!;
    input.value = '\u610f\u54731';
    [...root.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '\u56de\u7b54\u3059\u308b')!.click();
    await settle();

    const next = [...root.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('\u6b21\u3078'))!;
    expect(next.hidden).toBe(false);
    next.click();
    await settle(20);

    [...root.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === '\u6559\u6750\u8a73\u7d30\u306b\u623b\u308b')!
      .click();
    await settle();

    expect(localStorage.getItem(`loopdeck3_session_${moduleInfo.id}`)).toBeNull();
    expect(localStorage.getItem(preferenceKey)).not.toBeNull();
    expect(readStudyPreferences(pack.packId, moduleInfo.id)?.answerFormat).toBe('input');
  });
});
