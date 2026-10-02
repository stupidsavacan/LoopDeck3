import type { LoopDeckPack } from '../core/models';
import { createQuestionImageAssetResolver } from '../packs/packAssetResolver';
import { resolveActivePacks } from '../packs/packResolver';
import type { ImportedPackAsset } from '../packs/packTypes';
import type { StudyRepository } from '../storage/studyRepository';

/** Resolve the exported pack itself, including inactive packs and embedded images. */
export async function collectPackExportAssets(pack: LoopDeckPack, store: Pick<StudyRepository, 'getImportedPackAssets'>): Promise<ImportedPackAsset[]> {
  const stored = new Map((await store.getImportedPackAssets()).map(asset => [asset.assetId, asset]));
  const resolve = createQuestionImageAssetResolver(resolveActivePacks([pack]), {
    getPackAsset: async (packId, path) => stored.get(`${packId}:${path}`)
  });
  const references = new Map(pack.questions.filter(question => question.imageAsset).map(question => [question.imageAsset as string, question]));
  const assets: ImportedPackAsset[] = [];
  for (const [path, question] of references) {
    const dataUrl = await resolve(question);
    const mimeType = dataUrl?.match(/^data:(image\/(?:png|jpeg|webp));base64,/i)?.[1]?.toLowerCase();
    if (dataUrl && mimeType) assets.push({ packId: pack.packId, path, dataUrl, mimeType });
  }
  return assets;
}
