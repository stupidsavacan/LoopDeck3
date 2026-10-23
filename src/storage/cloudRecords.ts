import type { LoopDeckPack } from '../core/models';
import type { ImportedPackAsset, PackAssetWriteStrategy } from '../packs/packTypes';
export type SyncMode = 'enabled' | 'localOnly' | 'excludedByDeletion';
export interface PackSyncState {
  packId: string;
  mode: SyncMode;
  generation: number;
  dirty: boolean;
  remoteRevision?: number;
  syncedFingerprint?: string;
}
export interface SyncJob {
  onlyIfAbsent?: boolean;
  opId: string;
  packId: string;
  generation: number;
  pack: LoopDeckPack;
  assets: ImportedPackAsset[];
  createdAt: number;
  attempts: number;
  notBefore: number;
  leaseUntil?: number;
  leaseOwner?: string;
  zip?: Blob;
  fingerprint?: string;
  sha256?: string;
  error?: string;
  permanent?: boolean;
}
export interface RemoteCommit {
  origin: 'remote';
  revision: number;
  fingerprint: string;
  expectedGeneration: number;
}
export interface SyncSettings {
  key: 'settings';
  apiUrl: string;
  token?: string;
  setupComplete: boolean;
  deviceName: string;
  lastSuccess?: number;
}

/** Schedules only IDB requests: never await crypto/network inside a write transaction. */
export function recordPackMutation(
  tx: IDBTransaction,
  pack: LoopDeckPack,
  assets: ImportedPackAsset[],
  strategy: PackAssetWriteStrategy,
  remote?: RemoteCommit
): void {
  const stateRequest = tx.objectStore('packSync').get(pack.packId);
  const settingsRequest = tx.objectStore('cloudConfig').get('settings');
  const storedAssets = tx.objectStore('packAssets').getAll();
  const jobsRequest = tx.objectStore('cloudOutbox').getAll();
  jobsRequest.onsuccess = () => {
    const old = stateRequest.result as PackSyncState | undefined;
    const settings = settingsRequest.result as SyncSettings | undefined;
    const jobs = jobsRequest.result as SyncJob[];
    if (remote) {
      if (
        !settings?.setupComplete ||
        !settings.token ||
        old?.mode === 'localOnly' ||
        old?.mode === 'excludedByDeletion' ||
        (old?.generation ?? 0) !== remote.expectedGeneration ||
        old?.dirty ||
        jobs.some((j) => j.packId === pack.packId) ||
        (old?.remoteRevision ?? 0) >= remote.revision
      ) {
        tx.abort();
        return;
      }
      tx.objectStore('packSync').put({
        packId: pack.packId,
        mode: 'enabled',
        generation: (old?.generation ?? 0) + 1,
        dirty: false,
        remoteRevision: remote.revision,
        syncedFingerprint: remote.fingerprint
      } satisfies PackSyncState);
      tx.objectStore('cloudStaging').delete(pack.packId);
      return;
    }
    const mode =
      old?.mode === 'excludedByDeletion'
        ? settings?.setupComplete
          ? 'enabled'
          : 'localOnly'
        : (old?.mode ?? (settings?.setupComplete ? 'enabled' : 'localOnly'));
    const generation = (old?.generation ?? 0) + 1;
    tx.objectStore('packSync').put({ ...old, packId: pack.packId, mode, generation, dirty: mode === 'enabled' } satisfies PackSyncState);
    tx.objectStore('cloudStaging').delete(pack.packId);
    // Collapse unattempted snapshots. At most one uncertain attempted operation is
    // resolved before the newest intent, preserving local commit ordering.
    for (const job of jobs) if (job.packId === pack.packId && job.attempts === 0) tx.objectStore('cloudOutbox').delete(job.opId);
    if (mode !== 'enabled') return;
    const references = new Set(pack.questions.map((q) => q.imageAsset).filter(Boolean));
    const merged = new Map<string, ImportedPackAsset>();
    if (strategy === 'upsert')
      for (const a of storedAssets.result as ImportedPackAsset[])
        if (a.packId === pack.packId && references.has(a.path)) merged.set(a.path, a);
    for (const a of assets) if (references.has(a.path)) merged.set(a.path, { ...a, packId: pack.packId });
    tx.objectStore('cloudOutbox').put({
      opId: crypto.randomUUID(),
      packId: pack.packId,
      generation,
      pack,
      assets: [...merged.values()],
      createdAt: Date.now(),
      attempts: 0,
      notBefore: 0
    } satisfies SyncJob);
  };
}
export function recordPackDeletion(tx: IDBTransaction, packId: string): void {
  const request = tx.objectStore('packSync').get(packId);
  request.onsuccess = () =>
    tx.objectStore('packSync').put({
      ...request.result,
      packId,
      mode: 'excludedByDeletion',
      generation: (request.result?.generation ?? 0) + 1,
      dirty: false
    } satisfies PackSyncState);
  const jobs = tx.objectStore('cloudOutbox').getAll();
  jobs.onsuccess = () => {
    for (const j of jobs.result as SyncJob[]) if (j.packId === packId) tx.objectStore('cloudOutbox').delete(j.opId);
  };
  tx.objectStore('cloudStaging').delete(packId);
}
export function recordBackupSyncExclusions(tx: IDBTransaction, ids: string[], replace: boolean): void {
  const states = tx.objectStore('packSync').getAll(),
    packs = tx.objectStore('packs').getAll(),
    jobs = tx.objectStore('cloudOutbox').getAll();
  jobs.onsuccess = () => {
    const existing = new Map<string, PackSyncState>((states.result as PackSyncState[]).map((s) => [s.packId, s]));
    const affected = new Set([...ids, ...(replace ? packs.result.map((p: { packId: string }) => p.packId) : [])]);
    for (const packId of affected) {
      const old = existing.get(packId);
      tx.objectStore('packSync').put({
        ...old,
        packId,
        mode: ids.includes(packId) && old?.mode !== 'excludedByDeletion' ? 'localOnly' : 'excludedByDeletion',
        generation: (old?.generation ?? 0) + 1,
        dirty: false
      } satisfies PackSyncState);
      tx.objectStore('cloudStaging').delete(packId);
    }
    for (const j of jobs.result as SyncJob[]) if (affected.has(j.packId)) tx.objectStore('cloudOutbox').delete(j.opId);
  };
}
