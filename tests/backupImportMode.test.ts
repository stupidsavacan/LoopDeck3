import { screenContext } from './support/screenContext';
// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveActivePacks } from '../src/packs/packResolver';
import { renderImportScreen } from '../src/screens/importScreen';
import { studyStore } from '../src/storage/studyRepository';
import type { StudyBackup } from '../src/storage/storageTypes';

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

const backup: StudyBackup = {
  format: 'loopdeck3.backup', schema: 1,
  exportedAt: '2026-09-27T00:00:00.000Z',
  attempts: [],
  bookmarks: [],
  importedPacks: [],
  importedPackAssets: [],
  reviewCards: [],
  reviewLogs: []
};

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('backup import UI semantics', () => {
  it('does not import immediately and offers explicit replace vs merge actions', async () => {
    installFileTextForJSDom();
    vi.spyOn(studyStore, 'getImportedPacks').mockResolvedValue([]);
    const restoreSnapshot = vi.spyOn(studyStore, 'restoreSnapshot').mockResolvedValue();
    const root = document.createElement('div');
    document.body.append(root);
    await renderImportScreen(screenContext({ root: root, catalog: resolveActivePacks([]), refreshCatalog: async () => {}, navigation: { home: () => {} } })
    );

    const input = root.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File([JSON.stringify(backup)], 'backup.json', { type: 'application/json' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    await input.onchange?.(new Event('change'));

    expect(restoreSnapshot).not.toHaveBeenCalled();
    const labels = [...root.querySelectorAll('button')].map((button) => button.textContent);
    expect(labels).toContain('現在データを置き換えて復元');
    expect(labels).toContain('現在データにマージ');

    const merge = [...root.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '現在データにマージ')!;
    merge.click();
    await vi.waitFor(() => expect(restoreSnapshot).toHaveBeenCalledWith(backup, 'merge'));
  });
});
