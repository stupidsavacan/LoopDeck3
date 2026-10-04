// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LoopDeckPack } from '../src/core/models';
import { resolveActivePacks } from '../src/packs/packResolver';
import { renderImportScreen } from '../src/screens/importScreen';
import { readImportFile } from '../src/services/importFileService';
import { studyStore } from '../src/storage/studyRepository';
import { screenContext } from './support/screenContext';

vi.mock('../src/services/importFileService', () => ({ readImportFile: vi.fn() }));
const pack = (packId: string, moduleId = 'fresh-m'): LoopDeckPack => ({
  packVersion: 1,
  packId,
  title: packId,
  folders: [],
  modules: [{ id: moduleId, folderId: '', title: moduleId, subject: 'Test', questionIds: ['fresh-q'] }],
  questions: [{ id: 'fresh-q', moduleId, type: 'input', prompt: packId, answer: 'Answer' }]
});
afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

async function preview(existing: LoopDeckPack[], incoming: LoopDeckPack) {
  const reads = vi.spyOn(studyStore, 'getImportedPacks').mockResolvedValue(existing);
  const saves = vi.spyOn(studyStore, 'saveImportedPackWithAssets').mockResolvedValue();
  vi.mocked(readImportFile).mockResolvedValue({ kind: 'pack', result: { ok: true, pack: incoming, issues: [] } });
  const root = document.createElement('div');
  const onImported = vi.fn(async () => {});
  await renderImportScreen(screenContext({ root, catalog: resolveActivePacks(existing), refreshCatalog: onImported }));
  const input = root.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, 'files', { value: [new File(['{}'], 'pack.json')] });
  await input.onchange?.call(input, new Event('change'));
  return { root, reads, saves, onImported };
}

async function click(root: HTMLElement, label: string) {
  const button = [...root.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === label)!;
  await button.onclick?.call(button, new MouseEvent('click') as PointerEvent);
}

describe('import click-time content identity', () => {
  it('explains an ambiguous merge across two active pack owners instead of choosing one', async () => {
    const first = pack('first', 'first-module');
    const second = pack('second', 'second-module');
    first.questions[0].id = 'first-question';
    second.questions[0].id = 'second-question';
    first.modules[0].questionIds = ['first-question'];
    second.modules[0].questionIds = ['second-question'];
    const incoming = {
      ...pack('incoming'),
      modules: [...first.modules, ...second.modules],
      questions: [...first.questions, ...second.questions]
    };
    const { root } = await preview([first, second], incoming);
    expect(root.textContent).toContain('教材マージ更新の対象を一つに決められない');
    expect([...root.querySelectorAll('button')].some((button) => button.textContent === '教材マージ更新する')).toBe(false);
  });

  it('reports snapshot export failure without an unhandled rejection', async () => {
    const { root } = await preview([], pack('incoming'));
    vi.spyOn(studyStore, 'exportSnapshot').mockRejectedValue(new Error('snapshot unavailable'));
    await click(root, '履歴バックアップを書き出し');
    await vi.waitFor(() => expect(document.body.textContent).toContain('書き出しに失敗しました：snapshot unavailable'));
  });

  it('rejects a question collision installed by another tab after the preview was rendered', async () => {
    const { root, reads, saves, onImported } = await preview([], pack('incoming'));
    reads.mockResolvedValue([pack('concurrent', 'another-module')]);
    await click(root, 'この教材を取り込む');
    expect(saves).not.toHaveBeenCalled();
    expect(onImported).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('問題IDが別パックと衝突');
  });

  it('does not resurrect a deleted module merge target from a captured pack view', async () => {
    const { root, reads, saves } = await preview([pack('existing')], pack('incoming'));
    reads.mockResolvedValue([]);
    await click(root, '教材マージ更新する');
    expect(saves).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('マージ対象の教材が変更されました');
  });

  it('reports a rejected install and re-enables the action for retry', async () => {
    const { root, saves, onImported } = await preview([], pack('incoming'));
    saves.mockRejectedValue(new Error('transaction conflict'));
    await click(root, 'この教材を取り込む');
    expect(onImported).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('教材を保存できませんでした：transaction conflict');
    expect(
      [...root.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'この教材を取り込む')?.disabled
    ).toBe(false);
  });
});
