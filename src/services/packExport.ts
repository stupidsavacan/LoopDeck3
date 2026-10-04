import type { LoopDeckPack } from '../core/models';
import { createQuestionImageAssetResolver } from '../packs/packAssetResolver';
import { resolveActivePacks } from '../packs/packResolver';
import type { ImportedPackAsset } from '../packs/packTypes';
import type { StudyRepository } from '../storage/studyRepository';
import { packAssetId } from '../packs/packAssetIdentity';
import { extensionOf, isSafeImageAssetRef, isSafeImageDataUrl } from '../packs/assetSafety';
import { MAX_IMAGE_ASSET_BYTES } from '../packs/importLimits';

/** Resolve the exported pack itself, including inactive packs and embedded images. */
export async function collectPackExportAssets(
  pack: LoopDeckPack,
  store: Pick<StudyRepository, 'getImportedPackAssets'>
): Promise<ImportedPackAsset[]> {
  const stored = new Map((await store.getImportedPackAssets()).map((asset) => [packAssetId(asset.packId, asset.path), asset]));
  const resolve = createQuestionImageAssetResolver(resolveActivePacks([pack]), {
    getPackAsset: async (packId, path) => stored.get(packAssetId(packId, path))
  });
  const references = new Map(
    pack.questions.filter((question) => question.imageAsset).map((question) => [question.imageAsset as string, question])
  );
  const assets: ImportedPackAsset[] = [];
  for (const [path, question] of references) {
    if (!isSafeImageAssetRef(path)) throw new Error(`Unsafe image reference: ${path}`);
    const persisted = stored.get(packAssetId(pack.packId, path));
    let dataUrl = persisted ? persisted.dataUrl : await resolve(question);
    const expectedMime = extensionOf(path) === '.png' ? 'image/png' : extensionOf(path) === '.webp' ? 'image/webp' : 'image/jpeg';
    if (dataUrl && !/^data:/i.test(dataUrl)) {
      const response = await fetch(dataUrl);
      if (!response.ok) throw new Error(`Image could not be exported: ${path}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length > MAX_IMAGE_ASSET_BYTES) throw new Error(`Image is too large: ${path}`);
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
      dataUrl = `data:${expectedMime};base64,${btoa(binary)}`;
    }
    const mimeType = dataUrl?.match(/^data:(image\/(?:png|jpeg|webp));base64,/i)?.[1]?.toLowerCase();
    if (
      !dataUrl ||
      !isSafeImageDataUrl(dataUrl) ||
      mimeType !== expectedMime ||
      (persisted && persisted.mimeType.toLowerCase() !== expectedMime)
    )
      throw new Error(`画像ファイルがないか破損しています。ZIPを書き出せません: ${path}`);
    assets.push({ packId: pack.packId, path, dataUrl, mimeType });
  }
  return assets;
}
