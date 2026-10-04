import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import type { LoopDeckPack, VisualReference } from '../src/core/models';
import { parseVisualReferences } from '../src/core/visualReferences';
import { validatePack } from '../src/packs/packValidator';
import { importLoopDeckJson, importLoopDeckZip } from '../src/packs/zipImporter';
import { createLoopDeckZipBytes, stringifyLoopDeckJson } from '../src/packs/zipExporter';
import { loadBuiltinPacks } from '../src/packs/builtinLoader';
import { LocalDatabase } from '../src/storage/indexedDb';
import { StudyRepository } from '../src/storage/studyRepository';
import { canAutoReverseQuestion } from '../src/core/questionPresentation';
import { isJapaneseToEnglishWorksheetQuestion } from '../src/pdf/worksheetPlanner';

const references: VisualReference[] = [
  { type: 'color', color: '#EDB0AA', label: '面塗り' },
  { type: 'stripe', color: '#EF8A84', backgroundColor: '#FFFFFF', label: '縦線', angle: 90, spacing: 11, lineWidth: 4 },
  { type: 'grid', color: '#123456', label: '格子', angle: 0, spacing: 16, lineWidth: 3 },
  { type: 'crosshatch', color: '#ABCDEF', label: '交差線', angle: 45, spacing: 12, lineWidth: 2 },
  { type: 'dots', color: '#2563EB', label: '水玉', shape: 'circle', spacing: 8, lineWidth: 4 },
  { type: 'checker', color: '#000000', backgroundColor: '#FFFFFF', label: '市松', spacing: 10 }
];
const pack: LoopDeckPack = {
  packVersion: 1,
  packId: 'visual-test',
  title: '参考模様',
  folders: [],
  modules: [{ id: 'm', folderId: '', title: '色と模様', subject: '図', questionIds: ['q'] }],
  questions: [{ id: 'q', moduleId: 'm', type: 'input', prompt: '参考模様を確認', answer: '確認', visualReferences: references }]
};

describe('question visual references', () => {
  it.each(['input', 'choice', 'multi_select'])('validates references on %s questions', (type) => {
    const question = { ...pack.questions[0], type, choices: ['確認', '別'], correctChoices: ['確認'] };
    const result = validatePack({ ...pack, questions: [question] });
    expect(result.ok).toBe(true);
    expect(result.pack?.questions[0].visualReferences).toEqual(references);
  });

  it.each([
    { type: 'html' },
    { type: 'svg' },
    { color: 'red' },
    { color: '#123' },
    { color: '#EDB0AA; background: url(https://example.com)' },
    { backgroundColor: 'url(x)' },
    { style: 'position:fixed' },
    { url: 'https://example.com' },
    { svg: '<svg/>' },
    { label: '' },
    { label: 1 },
    { shape: 'star' },
    { spacing: '12' },
    { spacing: 3 },
    { spacing: 65 },
    { spacing: Infinity },
    { lineWidth: 0 },
    { lineWidth: 33 },
    { lineWidth: NaN },
    { spacing: 4, lineWidth: 4 },
    { angle: -1 },
    { angle: 181 },
    { angle: '45deg' }
  ])('rejects unsafe or invalid parameters %j', (overrides) => {
    const result = validatePack({ ...pack, questions: [{ ...pack.questions[0], visualReferences: [{ ...references[1], ...overrides }] }] });
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.message.includes('questions[0].visualReferences[0]'))).toBe(true);
  });

  it('rejects parameters for incompatible primitives and malformed arrays', () => {
    for (const value of [
      null,
      {},
      [null],
      Array(17).fill(references[0]),
      [{ ...references[0], angle: 90 }],
      [{ ...references[4], angle: 90 }],
      [{ ...references[5], lineWidth: 2 }]
    ]) {
      expect(parseVisualReferences(value).errors.length).toBeGreaterThan(0);
    }
    expect(parseVisualReferences(undefined)).toEqual({ errors: [] });
    expect(parseVisualReferences([])).toEqual({ references: [], errors: [] });
    expect(parseVisualReferences(Array(16).fill(references[0])).errors).toEqual([]);
  });

  it('round-trips through the actual JSON and ZIP import/export paths', async () => {
    const json = await importLoopDeckJson(new File([stringifyLoopDeckJson(pack)], 'visual.loopdeck.json'));
    expect(json.ok).toBe(true);
    expect(json.pack?.questions[0].visualReferences).toEqual(references);
    const bytes = await createLoopDeckZipBytes(json.pack!);
    const zip = await importLoopDeckZip(new File([Uint8Array.from(bytes).buffer], 'visual.loopdeck.zip'));
    expect(zip.ok).toBe(true);
    expect(zip.pack?.questions[0].visualReferences).toEqual(references);
  });

  it('preserves references through persisted packs and backup restore', async () => {
    const database = new LocalDatabase(`visual-backup-${crypto.randomUUID()}`);
    const store = new StudyRepository(database);
    try {
      await store.saveImportedPack(pack);
      const backup = JSON.parse(JSON.stringify(await store.exportSnapshot()));
      await store.deleteImportedPack(pack.packId);
      await store.restoreSnapshot(backup, 'replace');
      expect((await store.getImportedPacks())[0].questions[0].visualReferences).toEqual(references);
    } finally {
      database.close();
    }
  });

  it('does not auto-reverse or print visual-cue questions as text-only vocabulary', () => {
    const vocabulary = { ...pack.questions[0], prompt: 'red', answer: '赤い', visualReferences: undefined };
    expect(canAutoReverseQuestion(vocabulary)).toBe(true);
    expect(isJapaneseToEnglishWorksheetQuestion(vocabulary)).toBe(true);
    const visual = { ...vocabulary, visualReferences: references };
    expect(canAutoReverseQuestion(visual)).toBe(false);
    expect(isJapaneseToEnglishWorksheetQuestion(visual)).toBe(false);
  });

  it('restores both StudyHome legend references on the migrated history questions without revealing country names', () => {
    const history = loadBuiltinPacks()[0].questions;
    for (const id of ['history-62-E10', 'history-62-E11']) {
      const question = history.find((item) => item.id === id)!;
      expect(question.visualReferences).toEqual([
        { type: 'color', color: '#edb0aa', label: '上の塗りつぶし：うすい赤の面塗り' },
        {
          type: 'stripe',
          color: '#ef8a84',
          backgroundColor: '#FFFFFF',
          angle: 90,
          spacing: 11,
          lineWidth: 4,
          label: '下の縦線：赤い縦線模様'
        }
      ]);
      expect(JSON.stringify(question.visualReferences)).not.toMatch(/ドイツ|ポルトガル/);
    }
  });
});
