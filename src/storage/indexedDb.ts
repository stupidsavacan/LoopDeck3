export const USER_DATA_STORES = ['attempts', 'bookmarks', 'packs', 'packAssets', 'reviewCards', 'reviewLogs'] as const;
export type StoreName = (typeof USER_DATA_STORES)[number];
const schema: Record<StoreName, { key: string; indexes?: Record<string, string> }> = {
  attempts: { key: 'attemptId', indexes: { byQuestionId: 'questionId', byResult: 'result' } },
  bookmarks: { key: 'questionId' },
  packs: { key: 'packId' },
  packAssets: { key: 'assetId', indexes: { byPackId: 'packId' } },
  reviewCards: { key: 'questionId' },
  reviewLogs: { key: 'reviewLogId', indexes: { byQuestionId: 'questionId', byReviewedAt: 'reviewedAt' } }
};

export class LocalDatabase {
  private connection: IDBDatabase | undefined;
  private opening: Promise<IDBDatabase> | undefined;
  constructor(private readonly name = 'loopdeck3-learning') {}

  private open(): Promise<IDBDatabase> {
    if (this.connection) return Promise.resolve(this.connection);
    if (this.opening) return this.opening;
    this.opening = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(this.name, 1);
      let failed = false;
      request.onupgradeneeded = () => {
        for (const name of USER_DATA_STORES) {
          const layout = schema[name];
          const store = request.result.createObjectStore(name, { keyPath: layout.key });
          for (const [index, key] of Object.entries(layout.indexes ?? {})) store.createIndex(index, key, { unique: false });
        }
      };
      request.onblocked = () => {
        failed = true;
        reject(new Error('Close other LoopDeck3 windows before opening this database.'));
      };
      request.onerror = () => {
        failed = true;
        reject(request.error ?? new Error('Cannot open the study database.'));
      };
      request.onsuccess = () => {
        const connection = request.result;
        if (failed) { connection.close(); return; }
        this.connection = connection;
        connection.onversionchange = () => this.close();
        resolve(connection);
      };
    }).finally(() => { this.opening = undefined; });
    return this.opening;
  }

  close(): void {
    this.connection?.close();
    this.connection = undefined;
  }

  async transact<T>(names: StoreName | readonly StoreName[], mode: IDBTransactionMode, schedule: (tx: IDBTransaction) => T): Promise<T> {
    const connection = await this.open();
    return new Promise<T>((resolve, reject) => {
      const tx = connection.transaction(typeof names === 'string' ? names : [...names], mode);
      let result: T;
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error ?? new Error('Study transaction failed.'));
      tx.onabort = () => reject(tx.error ?? new Error('Study transaction aborted.'));
      try {
        result = schedule(tx);
      } catch (error) {
        try { tx.abort(); } catch { /* Already inactive. */ }
        reject(error);
      }
    });
  }

  async request<T>(name: StoreName, mode: IDBTransactionMode, schedule: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | void> {
    const request = await this.transact(name, mode, (tx) => schedule(tx.objectStore(name)));
    return request?.result;
  }

  async all<T>(name: StoreName): Promise<T[]> {
    const result = await this.request<T[]>(name, 'readonly', (store) => store.getAll());
    return result ?? [];
  }
}
export const database = new LocalDatabase();
