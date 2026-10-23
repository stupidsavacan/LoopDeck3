import { LocalDatabase, CLOUD_STORES } from '../storage/indexedDb';
import type { PackSyncState, SyncSettings, SyncJob } from '../storage/cloudRecords';
import type { LoopDeckPack } from '../core/models';
import type { ImportedPackAsset } from '../packs/packTypes';
import type { CloudRevision, CloudApi } from './api';
import { nativeCloud, NATIVE_TOKEN_REFERENCE, mirrorNative } from '../platform/nativeCloud';
export interface StagedPack {
  packId: string;
  head: CloudRevision;
  expectedGeneration: number;
  pack: LoopDeckPack;
  assets: ImportedPackAsset[];
}
export class CloudStore {
  constructor(readonly db: LocalDatabase) {}
  async settings(): Promise<SyncSettings | undefined> {
    const value = (await this.db.request<SyncSettings>('cloudConfig', 'readonly', (s) => s.get('settings'))) ?? undefined;
    if (value?.token === NATIVE_TOKEN_REFERENCE) return { ...value, token: nativeCloud()?.token() || undefined };
    return value;
  }
  async configure(settings: SyncSettings): Promise<void> {
    const old = await this.settings();
    if (old?.setupComplete && old.apiUrl !== settings.apiUrl) throw new Error('設定済みライブラリの接続先は変更できません。');
    const bridge = nativeCloud();
    if (bridge && settings.token) {
      if (!bridge.credentials(settings.apiUrl, settings.token)) throw new Error('Android Keystoreへの認証情報保存に失敗しました。');
      settings = { ...settings, token: NATIVE_TOKEN_REFERENCE };
    }
    await this.db.transact('cloudConfig', 'readwrite', (tx) => {
      const s = tx.objectStore('cloudConfig'),
        r = s.get('settings');
      r.onsuccess = () => {
        if (r.result?.setupComplete && r.result.apiUrl !== settings.apiUrl) {
          tx.abort();
          return;
        }
        s.put({
          ...r.result,
          ...settings,
          setupComplete: !!r.result?.setupComplete || settings.setupComplete,
          lastSuccess: r.result?.lastSuccess
        });
      };
    });
  }
  async state(packId: string): Promise<PackSyncState | undefined> {
    return (await this.db.request<PackSyncState>('packSync', 'readonly', (s) => s.get(packId))) ?? undefined;
  }
  async restore(api: CloudApi, packId: string, revision: number): Promise<CloudRevision> {
    const key = `restore:${packId}:${revision}`;
    let opId = '';
    await this.db.transact('cloudConfig', 'readwrite', (tx) => {
      const s = tx.objectStore('cloudConfig'),
        r = s.get(key);
      r.onsuccess = () => {
        opId = typeof r.result?.opId === 'string' ? r.result.opId : crypto.randomUUID();
        s.put({ key, opId });
      };
    });
    const result = await api.restore(packId, revision, opId);
    await this.db.transact('cloudConfig', 'readwrite', (tx) => {
      const s = tx.objectStore('cloudConfig'),
        r = s.get(key);
      r.onsuccess = () => {
        if (r.result?.opId === opId) s.delete(key);
      };
    });
    return result;
  }
  async setup(selectedLocal: string[], excludedCloud: string[], heads: CloudRevision[]): Promise<void> {
    await this.db.transact([...CLOUD_STORES, 'packs', 'packAssets'], 'readwrite', (tx) => {
      const config = tx.objectStore('cloudConfig').get('settings'),
        packs = tx.objectStore('packs').getAll(),
        assets = tx.objectStore('packAssets').getAll(),
        states = tx.objectStore('packSync').getAll();
      states.onsuccess = () => {
        if (!config.result?.token || config.result.setupComplete) {
          tx.abort();
          return;
        }
        tx.objectStore('cloudOutbox').clear();
        tx.objectStore('cloudStaging').clear();
        const old = new Map<string, PackSyncState>(states.result.map((s: PackSyncState) => [s.packId, s]));
        const localIds = new Set<string>();
        for (const pack of packs.result as LoopDeckPack[]) {
          localIds.add(pack.packId);
          const previous = old.get(pack.packId),
            enabled = selectedLocal.includes(pack.packId) && previous?.mode !== 'excludedByDeletion',
            dirty = enabled && !heads.some((h) => h.packId === pack.packId),
            generation = (previous?.generation ?? 0) + 1;
          tx.objectStore('packSync').put({
            packId: pack.packId,
            mode: previous?.mode === 'excludedByDeletion' ? 'excludedByDeletion' : enabled ? 'enabled' : 'localOnly',
            generation,
            dirty
          } satisfies PackSyncState);
          if (dirty)
            tx.objectStore('cloudOutbox').put({
              opId: crypto.randomUUID(),
              onlyIfAbsent: true,
              packId: pack.packId,
              generation,
              pack,
              assets: (assets.result as ImportedPackAsset[]).filter((a) => a.packId === pack.packId),
              createdAt: Date.now(),
              attempts: 0,
              notBefore: 0
            } satisfies SyncJob);
        }
        for (const head of heads)
          if (!localIds.has(head.packId) && !old.has(head.packId))
            tx.objectStore('packSync').put({
              packId: head.packId,
              mode: excludedCloud.includes(head.packId) ? 'localOnly' : 'enabled',
              generation: 0,
              dirty: false
            } satisfies PackSyncState);
        tx.objectStore('cloudConfig').put({ ...config.result, setupComplete: true });
      };
    });
  }
  async setEnabled(packId: string, enabled: boolean, cloudExists = true): Promise<void> {
    await this.db.transact(['packSync', 'cloudOutbox', 'cloudStaging', 'packs', 'packAssets'], 'readwrite', (tx) => {
      const state = tx.objectStore('packSync').get(packId),
        pack = tx.objectStore('packs').get(packId),
        assets = tx.objectStore('packAssets').getAll(),
        jobs = tx.objectStore('cloudOutbox').getAll();
      jobs.onsuccess = () => {
        const generation = (state.result?.generation ?? 0) + 1,
          dirty = enabled && !cloudExists && !!pack.result;
        tx.objectStore('packSync').put({
          ...state.result,
          packId,
          mode: enabled ? 'enabled' : 'localOnly',
          generation,
          dirty,
          remoteRevision: enabled ? undefined : state.result?.remoteRevision,
          syncedFingerprint: enabled ? undefined : state.result?.syncedFingerprint
        } satisfies PackSyncState);
        for (const j of jobs.result as SyncJob[]) if (j.packId === packId) tx.objectStore('cloudOutbox').delete(j.opId);
        tx.objectStore('cloudStaging').delete(packId);
        if (dirty)
          tx.objectStore('cloudOutbox').put({
            opId: crypto.randomUUID(),
            onlyIfAbsent: true,
            packId,
            generation,
            pack: pack.result,
            assets: (assets.result as ImportedPackAsset[]).filter((a) => a.packId === packId),
            createdAt: Date.now(),
            attempts: 0,
            notBefore: 0
          } satisfies SyncJob);
      };
    });
    await mirrorNative(this.db);
  }
  async active(job: SyncJob): Promise<boolean> {
    const requests = await this.db.transact(['cloudOutbox', 'packSync'], 'readonly', (tx) => ({
      job: tx.objectStore('cloudOutbox').get(job.opId),
      state: tx.objectStore('packSync').get(job.packId)
    }));
    return requests.job.result?.leaseOwner === job.leaseOwner && requests.state.result?.mode === 'enabled';
  }
  async claim(owner: string, now: number): Promise<SyncJob | undefined> {
    let claimed: SyncJob | undefined;
    await this.db.transact(['cloudOutbox', 'packSync'], 'readwrite', (tx) => {
      const jobs = tx.objectStore('cloudOutbox').getAll(),
        states = tx.objectStore('packSync').getAll();
      states.onsuccess = () => {
        const modes = new Map<string, PackSyncState>(states.result.map((s: PackSyncState) => [s.packId, s]));
        const blocked = new Set<string>();
        for (const j of (jobs.result as SyncJob[]).sort((a, b) => a.createdAt - b.createdAt || a.generation - b.generation)) {
          if (blocked.has(j.packId)) continue;
          blocked.add(j.packId);
          if (modes.get(j.packId)?.mode !== 'enabled') continue;
          if (j.permanent || j.notBefore > now || (j.leaseUntil ?? 0) > now) continue;
          claimed = { ...j, leaseOwner: owner, leaseUntil: now + 300000, attempts: j.attempts + 1 };
          tx.objectStore('cloudOutbox').put(claimed);
          break;
        }
      };
    });
    return claimed;
  }
  async updateOwned(job: SyncJob): Promise<boolean> {
    let saved = false;
    await this.db.transact('cloudOutbox', 'readwrite', (tx) => {
      const s = tx.objectStore('cloudOutbox'),
        r = s.get(job.opId);
      r.onsuccess = () => {
        if (r.result?.leaseOwner === job.leaseOwner) {
          s.put(job);
          saved = true;
        }
      };
    });
    return saved;
  }
  async acknowledge(job: SyncJob, head: CloudRevision): Promise<void> {
    await this.db.transact(['cloudOutbox', 'packSync'], 'readwrite', (tx) => {
      const jobs = tx.objectStore('cloudOutbox'),
        current = jobs.get(job.opId),
        state = tx.objectStore('packSync').get(job.packId);
      state.onsuccess = () => {
        if (current.result?.leaseOwner !== job.leaseOwner) return;
        jobs.delete(job.opId);
        const old = state.result as PackSyncState | undefined;
        if (old?.mode === 'enabled' && old.generation === job.generation)
          tx.objectStore('packSync').put({
            ...old,
            dirty: false,
            remoteRevision: head.revision,
            syncedFingerprint: head.contentFingerprint
          });
      };
    });
  }
  async abandonInitialUpload(job: SyncJob): Promise<void> {
    await this.db.transact(['cloudOutbox', 'packSync'], 'readwrite', (tx) => {
      const jobs = tx.objectStore('cloudOutbox'),
        current = jobs.get(job.opId),
        states = tx.objectStore('packSync'),
        state = states.get(job.packId);
      state.onsuccess = () => {
        if (current.result?.leaseOwner !== job.leaseOwner) return;
        jobs.delete(job.opId);
        const old = state.result as PackSyncState | undefined;
        if (old?.mode === 'enabled' && old.generation === job.generation)
          states.put({ ...old, dirty: false, remoteRevision: undefined, syncedFingerprint: undefined });
      };
    });
  }
  async stage(value: StagedPack): Promise<void> {
    await this.db.request('cloudStaging', 'readwrite', (s) => s.put(value));
  }
  async markSeen(head: CloudRevision, generation: number): Promise<void> {
    await this.db.transact('packSync', 'readwrite', (tx) => {
      const s = tx.objectStore('packSync'),
        r = s.get(head.packId);
      r.onsuccess = () => {
        const old = r.result as PackSyncState | undefined;
        if (old?.mode === 'enabled' && !old.dirty && old.generation === generation) s.put({ ...old, remoteRevision: head.revision });
      };
    });
  }
  async success(now: number): Promise<boolean> {
    let saved = false;
    await this.db.transact(['cloudConfig', 'cloudOutbox', 'cloudStaging'], 'readwrite', (tx) => {
      const s = tx.objectStore('cloudConfig'),
        r = s.get('settings'),
        jobs = tx.objectStore('cloudOutbox').count(),
        staged = tx.objectStore('cloudStaging').count();
      staged.onsuccess = () => {
        if (r.result?.token && !jobs.result && !staged.result) {
          s.put({ ...r.result, lastSuccess: now });
          saved = true;
        }
      };
    });
    return saved;
  }
  async clearToken(expectedToken?: string): Promise<void> {
    const bridge = nativeCloud();
    if (bridge && expectedToken && bridge.token() !== expectedToken) return;
    bridge?.logout();
    await this.db.transact('cloudConfig', 'readwrite', (tx) => {
      const s = tx.objectStore('cloudConfig'),
        r = s.get('settings');
      r.onsuccess = () => {
        if (r.result && (!expectedToken || r.result.token === expectedToken || r.result.token === NATIVE_TOKEN_REFERENCE))
          s.put({ ...r.result, token: undefined });
      };
    });
  }
  async retry(): Promise<void> {
    await this.db.transact('cloudOutbox', 'readwrite', (tx) => {
      const s = tx.objectStore('cloudOutbox'),
        r = s.getAll();
      r.onsuccess = () => {
        for (const job of r.result as SyncJob[])
          if (!job.leaseUntil || job.leaseUntil < Date.now()) s.put({ ...job, permanent: false, error: undefined, notBefore: 0 });
      };
    });
  }
}
