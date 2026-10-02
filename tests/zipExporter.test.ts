import 'fake-indexeddb/auto';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import type { LoopDeckPack } from '../src/core/models';
import type { ImportedPackAsset } from '../src/packs/packTypes';
import { createLoopDeckZipBlob, createLoopDeckZipBytes, makePackFileStem, stringifyLoopDeckJson } from '../src/packs/zipExporter';
import { studyStore } from '../src/storage/studyRepository';

const samplePack: LoopDeckPack = {
  packVersion: 1,
  packId: 'sample-pack',
  title: 'Sample Pack',
  folders: [{ id: 'folder-1', title: 'Folder 1' }],
  modules: [
    {
      id: 'module-1',
      folderId: 'folder-1',
      title: 'Module 1',
      subject: 'sample',
      questionIds: ['question-1']
    }
  ],
  questions: [
    {
      id: 'question-1',
      moduleId: 'module-1',
      type: 'input',
      prompt: 'What is exported?',
      answer: 'A LoopDeck pack'
    }
  ]
};

function asset(path: string, dataUrl = 'data:image/png;base64,iVBORw0KGgo=', packId = samplePack.packId): ImportedPackAsset {
  return { packId, path, mimeType: 'image/png', dataUrl };
}

function withImage(pack: LoopDeckPack = samplePack): LoopDeckPack {
  return { ...pack, questions: [{ ...pack.questions[0], imageAsset: 'images/map.png' }] };
}

describe('zipExporter', () => {
  it('creates import-compatible LoopDeck zip files', async () => {
    const bytes = await createLoopDeckZipBytes(samplePack);
    const zip = await JSZip.loadAsync(bytes);

    expect(Object.keys(zip.files).sort()).toEqual(['manifest.json', 'modules.json', 'questions.json']);

    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
    const modules = JSON.parse(await zip.file('modules.json')!.async('string'));
    const questions = JSON.parse(await zip.file('questions.json')!.async('string'));

    expect(manifest).toEqual({
      packVersion: 1,
      packId: 'sample-pack',
      title: 'Sample Pack',
      folders: [{ id: 'folder-1', title: 'Folder 1' }]
    });
    expect(modules).toEqual(samplePack.modules);
    expect(questions).toEqual(samplePack.questions);
  });

  it('exports module color metadata in modules.json', async () => {
    const coloredPack: LoopDeckPack = {
      ...samplePack,
      modules: [{ ...samplePack.modules[0], color: '#15803D', accentColor: '#DCFCE7' }]
    };
    const bytes = await createLoopDeckZipBytes(coloredPack);
    const zip = await JSZip.loadAsync(bytes);
    const modules = JSON.parse(await zip.file('modules.json')!.async('string'));

    expect(modules[0].color).toBe('#15803D');
    expect(modules[0].accentColor).toBe('#DCFCE7');
  });

  it('includes safe stored assets referenced by questions', async () => {
    const imagePack = withImage();
    const bytes = await createLoopDeckZipBytes(imagePack, [asset('images/map.png'), asset('images/unreferenced.png')]);
    const zip = await JSZip.loadAsync(bytes);

    expect(zip.file('images/map.png')).not.toBeNull();
    expect(await zip.file('images/map.png')!.async('base64')).toBe('iVBORw0KGgo=');
    expect(zip.file('images/unreferenced.png')).toBeNull();
  });

  it('includes persisted assets in the ZIP export used by the UI', async () => {
    const storedPack = withImage({ ...samplePack, packId: 'stored-export-pack' });
    await studyStore.deleteImportedPack(storedPack.packId);
    await studyStore.saveImportedPackWithAssets(
      storedPack,
      [asset('images/map.png', 'data:image/png;base64,c3RvcmVk', storedPack.packId)],
      'replace'
    );

    const blob = await createLoopDeckZipBlob(storedPack);
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());

    expect(await zip.file('images/map.png')!.async('base64')).toBe('c3RvcmVk');
    await studyStore.deleteImportedPack(storedPack.packId);
  });

  it('does not export unsafe or active asset references', async () => {
    const unsafePack: LoopDeckPack = {
      ...samplePack,
      questions: [{ ...samplePack.questions[0], imageAsset: '../evil.png' }]
    };
    const bytes = await createLoopDeckZipBytes(unsafePack, [asset('../evil.png')]);
    const zip = await JSZip.loadAsync(bytes);

    expect(Object.keys(zip.files).sort()).toEqual(['manifest.json', 'modules.json', 'questions.json']);
  });

  it('exports full pack JSON with a trailing newline', () => {
    expect(stringifyLoopDeckJson(samplePack)).toBe(`${JSON.stringify(samplePack, null, 2)}\n`);
  });

  it('creates safe download file stems', () => {
    expect(makePackFileStem({ ...samplePack, packId: 'bad/name:*' })).toBe('bad-name');
    expect(makePackFileStem({ ...samplePack, packId: '' })).toBe('Sample-Pack');
  });
});
