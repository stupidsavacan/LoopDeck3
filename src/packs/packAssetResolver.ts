import type { Question } from '../core/models';
import type { StoredPackAsset } from '../storage/storageTypes';
import { isSafeImageAssetRef, isSafeImageDataUrl } from './assetSafety';
import { getQuestionsForModule, type ResolvedPackView } from './packResolver';

export interface PackAssetReader {
  getPackAsset(packId: string, path: string): Promise<StoredPackAsset | undefined>;
}

export type QuestionImageAssetResolver = (question: Question) => Promise<string | undefined>;

const BUILTIN_PACK_ID = 'loopdeck-builtin-v1';
type EmbeddedAssetGlobal = typeof globalThis & {
  __LOOPDECK_EMBEDDED_ASSETS__?: Record<string, string>;
};

function resolveEmbeddedAsset(path: string): string | undefined {
  const value = (globalThis as EmbeddedAssetGlobal).__LOOPDECK_EMBEDDED_ASSETS__?.[path];
  return value && isSafeImageDataUrl(value) ? value : undefined;
}

export function createQuestionImageAssetResolver(packView: ResolvedPackView, assetReader: PackAssetReader): QuestionImageAssetResolver {
  return async (question) => {
    const path = question.imageAsset;
    if (!path || !isSafeImageAssetRef(path)) return undefined;

    const packId = getQuestionsForModule(packView, question.moduleId).some((item) => item.id === question.id)
      ? packView.modulePackIdById.get(question.moduleId)
      : undefined;
    if (!packId) return undefined;

    // Imported/overridden pack assets remain authoritative when present.
    const stored = await assetReader.getPackAsset(packId, path);
    if (stored?.dataUrl && isSafeImageDataUrl(stored.dataUrl)) return stored.dataUrl;

    if (packId !== BUILTIN_PACK_ID) return undefined;

    // Single-HTML builds expose each built-in image once through a shared map.
    // Normal web/Android builds keep the validated relative path and let the
    // browser/WebView load the file from the bundled images directory.
    return resolveEmbeddedAsset(path) ?? path;
  };
}
