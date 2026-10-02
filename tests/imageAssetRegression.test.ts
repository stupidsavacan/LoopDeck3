import 'fake-indexeddb/auto';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import type { LoopDeckPack } from '../src/core/models';
import { createQuestionImageAssetResolver } from '../src/packs/packAssetResolver';
import { mergeLoopDeckPacksIntoExisting } from '../src/packs/packMerger';
import { resolveActivePacks } from '../src/packs/packResolver';
import type { ImportedPackAsset } from '../src/packs/packTypes';
import { createLoopDeckZipBlob } from '../src/packs/zipExporter';
import { importLoopDeckZip } from '../src/packs/zipImporter';
import { studyStore } from '../src/storage/studyRepository';

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function pack(packId: string, questionId: string, imageAsset?: string): LoopDeckPack {
  return {
    packVersion: 1,
    packId,
    title: packId,
    folders: [{ id: 'f', title: 'Folder' }],
    modules: [{ id: 'shared-module', folderId: 'f', title: 'Module', subject: 'demo', questionIds: [questionId] }],
    questions: [{ id: questionId, moduleId: 'shared-module', type: 'input', prompt: `${questionId}?`, answer: questionId, imageAsset }]
  };
}

function asset(packId: string, path: string, base64 = PNG_BASE64): ImportedPackAsset {
  return { packId, path, mimeType: 'image/png', dataUrl: `data:image/png;base64,${base64}` };
}

async function zipFile(value: LoopDeckPack, images: Record<string, string>): Promise<File> {
  const zip = new JSZip();
  zip.file(
    'manifest.json',
    JSON.stringify({
      packVersion: value.packVersion,
      packId: value.packId,
      title: value.title,
      folders: value.folders
    })
  );
  zip.file('modules.json', JSON.stringify(value.modules));
  zip.file('questions.json', JSON.stringify(value.questions));
  for (const [path, base64] of Object.entries(images)) zip.file(path, base64, { base64: true });
  return new File([await zip.generateAsync({ type: 'arraybuffer' })], `${value.packId}.loopdeck.zip`, { type: 'application/zip' });
}

describe('real image asset regression flows', () => {
  it('imports, persists, resolves, exports, and re-imports the same image bytes', async () => {
    const value = pack('audit-image-round-trip', 'q-round-trip', 'images/pixel.png');
    await studyStore.deleteImportedPack(value.packId);

    const imported = await importLoopDeckZip(await zipFile(value, { 'images/pixel.png': PNG_BASE64 }));
    expect(imported.ok).toBe(true);
    await studyStore.saveImportedPackWithAssets(imported.pack!, imported.assets ?? [], 'replace');

    const storedPack = (await studyStore.getImportedPacks()).find((item) => item.packId === value.packId)!;
    const view = resolveActivePacks([storedPack]);
    const resolver = createQuestionImageAssetResolver(view, studyStore);
    expect(await resolver(view.questionById.get('q-round-trip')!)).toBe(`data:image/png;base64,${PNG_BASE64}`);

    const exported = await createLoopDeckZipBlob(storedPack, await studyStore.getImportedPackAssets());
    const exportedZip = await JSZip.loadAsync(await exported.arrayBuffer());
    expect(await exportedZip.file('images/pixel.png')!.async('base64')).toBe(PNG_BASE64);

    const reimported = await importLoopDeckZip(
      new File([await exported.arrayBuffer()], 'round-trip.loopdeck.zip', { type: 'application/zip' })
    );
    expect(reimported.assets?.[0]?.dataUrl).toBe(`data:image/png;base64,${PNG_BASE64}`);
    await studyStore.deleteImportedPack(value.packId);
  });

  it('retargets incoming ZIP assets when merging a different packId into an existing module', async () => {
    const target = pack('audit-module-merge-target', 'q-existing', 'images/existing.png');
    const addon = pack('audit-module-merge-addon', 'q-addon', 'images/addon.png');
    await studyStore.deleteImportedPack(target.packId);
    await studyStore.saveImportedPackWithAssets(target, [asset(target.packId, 'images/existing.png')], 'replace');

    const imported = await importLoopDeckZip(await zipFile(addon, { 'images/addon.png': PNG_BASE64 }));
    const merged = mergeLoopDeckPacksIntoExisting(target, imported.pack!).pack;
    await studyStore.saveImportedPackWithAssets(merged, imported.assets ?? [], 'upsert');

    expect(await studyStore.getPackAsset(target.packId, 'images/existing.png')).toBeDefined();
    expect((await studyStore.getPackAsset(target.packId, 'images/addon.png'))?.dataUrl).toBe(`data:image/png;base64,${PNG_BASE64}`);
    const resolver = createQuestionImageAssetResolver(resolveActivePacks([merged]), studyStore);
    expect(await resolver(merged.questions.find((question) => question.id === 'q-addon')!)).toBe(`data:image/png;base64,${PNG_BASE64}`);
    await studyStore.deleteImportedPack(target.packId);
  });

  it('preserves image assets through user-data backup export and import', async () => {
    const value = pack('audit-image-backup', 'q-backup', 'images/backup.png');
    await studyStore.deleteImportedPack(value.packId);
    await studyStore.saveImportedPackWithAssets(value, [asset(value.packId, 'images/backup.png')], 'replace');

    const backup = await studyStore.exportSnapshot();
    await studyStore.deleteImportedPack(value.packId);
    expect(await studyStore.getPackAsset(value.packId, 'images/backup.png')).toBeUndefined();

    await studyStore.restoreSnapshot(backup, 'replace');
    expect((await studyStore.getPackAsset(value.packId, 'images/backup.png'))?.dataUrl).toBe(`data:image/png;base64,${PNG_BASE64}`);
    await studyStore.deleteImportedPack(value.packId);
  });
});
