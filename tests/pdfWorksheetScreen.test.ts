import { screenContext } from './support/screenContext';
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { LoopDeckPack } from '../src/core/models';
import { resolveActivePacks } from '../src/packs/packResolver';
import { renderPdfWorksheetScreen } from '../src/screens/pdfWorksheetScreen';

function pack(packId: string, title: string, questionId: string): LoopDeckPack {
  return {
    packVersion: 1,
    packId,
    title,
    folders: [{ id: 'f', title: 'Folder' }],
    modules: [{ id: 'shared-module', folderId: 'f', title, subject: 'English', questionIds: [questionId] }],
    questions: [
      {
        id: questionId,
        moduleId: 'shared-module',
        type: 'input',
        number: 1,
        prompt: '\u65e5\u672c\u8a9e\u306e\u610f\u5473',
        answer: 'english'
      }
    ]
  };
}

describe('PDF worksheet module selection', () => {
  it('uses each module owner when legacy packs contain the same question id', async () => {
    const first = pack('a', 'First', 'duplicate');
    const second = pack('b', 'Second', 'duplicate');
    first.modules[0].id = first.questions[0].moduleId = 'first-module';
    second.modules[0].id = second.questions[0].moduleId = 'second-module';
    second.questions[0].number = 1000;
    const root = document.createElement('div');
    await renderPdfWorksheetScreen(screenContext({ root: root, catalog: resolveActivePacks([first, second]), navigation: { home: () => {} } }));
    const select = root.querySelector<HTMLSelectElement>('.settings-grid select');
    const labels = [...(select?.options ?? [])].map((option) => option.textContent);
    expect(labels).toEqual(['First No.1 (1問)', 'Second No.1000 (1問)']);
  });
  it('lists only the active module when different packs override the same module id', async () => {
    const oldPack = pack('old-pack', 'Old module', 'old-question');
    const activePack = pack('active-pack', 'Active module', 'active-question');
    const root = document.createElement('div');

    await renderPdfWorksheetScreen(screenContext({ root: root, catalog: resolveActivePacks([oldPack, activePack]), navigation: { home: () => {} } }));

    const moduleSelect = root.querySelector<HTMLSelectElement>('.settings-grid select');
    const labels = [...(moduleSelect?.options ?? [])].map((option) => option.textContent);
    expect(labels).toHaveLength(1);
    expect(labels[0]).toContain('Active module');
    const checkboxLabels = [...root.querySelectorAll<HTMLLabelElement>('.check-label')].map((label) => label.textContent?.trim());
    expect(checkboxLabels).toContain('問題順をシャッフル');
    const checkboxes = [...root.querySelectorAll<HTMLInputElement>('.check-label input[type="checkbox"]')];
    expect(checkboxes[0]?.checked).toBe(false);
    expect(checkboxes[1]?.checked).toBe(true);
  });
});
