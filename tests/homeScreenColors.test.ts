import { screenContext } from './support/screenContext';
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { LoopDeckPack, ModuleInfo } from '../src/core/models';
import { resolveActivePacks } from '../src/packs/packResolver';
import { renderHomeScreen } from '../src/screens/homeScreen';
import { moduleMeta } from '../src/ui/modulePresentation';

function moduleInfo(overrides: Partial<ModuleInfo> = {}): ModuleInfo {
  return {
    id: 'geography-final',
    folderId: 'term1-final',
    title: 'Geography Final',
    subject: 'social studies',
    questionIds: ['q1'],
    ...overrides
  };
}

function pack(module: ModuleInfo): LoopDeckPack {
  return {
    packVersion: 1,
    packId: 'color-pack',
    title: 'Color Pack',
    folders: [{ id: module.folderId, title: 'Final' }],
    modules: [module],
    questions: [{ id: 'q1', moduleId: module.id, type: 'input', prompt: 'Prompt', answer: 'Answer' }]
  };
}

function renderSingleCard(module: ModuleInfo): { card: HTMLElement; icon: HTMLElement } {
  const root = document.createElement('div');
  renderHomeScreen(screenContext({ root: root, catalog: resolveActivePacks([pack(module)]), navigation: { module: () => {} } })
  );

  const card = root.querySelector<HTMLElement>('.module-card');
  const icon = root.querySelector<HTMLElement>('.module-icon');
  expect(card).toBeTruthy();
  expect(icon).toBeTruthy();
  return { card: card!, icon: icon! };
}

describe('Home module card colors', () => {
  it('uses module.color for the card border and icon background', () => {
    const { card, icon } = renderSingleCard(moduleInfo({ color: '#15803D', accentColor: '#DCFCE7' }));

    expect(card.style.borderColor).toBe('rgba(21, 128, 61, 0.2)');
    expect(icon.style.background).toBe('rgb(21, 128, 61)');
  });

  it('uses module.accentColor as the soft card background', () => {
    const { card } = renderSingleCard(moduleInfo({ color: '#15803D', accentColor: '#DCFCE7' }));

    expect(card.style.background).toContain('#DCFCE7');
  });

  it('keeps final-term subject colors for imported module IDs', () => {
    expect(moduleMeta(moduleInfo({ id: 'geography-final', color: '#15803D', accentColor: '#DCFCE7' })).accent).toBe('#15803D');
    expect(moduleMeta(moduleInfo({ id: 'history-final', color: '#92400E', accentColor: '#FEF3C7' })).accent).toBe('#92400E');
    expect(moduleMeta(moduleInfo({ id: 'biology-final', color: '#16A34A', accentColor: '#DCFCE7' })).accent).toBe('#16A34A');
  });

  it('lets an unknown module use module.color before falling back', () => {
    expect(moduleMeta(moduleInfo({ id: 'custom-pack-module', subject: 'custom', color: '#ABCDEF' })).accent).toBe('#ABCDEF');
  });

  it('ignores invalid module colors and falls back without crashing', () => {
    const meta = moduleMeta(
      moduleInfo({
        id: 'custom-pack-module',
        title: 'Custom Pack Module',
        subject: 'custom',
        color: 'green',
        accent: 'not-a-color',
        accentColor: 'bad'
      })
    );

    expect(meta.accent).toBe('#2563eb');
    expect(meta.accentColor).toBeUndefined();
  });
});
