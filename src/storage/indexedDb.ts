const DB_NAME = 'loopdeck3-db';
const DB_VERSION = 4;
export const USER_DATA_STORES = ['attempts', 'bookmarks', 'packs', 'packAssets', 'reviewCards', 'reviewLogs'] as const;

function ensureStore(database: IDBDatabase, transaction: IDBTransaction, name: string, keyPath: string): IDBObjectStore {
  return database.objectStoreNames.contains(name) ? transaction.objectStore(name) : database.createObjectStore(name, { keyPath });
}

function ensureIndex(store: IDBObjectStore, name: string, keyPath: string): void {
  if (!store.indexNames.contains(name)) store.createIndex(name, keyPath, { unique: false });
}

let databaseConnection: IDBDatabase | undefined;
let databasePromise: Promise<IDBDatabase> | undefined;

function openDb(): Promise<IDBDatabase> {
  if (databaseConnection) return Promise.resolve(databaseConnection);
  if (databasePromise) return databasePromise;

  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (database.objectStoreNames.contains('settings')) database.deleteObjectStore('settings');
      const upgradeTransaction = request.transaction;
      if (!upgradeTransaction) throw new Error('IndexedDB upgrade transaction is unavailable.');

      const attempts = ensureStore(database, upgradeTransaction, 'attempts', 'attemptId');
      ensureIndex(attempts, 'byQuestionId', 'questionId');
      ensureIndex(attempts, 'byResult', 'result');

      ensureStore(database, upgradeTransaction, 'bookmarks', 'questionId');
      ensureStore(database, upgradeTransaction, 'packs', 'packId');

      const packAssets = ensureStore(database, upgradeTransaction, 'packAssets', 'assetId');
      ensureIndex(packAssets, 'byPackId', 'packId');

      ensureStore(database, upgradeTransaction, 'reviewCards', 'questionId');

      const reviewLogs = ensureStore(database, upgradeTransaction, 'reviewLogs', 'reviewLogId');
      ensureIndex(reviewLogs, 'byQuestionId', 'questionId');
      ensureIndex(reviewLogs, 'byReviewedAt', 'reviewedAt');
    };
    request.onsuccess = () => {
      const database = request.result;
      databaseConnection = database;
      databasePromise = undefined;
      database.onversionchange = () => {
        database.close();
        if (databaseConnection === database) databaseConnection = undefined;
        databasePromise = undefined;
      };
      resolve(database);
    };
    request.onerror = () => {
      databasePromise = undefined;
      reject(request.error ?? new Error('Failed to open LoopDeck IndexedDB.'));
    };
  });
  return databasePromise;
}

export async function runTransaction<T>(
  storeNames: string | string[],
  mode: IDBTransactionMode,
  task: (transaction: IDBTransaction) => T
): Promise<T> {
  const database = await openDb();
  return new Promise<T>((resolve, reject) => {
    const tx = database.transaction(storeNames, mode);
    let result: T;
    try {
      result = task(tx);
    } catch (error) {
      try {
        tx.abort();
      } catch {
        /* already inactive */
      }
      reject(error);
      return;
    }
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed.'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction was aborted.'));
  });
}

export async function transaction<T>(
  storeName: string,
  mode: IDBTransactionMode,
  task: (store: IDBObjectStore) => IDBRequest<T> | void
): Promise<T | void> {
  const request = await runTransaction<IDBRequest<T> | void>(storeName, mode, (tx) => task(tx.objectStore(storeName)));
  return request ? request.result : undefined;
}

export async function getAll<T>(storeName: string): Promise<T[]> {
  const result = await transaction<T[]>(storeName, 'readonly', (store) => store.getAll());
  return Array.isArray(result) ? result : [];
}

