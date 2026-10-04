// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { LoopDeckPack } from '../src/core/models';
import { filterStudyQuestions, listQuestionCategories } from '../src/core/sessionEngine';
import { encodeStudyCategory } from '../src/core/studyCategory';
import { resolveActivePacks } from '../src/packs/packResolver';
import { validatePack } from '../src/packs/packValidator';
import { buildHomeFolders } from '../src/screens/homeFolders';
import { renderHomeScreen } from '../src/screens/homeScreen';
import { defaultStudySettings } from '../src/core/studySettings';
import { renderModuleScreen } from '../src/screens/moduleScreen';
import { screenContext } from './support/screenContext';
import { readStudyPreferences, sanitizeStudyPreferences } from '../src/storage/studyPreferences';

function metadataPack(): LoopDeckPack {
  const categories = [' A ', 'A', 'all', 'x', '["category","all"]'];
  const questions = categories.map((category, index) => ({
    id: `q${index}`,
    moduleId: 'm',
    type: 'input' as const,
    prompt: `Prompt ${index}`,
    answer: `Answer ${index}`,
    category
  }));
  return {
    packVersion: 1,
    packId: 'metadata',
    title: 'Metadata',
    folders: [{ id: 'other', title: 'Authored Other' }],
    modules: [{ id: 'm', folderId: 'other', title: 'Module', subject: 'Test', questionIds: questions.map((q) => q.id) }],
    questions
  };
}

function categorySelector(root: HTMLElement): HTMLSelectElement {
  const label = [...root.querySelectorAll('.field-label')].find((node) => node.querySelector('span')?.textContent === 'カテゴリ');
  const select = label?.querySelector('select');
  if (!select) throw new Error('Category selector missing');
  return select;
}

beforeEach(() => localStorage.clear());

describe('pack-authored metadata identities', () => {
  it('canonicalizes whitespace at validation and matches legacy unnormalized questions consistently', () => {
    const source = metadataPack();
    const validated = validatePack(source);
    expect(validated.ok).toBe(true);
    expect(validated.pack?.questions.map((q) => q.category)).toEqual(['A', 'A', 'all', 'x', '["category","all"]']);
    // Previously persisted packs may still contain their original whitespace.
    for (const questions of [source.questions, validated.pack!.questions]) {
      expect(listQuestionCategories(questions).filter((category) => category === 'A')).toHaveLength(1);
      const selected = filterStudyQuestions(questions, {
        ...defaultStudySettings(source.modules[0]),
        selectedCategory: encodeStudyCategory('A')
      });
      expect(selected.map((q) => q.id)).toEqual(['q0', 'q1']);
    }
  });

  it('keeps the all sentinel, literal all, and JSON-looking authored category distinct in the UI and preferences', async () => {
    const pack = metadataPack();
    const root = document.createElement('div');
    const render = () => renderModuleScreen(screenContext({ root, catalog: resolveActivePacks([pack]), moduleId: 'm' }));
    await render();
    const select = categorySelector(root);
    const options = [...select.options];
    expect(options.map((option) => option.value).length).toBe(new Set(options.map((option) => option.value)).size);
    expect(options.filter((option) => option.textContent === 'A')).toHaveLength(1);
    expect(options.find((option) => option.textContent === '全部')?.value).toBe('all');
    expect(options.find((option) => option.textContent === 'all')?.value).toBe(encodeStudyCategory('all'));

    for (const category of ['all', '["category","all"]']) {
      const selector = categorySelector(root);
      selector.value = encodeStudyCategory(category);
      selector.dispatchEvent(new Event('change', { bubbles: true }));
      const stored = readStudyPreferences(pack.packId, 'm');
      expect(stored?.selectedCategory).toBe(encodeStudyCategory(category));
      const restored = sanitizeStudyPreferences(defaultStudySettings(pack.modules[0]), stored, {
        validRanges: ['all'],
        categories: listQuestionCategories(pack.questions),
        questionModes: ['as_stored']
      });
      expect(filterStudyQuestions(pack.questions, restored).map((q) => q.id)).toEqual([category === 'all' ? 'q2' : 'q4']);
      await render();
      expect(categorySelector(root).value).toBe(encodeStudyCategory(category));
    }
  });

  it('gives authored other and the automatic fallback distinct expansion state in both toggle directions', () => {
    const pack = metadataPack();
    pack.modules.push({ id: 'unfiled', folderId: '', title: 'Unfiled', subject: 'Test', questionIds: ['unfiled-q'] });
    pack.questions.push({ id: 'unfiled-q', moduleId: 'unfiled', type: 'input', prompt: 'Unfiled', answer: 'Answer' });
    const folders = buildHomeFolders([pack], pack.modules);
    expect(folders.map((folder) => [folder.kind, folder.id])).toEqual([
      ['authored', 'other'],
      ['fallback', 'other']
    ]);
    // An old shared key cannot safely be assigned to either of the two shelves.
    localStorage.setItem('loopdeck3.library.folders.other', '0');
    const root = document.createElement('div');
    const render = () => renderHomeScreen(screenContext({ root, catalog: resolveActivePacks([pack]) }));
    const heads = () => [...root.querySelectorAll<HTMLButtonElement>('.folder-head')];
    const states = () => heads().map((head) => head.getAttribute('aria-expanded'));
    render();
    expect(states()).toEqual(['true', 'true']);
    heads()[0].click();
    render();
    expect(states()).toEqual(['false', 'true']);
    heads()[1].click();
    render();
    expect(states()).toEqual(['false', 'false']);
    heads()[0].click();
    render();
    expect(states()).toEqual(['true', 'false']);
    const keys = Object.keys(localStorage).filter((key) => key.startsWith('loopdeck3.library.folders.['));
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
  });
});
