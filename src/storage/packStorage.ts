import { validatePack } from '../packs/packValidator';
import type { LoopDeckPack } from '../core/models';
import type { ImportedPackAsset, PackAssetWriteStrategy } from '../packs/packTypes';
import type { StoredPackAsset } from './storageTypes';
import type { LocalDatabase } from './indexedDb';

export function packAssetId(packId: string, path: string): string {
  return `${packId}:${path}`;
}

function storedAsset(packId: string, asset: ImportedPackAsset): StoredPackAsset {
  return { assetId: packAssetId(packId, asset.path), packId, path: asset.path, mimeType: asset.mimeType, dataUrl: asset.dataUrl };
}

export function installedOrder(row: unknown): number {
  if (typeof row !== 'object' || row === null) return 0;
  const value = (row as { installedOrder?: unknown }).installedOrder;
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

/** Allocate priority inside the same write transaction, including concurrent tabs. */
export function putPacksInInstallOrder(store: IDBObjectStore, packs: LoopDeckPack[]): void {
  const request = store.getAll();
  request.onsuccess = () => {
    try {
      let order = request.result.reduce((max: number, row: unknown) => Math.max(max, installedOrder(row)), 0);
      for (const pack of packs) store.put({ ...pack, installedOrder: ++order });
    } catch {
      store.transaction.abort();
    }
  };
}

export async function savePackWithAssets(database: LocalDatabase, pack: LoopDeckPack, assets: ImportedPackAsset[], strategy: PackAssetWriteStrategy): Promise<void> {
  await database.transact(['packs', 'packAssets'], 'readwrite', (tx) => {
    putPacksInInstallOrder(tx.objectStore('packs'), [pack]);
    const assetStore = tx.objectStore('packAssets');
    const writeAssets = () => {
      for (const asset of assets) assetStore.put(storedAsset(pack.packId, asset));
    };

    if (strategy === 'upsert') {
      writeAssets();
      return;
    }

    const request = assetStore.index('byPackId').openKeyCursor(IDBKeyRange.only(pack.packId));
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) {
        assetStore.delete(cursor.primaryKey);
        cursor.continue();
        return;
      }
      writeAssets();
    };
  });
}

export async function deletePackAndAssets(database: LocalDatabase, packId: string): Promise<void> {
  await database.transact(['packs', 'packAssets'], 'readwrite', (tx) => {
    tx.objectStore('packs').delete(packId);
    const assetStore = tx.objectStore('packAssets');
    const request = assetStore.index('byPackId').openKeyCursor(IDBKeyRange.only(packId));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      assetStore.delete(cursor.primaryKey);
      cursor.continue();
    };
  });
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
