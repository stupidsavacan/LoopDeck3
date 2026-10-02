import { screenContext } from './support/screenContext';
// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import type { LoopDeckPack } from '../src/core/models';
import { resolveActivePacks } from '../src/packs/packResolver';
import { renderImportScreen } from '../src/screens/importScreen';
import { studyStore } from '../src/storage/studyRepository';

function pack(packId: string, prompt: string): LoopDeckPack {
  return {
    packVersion: 1,
    packId,
    title: 'Same ID Pack',
    folders: [{ id: 'f', title: 'Folder' }],
    modules: [{ id: 'm', folderId: 'f', title: 'Module', subject: 'demo', questionIds: ['q'] }],
    questions: [{ id: 'q', moduleId: 'm', type: 'input', prompt, answer: 'Answer', imageAsset: 'images/map.png' }]
  };
}

function installFileTextForJSDom(): void {
  if (typeof File.prototype.text === 'function') return;
  Object.defineProperty(File.prototype, 'text', {
    configurable: true,
    value(this: File): Promise<string> {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? ''));
        reader.onerror = () => reject(reader.error);
        reader.readAsText(this);
      });
    }
  });
}

describe('same-packId import UI', () => {
  it('continues to offer overwrite update and merge update', async () => {
    installFileTextForJSDom();
    const packId = 'merge-ui-image-pack';
    const existing = pack(packId, 'Existing question');
    const incoming = pack(packId, 'Incoming question');
    await studyStore.deleteImportedPack(packId);
    await studyStore.saveImportedPack(existing);

    const root = document.createElement('div');
    await renderImportScreen(screenContext({ root: root, catalog: resolveActivePacks([existing]), refreshCatalog: async () => {}, navigation: { home: () => {} } }));

    const input = root.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File([JSON.stringify(incoming)], 'same-id.loopdeck.json', { type: 'application/json' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    await input.onchange?.(new Event('change'));

    const labels = [...root.querySelectorAll('button')].map((item) => item.textContent);
    expect(labels).toContain('\u4e0a\u66f8\u304d\u66f4\u65b0\u3059\u308b');
    expect(labels).toContain('\u30de\u30fc\u30b8\u66f4\u65b0\u3059\u308b');

    await studyStore.deleteImportedPack(packId);
  });
});
