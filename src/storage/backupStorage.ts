import { clearBrowserStudyState } from './browserStudyState';
import { validateBackupPayload, validateBackupRelationships } from './backupValidator';
import { USER_DATA_STORES, type LocalDatabase } from './indexedDb';
import { installedOrder, putPacksInInstallOrder, recoverStoredPacks } from './packStorage';
import type { Attempt, ReviewCard, ReviewLog } from '../core/models';
import type { BackupImportMode } from './storageTypes';
import { retiredQuestionIds, retireQuestionLearningState } from './packLearningState';
import type { StoredPackAsset } from './storageTypes';
import { writeNewContentEpoch } from './packEpoch';

function mergedRows<T>(current: T[], incoming: T[], key: (row: T) => string): T[] {
  return [...new Map([...current, ...incoming].map((row) => [key(row), row])).values()];
}

export async function importBackup(database: LocalDatabase, rawBackup: unknown, mode: BackupImportMode): Promise<void> {
  if (mode !== 'merge' && mode !== 'replace') throw new Error('Explicit backup import mode is required.');
  const backup = validateBackupPayload(rawBackup);
  let restoreError: unknown;
  try {
    await database.transact([...USER_DATA_STORES, ...(mode === 'replace' ? (['contentMetadata'] as const) : [])], 'readwrite', (tx) => {
      const packsRequest = tx.objectStore('packs').getAll();
      const attemptsRequest = tx.objectStore('attempts').getAll() as IDBRequest<Attempt[]>;
      const cardsRequest = tx.objectStore('reviewCards').getAll() as IDBRequest<ReviewCard[]>;
      const assetsRequest = tx.objectStore('packAssets').getAll() as IDBRequest<StoredPackAsset[]>;
      const logsRequest = tx.objectStore('reviewLogs').getAll() as IDBRequest<ReviewLog[]>;
      // These requests run in order; validation and writes happen after all reads
      // inside the same serialized transaction, including concurrent imports.
      logsRequest.onsuccess = () => {
        try {
          const existingPacks =
            mode === 'merge' ? recoverStoredPacks(packsRequest.result.sort((a, b) => installedOrder(a) - installedOrder(b))) : [];
          const incomingPackIds = new Set(backup.importedPacks.map((pack) => pack.packId));
          const combinedPacks = [...existingPacks.filter((pack) => !incomingPackIds.has(pack.packId)), ...backup.importedPacks];
          const retiredIds = mode === 'merge' ? retiredQuestionIds(existingPacks, combinedPacks) : new Set<string>();
          if (mode === 'merge') {
            const oldAssets = new Map(assetsRequest.result.map((asset) => [asset.assetId, asset.dataUrl]));
            const changedAssets = new Set(
              (backup.importedPackAssets ?? [])
                .filter((asset) => oldAssets.has(asset.assetId) && oldAssets.get(asset.assetId) !== asset.dataUrl)
                .map((asset) => JSON.stringify([asset.packId, asset.path]))
            );
            for (const pack of existingPacks)
              for (const question of pack.questions) {
                if (question.imageAsset && changedAssets.has(JSON.stringify([pack.packId, question.imageAsset])))
                  retiredIds.add(question.id);
              }
          }
          validateBackupRelationships(
            {
              ...backup,
              attempts: mergedRows(
                mode === 'merge'
                  ? attemptsRequest.result.map((row) => (retiredIds.has(row.questionId) ? { ...row, contentRetired: true } : row))
                  : [],
                backup.attempts,
                (row) => row.attemptId
              ),
              reviewCards: mergedRows(
                mode === 'merge' ? cardsRequest.result.filter((row) => !retiredIds.has(row.questionId)) : [],
                backup.reviewCards ?? [],
                (row) => JSON.stringify([row.questionId, row.questionMode ?? 'as_stored'])
              ),
              reviewLogs: mergedRows(
                mode === 'merge' ? logsRequest.result.filter((row) => !retiredIds.has(row.questionId)) : [],
                backup.reviewLogs ?? [],
                (row) => row.reviewLogId
              )
            },
            combinedPacks
          );
          // Finish retirement before incoming puts so cursors cannot delete restored state.
          retireQuestionLearningState(tx, retiredIds, () => {
            try {
              writeBackup();
            } catch (error) {
              restoreError = error;
              tx.abort();
            }
          });
        } catch (error) {
          restoreError = error;
          console.warn('Backup restore rejected before writing inconsistent state.', error);
          tx.abort();
        }
      };

      function writeBackup(): void {
        if (mode === 'replace') {
          for (const storeName of USER_DATA_STORES) tx.objectStore(storeName).clear();
          writeNewContentEpoch(tx);
        }

        const attempts = tx.objectStore('attempts');
        for (const attempt of backup.attempts) attempts.put(attempt);

        const bookmarks = tx.objectStore('bookmarks');
        const importedAt = new Date().toISOString();
        for (const questionId of backup.bookmarks) bookmarks.put({ questionId, createdAt: importedAt });

        const packs = tx.objectStore('packs');
        putPacksInInstallOrder(packs, backup.importedPacks);

        const packAssets = tx.objectStore('packAssets');
        for (const asset of backup.importedPackAssets ?? []) packAssets.put(asset);

        const reviewCards = tx.objectStore('reviewCards');
        for (const card of backup.reviewCards ?? []) reviewCards.put(card);

        const reviewLogs = tx.objectStore('reviewLogs');
        for (const log of backup.reviewLogs ?? []) reviewLogs.put(log);
      }
    });
  } catch (error) {
    throw restoreError ?? error;
  }
  if (mode === 'replace') clearBrowserStudyState();
}
