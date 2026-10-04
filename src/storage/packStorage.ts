import { clearBrowserStudyState } from './browserStudyState';
import { validatePack, validateActivePackIdentities } from '../packs/packValidator';
import { loadBuiltinPacks } from '../packs/builtinLoader';
import type { LoopDeckPack } from '../core/models';
import type { ImportedPackAsset, PackAssetWriteStrategy } from '../packs/packTypes';
import type { StoredPackAsset } from './storageTypes';
import type { LocalDatabase } from './indexedDb';
import { packAssetId } from '../packs/packAssetIdentity';
import { isSafeImageAssetRef } from '../packs/assetSafety';
import { PACK_LIFECYCLE_STORES, reconcilePackLearningState, retireQuestionLearningState } from './packLearningState';

export { packAssetId } from '../packs/packAssetIdentity';

function storedAsset(packId: string, asset: ImportedPackAsset): StoredPackAsset {
  return { assetId: packAssetId(packId, asset.path), packId, path: asset.path, mimeType: asset.mimeType, dataUrl: asset.dataUrl };
}

export function installedOrder(row: unknown): number {
  if (typeof row !== 'object' || row === null) return 0;
  const value = (row as { installedOrder?: unknown }).installedOrder;
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

export function installedRevision(row: unknown): string {
  if (typeof row !== 'object' || row === null) return 'builtin';
  const revision = (row as { contentRevision?: unknown }).contentRevision;
  return typeof revision === 'string' ? revision : `legacy:${installedOrder(row)}`;
}

/** Allocate priority inside the same write transaction, including concurrent tabs. */
export function putPacksInInstallOrder(store: IDBObjectStore, packs: LoopDeckPack[], reconcileLearning = false): void {
  const request = store.getAll();
  request.onsuccess = () => {
    try {
      const previous = recoverStoredPacks([...request.result].sort((left, right) => installedOrder(left) - installedOrder(right)));
      const identityErrors = validateActivePackIdentities([...loadBuiltinPacks(), ...previous, ...packs]).filter(
        (issue) => issue.level === 'error'
      );
      if (identityErrors.length) throw new Error(identityErrors.map((issue) => issue.message).join(' / '));
      if (reconcileLearning) {
        const incomingIds = new Set(packs.map((pack) => pack.packId));
        reconcilePackLearningState(store.transaction, previous, [...previous.filter((pack) => !incomingIds.has(pack.packId)), ...packs]);
      }
      let order = request.result.reduce((max: number, row: unknown) => Math.max(max, installedOrder(row)), 0);
      for (const pack of packs)
        store.put({
          ...pack,
          installedOrder: ++order,
          contentRevision: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}:${Math.random()}`
        });
    } catch {
      store.transaction.abort();
    }
  };
}

export async function savePackWithAssets(
  database: LocalDatabase,
  pack: LoopDeckPack,
  assets: ImportedPackAsset[],
  strategy: PackAssetWriteStrategy
): Promise<void> {
  await database.transact(PACK_LIFECYCLE_STORES, 'readwrite', (tx) => {
    putPacksInInstallOrder(tx.objectStore('packs'), [pack], true);
    const assetStore = tx.objectStore('packAssets');
    const referencedPaths = new Set(pack.questions.map((question) => question.imageAsset).filter((path): path is string => Boolean(path)));
    const writeAssets = () => {
      for (const asset of assets) if (referencedPaths.has(asset.path)) assetStore.put(storedAsset(pack.packId, asset));
    };

    if (strategy === 'upsert') {
      const stale = assetStore.index('byPackId').openCursor(IDBKeyRange.only(pack.packId));
      stale.onsuccess = () => {
        const cursor = stale.result;
        if (!cursor) return;
        if (!referencedPaths.has(cursor.value.path)) cursor.delete();
        cursor.continue();
      };
      for (const asset of assets) {
        if (!referencedPaths.has(asset.path)) continue;
        const stored = storedAsset(pack.packId, asset);
        const request = assetStore.get(stored.assetId);
        request.onsuccess = () => {
          try {
            if (request.result && request.result.dataUrl !== stored.dataUrl) {
              console.warn('Image path collision rejected during pack merge.', asset.path);
              tx.abort();
              return;
            }
            assetStore.put(stored);
          } catch {
            tx.abort();
          }
        };
      }
      return;
    }

    const incomingAssets = new Map(assets.map((asset) => [asset.path, asset.dataUrl]));
    const unchangedPaths = new Set<string>();
    const request = assetStore.index('byPackId').openCursor(IDBKeyRange.only(pack.packId));
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) {
        if (incomingAssets.get(cursor.value.path) === cursor.value.dataUrl) unchangedPaths.add(cursor.value.path);
        assetStore.delete(cursor.primaryKey);
        cursor.continue();
        return;
      }
      const changedImageQuestionIds = new Set(
        pack.questions
          .filter((question) => question.imageAsset && isSafeImageAssetRef(question.imageAsset) && !unchangedPaths.has(question.imageAsset))
          .map((question) => question.id)
      );
      retireQuestionLearningState(tx, changedImageQuestionIds);
      writeAssets();
    };
  });
  clearBrowserStudyState(pack.packId);
}

export async function deletePackAndAssets(database: LocalDatabase, packId: string): Promise<void> {
  await database.transact(PACK_LIFECYCLE_STORES, 'readwrite', (tx) => {
    const packStore = tx.objectStore('packs');
    const current = packStore.getAll();
    current.onsuccess = () => {
      const previous = recoverStoredPacks([...current.result].sort((left, right) => installedOrder(left) - installedOrder(right)));
      reconcilePackLearningState(
        tx,
        previous,
        previous.filter((pack) => pack.packId !== packId)
      );
      packStore.delete(packId);
    };
    const assetStore = tx.objectStore('packAssets');
    const request = assetStore.index('byPackId').openKeyCursor(IDBKeyRange.only(packId));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      assetStore.delete(cursor.primaryKey);
      cursor.continue();
    };
  });
  clearBrowserStudyState(packId);
}

export function validatedPackForStorage(pack: unknown): LoopDeckPack {
  const result = validatePack(pack);
  if (result.ok && result.pack) return result.pack;
  const detail = result.issues
    .filter((issue) => issue.level === 'error')
    .map((issue) => issue.message)
    .join(' ');
  throw new Error(`Imported pack failed validation before persistence.${detail ? ` ${detail}` : ''}`);
}

export function recoverStoredPacks(packs: unknown[]): LoopDeckPack[] {
  const recovered: LoopDeckPack[] = [];
  for (const stored of packs) {
    const result = validatePack(stored);
    if (result.ok && result.pack) {
      recovered.push(result.pack);
      continue;
    }
    console.warn('Ignoring an invalid stored LoopDeck pack during startup recovery.', result.issues);
  }
  return recovered;
}
