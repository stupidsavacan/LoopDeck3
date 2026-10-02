import { validateBackupPayload } from './backupValidator';
import { database, USER_DATA_STORES } from './indexedDb';
import { putPacksInInstallOrder } from './packStorage';
import type { BackupImportMode } from './storageTypes';

export async function importBackup(rawBackup: unknown, mode: BackupImportMode): Promise<void> {
  if (mode !== 'merge' && mode !== 'replace') throw new Error('Explicit backup import mode is required.');
  const backup = validateBackupPayload(rawBackup);
  await database.transact([...USER_DATA_STORES], 'readwrite', (tx) => {
    if (mode === 'replace') {
      for (const storeName of USER_DATA_STORES) tx.objectStore(storeName).clear();
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
  });
}
