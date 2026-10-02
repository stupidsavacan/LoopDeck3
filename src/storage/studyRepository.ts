import { buildReviewPersistence } from '../core/reviewPersistence';
import type { Attempt, LoopDeckPack, ReviewCard, ReviewLog } from '../core/models';
import type { ImportedPackAsset, PackAssetWriteStrategy } from '../packs/packTypes';

import { database, USER_DATA_STORES, type LocalDatabase } from './indexedDb';
import { installedOrder, putPacksInInstallOrder, savePackWithAssets, deletePackAndAssets, validatedPackForStorage, recoverStoredPacks, packAssetId } from './packStorage';
import { importBackup } from './backupStorage';
import type { BackupImportMode } from './storageTypes';

import type { StudyBackup, StoredPackAsset } from './storageTypes';

async function deleteAttemptsByResult(database: LocalDatabase, results: Attempt['result'][]): Promise<void> {
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
  constructor(private readonly data: LocalDatabase = database) {}
  async addAttempt(attempt: Attempt): Promise<void> {
    await this.data.request('attempts', 'readwrite', (store) => store.put(attempt));
  }
  async recordAnswer(attempt: Attempt): Promise<void> {
    let failure: unknown;
    try {
      await this.data.transact(['attempts', 'reviewCards', 'reviewLogs'], 'readwrite', (tx) => {
        const abort = (error: unknown) => { failure = error; tx.abort(); };
        const attempts = tx.objectStore('attempts');
        const cards = tx.objectStore('reviewCards');
        const existing = attempts.get(attempt.attemptId);
        existing.onsuccess = () => {
          try {
            if (existing.result) return;
            const current = cards.get(attempt.questionId);
            current.onsuccess = () => {
              try {
                const { card, log } = buildReviewPersistence(attempt, current.result as ReviewCard | undefined);
                attempts.add(attempt);
                cards.put(card);
                tx.objectStore('reviewLogs').add(log);
              } catch (error) { abort(error); }
            };
          } catch (error) { abort(error); }
        };
      });
    } catch (error) { throw failure ?? error; }
  }
  async getAttempts(): Promise<Attempt[]> {
    return this.data.all<Attempt>('attempts');
  }
  async clearAttempts(): Promise<void> {
    await this.data.request('attempts', 'readwrite', (store) => store.clear());
  }
  async clearWrongAttempts(): Promise<void> {
    await deleteAttemptsByResult(this.data, ['wrong', 'revealed']);
  }
  async setBookmark(questionId: string, enabled: boolean): Promise<void> {
    if (enabled) await this.data.request('bookmarks', 'readwrite', (store) => store.put({ questionId, createdAt: new Date().toISOString() }));
    else await this.data.request('bookmarks', 'readwrite', (store) => store.delete(questionId));
  }
  async getBookmarks(): Promise<string[]> {
    return (await this.data.all<{ questionId: string }>('bookmarks')).map((row) => row.questionId);
  }
  async hasBookmark(questionId: string): Promise<boolean> {
    return Boolean(await this.data.request<{ questionId: string }>('bookmarks', 'readonly', (store) => store.get(questionId)));
  }
  async clearBookmarks(): Promise<void> {
    await this.data.request('bookmarks', 'readwrite', (store) => store.clear());
  }
  async saveImportedPack(pack: LoopDeckPack): Promise<void> {
    const normalized = validatedPackForStorage(pack);
    await this.data.transact('packs', 'readwrite', (tx) => putPacksInInstallOrder(tx.objectStore('packs'), [normalized]));
  }
  async saveImportedPackWithAssets(pack: LoopDeckPack, assets: ImportedPackAsset[], strategy: PackAssetWriteStrategy): Promise<void> {
    await savePackWithAssets(this.data, validatedPackForStorage(pack), assets, strategy);
  }
  async getImportedPacks(): Promise<LoopDeckPack[]> {
    const rows = await this.data.all<unknown>('packs');
    return recoverStoredPacks(rows.sort((left, right) => installedOrder(left) - installedOrder(right)));
  }
  async getImportedPackAssets(): Promise<StoredPackAsset[]> {
    return this.data.all<StoredPackAsset>('packAssets');
  }
  async getPackAsset(packId: string, path: string): Promise<StoredPackAsset | undefined> {
    return (await this.data.request<StoredPackAsset>('packAssets', 'readonly', (store) => store.get(packAssetId(packId, path)))) as
      StoredPackAsset | undefined;
  }
  async deleteImportedPack(packId: string): Promise<void> {
    await deletePackAndAssets(this.data, packId);
  }
  async getReviewCards(): Promise<ReviewCard[]> {
    return this.data.all<ReviewCard>('reviewCards');
  }
  async getReviewCard(questionId: string): Promise<ReviewCard | undefined> {
    return (await this.data.request<ReviewCard>('reviewCards', 'readonly', (store) => store.get(questionId))) as ReviewCard | undefined;
  }
  async putReviewCard(card: ReviewCard): Promise<void> {
    await this.data.request('reviewCards', 'readwrite', (store) => store.put(card));
  }
  async putReviewLog(log: ReviewLog): Promise<void> {
    await this.data.request('reviewLogs', 'readwrite', (store) => store.put(log));
  }
  async getReviewLogs(): Promise<ReviewLog[]> {
    return this.data.all<ReviewLog>('reviewLogs');
  }
  async getReviewLogsForQuestion(questionId: string): Promise<ReviewLog[]> {
    const request = await this.data.transact<IDBRequest<ReviewLog[]>>('reviewLogs', 'readonly', (tx) =>
      tx.objectStore('reviewLogs').index('byQuestionId').getAll(questionId)
    );
    return request.result.sort((a, b) => Date.parse(a.reviewedAt) - Date.parse(b.reviewedAt));
  }
  async clearReviewData(): Promise<void> {
    await this.data.transact(['reviewCards', 'reviewLogs'], 'readwrite', (tx) => {
      tx.objectStore('reviewCards').clear();
      tx.objectStore('reviewLogs').clear();
    });
  }
  async exportSnapshot(): Promise<StudyBackup> {
    const requests = await this.data.transact(USER_DATA_STORES, 'readonly', (tx) => ({
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
    await importBackup(this.data, backup, mode);
  }
}
export const studyStore = new StudyRepository();
