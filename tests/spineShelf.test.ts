import { screenContext } from './support/screenContext';
// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoopDeckPack } from '../src/core/models';
import { createReviewCard } from '../src/core/scheduler';
import { resolveActivePacks } from '../src/packs/packResolver';
import { renderHomeScreen } from '../src/screens/homeScreen';
import { LIBRARY_VIEW_KEY } from '../src/storage/libraryState';
import { studyStore } from '../src/storage/studyRepository';

const pack: LoopDeckPack = {
  packVersion: 1,
  packId: 'spine-pack',
  title: 'Spine pack',
  folders: [{ id: 'f', title: '一学期中間テスト' }],
  modules: [
    {
      id: 'big',
      folderId: 'f',
      title: '歴史総合',
      subject: '社会',
      questionIds: Array.from({ length: 200 }, (_, index) => `big-${index}`)
    },
    { id: 'small', folderId: 'f', title: '古文', subject: '国語', questionIds: ['small-0'] }
  ],
  questions: [
    ...Array.from({ length: 200 }, (_, index) => ({
      id: `big-${index}`,
      moduleId: 'big',
      type: 'input' as const,
      prompt: `${index}`,
      answer: `${index}`
    })),
    { id: 'small-0', moduleId: 'small', type: 'input', prompt: 'x', answer: 'x' }
  ]
};

const settle = () => new Promise((resolve) => window.setTimeout(resolve, 80));

beforeEach(async () => {
  localStorage.clear();
  await studyStore.clearReviewData();
});

describe('home spine shelf', () => {
  it('keeps cards by default and switches to spines on request', async () => {
    const module = vi.fn();
    const root = document.createElement('div');
    renderHomeScreen(screenContext({ root, catalog: resolveActivePacks([pack]), navigation: { module } }));
    expect(root.querySelectorAll('.module-card')).toHaveLength(2);
    expect(root.querySelector('.library-view-option[aria-pressed="true"]')?.textContent).toBe('カード');

    [...root.querySelectorAll<HTMLButtonElement>('.library-view-option')].find((option) => option.textContent === '背表紙')!.click();
    expect(localStorage.getItem(LIBRARY_VIEW_KEY)).toBe('shelf');
    const spines = [...root.querySelectorAll<HTMLButtonElement>('.module-spine')];
    expect(spines.map((spine) => spine.style.getPropertyValue('--spine-width'))).toEqual(['72px', '48px']);
    spines[1].click();
    expect(module).toHaveBeenCalledWith('small');
  });

  it('fills the mastery band and gilds a mastered module', async () => {
    localStorage.setItem(LIBRARY_VIEW_KEY, 'shelf');
    await studyStore.putReviewCard({
      ...createReviewCard('small-0', 'small'),
      state: 'mastered',
      dueAt: new Date(Date.now() + 86_400_000).toISOString()
    });
    const root = document.createElement('div');
    renderHomeScreen(screenContext({ root, catalog: resolveActivePacks([pack]) }));
    await settle();

    const small = [...root.querySelectorAll<HTMLElement>('.module-spine')].find((spine) => spine.dataset.title === '古文')!;
    expect(small.style.getPropertyValue('--mastery')).toBe('100%');
    expect(small.classList.contains('is-mastered')).toBe(true);
    expect(small.getAttribute('aria-label')).toBe('古文 1問 習熟100%');
  });

  it('shows cards for search results even on the spine shelf', () => {
    localStorage.setItem(LIBRARY_VIEW_KEY, 'shelf');
    const root = document.createElement('div');
    renderHomeScreen(screenContext({ root, catalog: resolveActivePacks([pack]) }));
    const search = root.querySelector<HTMLInputElement>('.search')!;
    search.value = '古文';
    search.dispatchEvent(new Event('input'));
    expect(root.querySelectorAll('.module-card')).toHaveLength(1);
    expect(root.querySelector('.module-spine')).toBeNull();
  });
});
