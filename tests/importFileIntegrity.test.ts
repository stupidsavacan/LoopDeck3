import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import type { LoopDeckPack } from '../src/core/models';
import { createLoopDeckZipBytes } from '../src/packs/zipExporter';
import { importLoopDeckJson, importLoopDeckZip } from '../src/packs/zipImporter';
import { readImportFile } from '../src/services/importFileService';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const pack: LoopDeckPack = {
  packVersion: 1,
  packId: 'integrity',
  title: 'Integrity',
  folders: [],
  modules: [{ id: 'm', folderId: '', title: 'Module', subject: 'test', questionIds: ['q'] }],
  questions: [{ id: 'q', moduleId: 'm', type: 'input', prompt: 'Q', answer: 'A', imageAsset: 'images/pixel.png' }]
};
async function validZip() {
  return createLoopDeckZipBytes(pack, [
    { packId: pack.packId, path: 'images/pixel.png', mimeType: 'image/png', dataUrl: `data:image/png;base64,${png}` }
  ]);
}
describe('import file integrity', () => {
  it('routes mixed-case ZIP extensions and rejects unsupported filenames', async () => {
    expect(await readImportFile(new File([Uint8Array.from(await validZip()).buffer], 'PACK.LoOpDeCk.ZIP'))).toMatchObject({
      kind: 'pack',
      result: { ok: true }
    });
    expect(await readImportFile(new File([JSON.stringify(pack)], 'pack.txt'))).toMatchObject({ kind: 'pack', result: { ok: false } });
  });
  it('returns structured validation errors for malformed containers and JSON entries', async () => {
    expect(await importLoopDeckJson(new File(['{'], 'broken.json'))).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ level: 'error' })]
    });
    expect(await importLoopDeckZip(new File(['not zip'], 'broken.zip'))).toMatchObject({ ok: false });
    const zip = new JSZip();
    zip.file('manifest.json', '{');
    expect(await importLoopDeckZip(new File([await zip.generateAsync({ type: 'arraybuffer' })], 'broken.zip'))).toMatchObject({
      ok: false
    });
  });
  it.each(['', 'not an image'])('rejects invalid referenced asset bytes before returning a pack (%s)', async (payload) => {
    const zip = await JSZip.loadAsync(await validZip());
    zip.file('images/pixel.png', payload);
    const result = await importLoopDeckZip(new File([await zip.generateAsync({ type: 'arraybuffer' })], 'pack.zip'));
    expect(result).toMatchObject({ ok: false });
    expect(result.issues.some((issue) => issue.level === 'error' && issue.path === 'images/pixel.png')).toBe(true);
  });
});
