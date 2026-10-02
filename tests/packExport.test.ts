import { afterEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import type { LoopDeckPack } from '../src/core/models';
import { collectPackExportAssets } from '../src/services/packExport';
import { createLoopDeckZipBytes } from '../src/packs/zipExporter';
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6TMsAAAAASUVORK5CYII=';
function pack(packId: string): LoopDeckPack {
  return { packVersion: 1, packId, title: 'Images', folders: [{ id: 'f', title: 'Folder' }], modules: [{ id: 'm', title: 'Module', folderId: 'f', subject: 'Test', questionIds: ['q1','q2'] }], questions: ['q1','q2'].map(id => ({ id, moduleId: 'm', type: 'input', prompt: 'Q', answer: 'A', imageAsset: 'assets/shared.png' })) };
}
afterEach(() => vi.unstubAllGlobals());
describe('pack export resource ownership', () => {
  it.each([png, png.replace('data:image/png;base64', 'DATA:IMAGE/PNG;BASE64')])('includes embedded built-in images once and preserves their exact bytes %#', async (dataUrl) => {
    vi.stubGlobal('__LOOPDECK_EMBEDDED_ASSETS__', { 'assets/shared.png': dataUrl });
    const data = pack('loopdeck-builtin-v1');
    const assets = await collectPackExportAssets(data, { getImportedPackAssets: async () => [] });
    expect(assets).toEqual([{ packId: data.packId, path: 'assets/shared.png', dataUrl, mimeType: 'image/png' }]);
    const zip = await JSZip.loadAsync(await createLoopDeckZipBytes(data, assets));
    expect(await zip.file('assets/shared.png')!.async('base64')).toBe(png.split(',')[1]);
  });
  it('uses only the exported pack owner when other packs share a path or question IDs', async () => {
    const data = pack('exported');
    const assets = await collectPackExportAssets(data, { getImportedPackAssets: async () => [
      { assetId: 'other:assets/shared.png', packId: 'other', path: 'assets/shared.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,b3RoZXI=' },
      { assetId: 'exported:assets/shared.png', packId: 'exported', path: 'assets/shared.png', mimeType: 'image/png', dataUrl: png }
    ] });
    expect(assets).toEqual([{ packId: 'exported', path: 'assets/shared.png', dataUrl: png, mimeType: 'image/png' }]);
  });
});
