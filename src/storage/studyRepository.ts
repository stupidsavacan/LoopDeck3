import type { Attempt, LoopDeckPack, ReviewCard, ReviewLog } from '../core/models';
import type { ImportedPackAsset, PackAssetWriteStrategy } from '../packs/packTypes';

import { database, USER_DATA_STORES } from './indexedDb';
import { installedOrder, putPacksInInstallOrder, savePackWithAssets, deletePackAndAssets, validatedPackForStorage, recoverStoredPacks, packAssetId } from './packStorage';
import { importBackup } from './backupStorage';
import type { BackupImportMode } from './storageTypes';

import type { StudyBackup, StoredPackAsset } from './storageTypes';

async function deleteAttemptsByResult(results: Attempt['result'][]): Promise<void> {
  await database.transact('attempts', 'readwrite', (tx) => {
    const store = tx.objectStore('attempts');
    const index = store.index('byResult');
    for (const result of results) {
      const request = index.openKeyCursor(IDBKeyRange.only(result));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        store.delete(cursor.primaryKey);
        cursor.continue();
      };
    }
  });
}

export class StudyRepository {
  async addAttempt(attempt: Attempt): Promise<void> {
    await database.request('attempts', 'readwrite', (store) => store.put(attempt));
  }
  async saveAttemptWithReview(attempt: Attempt, card: ReviewCard, log: ReviewLog): Promise<void> {
    await database.transact(['attempts', 'reviewCards', 'reviewLogs'], 'readwrite', (tx) => {
      tx.objectStore('attempts').put(attempt);
      tx.objectStore('reviewCards').put(card);
      tx.objectStore('reviewLogs').put(log);
    });
  }
  async getAttempts(): Promise<Attempt[]> {
    return database.all<Attempt>('attempts');
  }
  async clearAttempts(): Promise<void> {
    await database.request('attempts', 'readwrite', (store) => store.clear());
  }
  async clearWrongAttempts(): Promise<void> {
    await deleteAttemptsByResult(['wrong', 'revealed']);
  }
  async setBookmark(questionId: string, enabled: boolean): Promise<void> {
    if (enabled) await database.request('bookmarks', 'readwrite', (store) => store.put({ questionId, createdAt: new Date().toISOString() }));
    else await database.request('bookmarks', 'readwrite', (store) => store.delete(questionId));
  }
  async getBookmarks(): Promise<string[]> {
    return (await database.all<{ questionId: string }>('bookmarks')).map((row) => row.questionId);
  }
  async hasBookmark(questionId: string): Promise<boolean> {
    return Boolean(await database.request<{ questionId: string }>('bookmarks', 'readonly', (store) => store.get(questionId)));
  }
  async clearBookmarks(): Promise<void> {
    await database.request('bookmarks', 'readwrite', (store) => store.clear());
  }
  async saveImportedPack(pack: LoopDeckPack): Promise<void> {
    const normalized = validatedPackForStorage(pack);
    await database.transact('packs', 'readwrite', (tx) => putPacksInInstallOrder(tx.objectStore('packs'), [normalized]));
  }
  async saveImportedPackWithAssets(pack: LoopDeckPack, assets: ImportedPackAsset[], strategy: PackAssetWriteStrategy): Promise<void> {
    await savePackWithAssets(validatedPackForStorage(pack), assets, strategy);
  }
  async getImportedPacks(): Promise<LoopDeckPack[]> {
    const rows = await database.all<unknown>('packs');
    return recoverStoredPacks(rows.sort((left, right) => installedOrder(left) - installedOrder(right)));
  }
  async getImportedPackAssets(): Promise<StoredPackAsset[]> {
    return database.all<StoredPackAsset>('packAssets');
  }
  async getPackAsset(packId: string, path: string): Promise<StoredPackAsset | undefined> {
    return (await database.request<StoredPackAsset>('packAssets', 'readonly', (store) => store.get(packAssetId(packId, path)))) as
      StoredPackAsset | undefined;
  }
  async deleteImportedPack(packId: string): Promise<void> {
    await deletePackAndAssets(packId);
  }
  async getReviewCards(): Promise<ReviewCard[]> {
    return database.all<ReviewCard>('reviewCards');
  }
  async getReviewCard(questionId: string): Promise<ReviewCard | undefined> {
    return (await database.request<ReviewCard>('reviewCards', 'readonly', (store) => store.get(questionId))) as ReviewCard | undefined;
  }
  async putReviewCard(card: ReviewCard): Promise<void> {
    await database.request('reviewCards', 'readwrite', (store) => store.put(card));
  }
  async putReviewLog(log: ReviewLog): Promise<void> {
    await database.request('reviewLogs', 'readwrite', (store) => store.put(log));
  }
  async getReviewLogs(): Promise<ReviewLog[]> {
    return database.all<ReviewLog>('reviewLogs');
  }
  async getReviewLogsForQuestion(questionId: string): Promise<ReviewLog[]> {
    const request = await database.transact<IDBRequest<ReviewLog[]>>('reviewLogs', 'readonly', (tx) =>
      tx.objectStore('reviewLogs').index('byQuestionId').getAll(questionId)
    );
    return request.result.sort((a, b) => Date.parse(a.reviewedAt) - Date.parse(b.reviewedAt));
  }
  async clearReviewData(): Promise<void> {
    await database.transact(['reviewCards', 'reviewLogs'], 'readwrite', (tx) => {
      tx.objectStore('reviewCards').clear();
      tx.objectStore('reviewLogs').clear();
    });
  }
  async exportSnapshot(): Promise<StudyBackup> {
    const requests = await database.transact(USER_DATA_STORES, 'readonly', (tx) => ({
      attempts: tx.objectStore('attempts').getAll() as IDBRequest<Attempt[]>,
      bookmarks: tx.objectStore('bookmarks').getAll() as IDBRequest<{ questionId: string }[]>,
      packs: tx.objectStore('packs').getAll() as IDBRequest<unknown[]>,
      assets: tx.objectStore('packAssets').getAll() as IDBRequest<StoredPackAsset[]>,
      cards: tx.objectStore('reviewCards').getAll() as IDBRequest<ReviewCard[]>,
      logs: tx.objectStore('reviewLogs').getAll() as IDBRequest<ReviewLog[]>
    }));
    return {
      format: 'loopdeck3.backup', schema: 1, exportedAt: new Date().toISOString(),
      attempts: requests.attempts.result,
      bookmarks: requests.bookmarks.result.map(row => row.questionId),
      importedPacks: recoverStoredPacks(requests.packs.result.sort((a, b) => installedOrder(a) - installedOrder(b))),
      importedPackAssets: requests.assets.result, reviewCards: requests.cards.result, reviewLogs: requests.logs.result
    };
  }
  async restoreSnapshot(backup: unknown, mode: BackupImportMode): Promise<void> {
    await importBackup(backup, mode);
  }
}
export const studyStore = new StudyRepository();
