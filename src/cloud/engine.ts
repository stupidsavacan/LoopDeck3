import { contentFingerprint, sha256 } from '../packs/contentFingerprint';
import { createLoopDeckZipBytes } from '../packs/zipExporter';
import { importLoopDeckZip } from '../packs/zipImporter';
import { validateActivePackIdentities } from '../packs/packValidator';
import { loadBuiltinPacks } from '../packs/builtinLoader';
import { CloudApi, CloudHttpError, type CloudRevision } from './api';
import { CloudStore, type StagedPack } from './store';
import type { StudyRepository } from '../storage/studyRepository';
import { mirrorNative, stageNative, nativeReceipt, nativeDownload, nativeCloud } from '../platform/nativeCloud';
export type SyncStatus = 'offline' | 'syncing' | 'ready' | 'waiting' | 'error' | 'authentication';
class CloudApplyFailure extends Error {}
export class SyncEngine {
  private busy = false;
  private owner = crypto.randomUUID();
  private timer: ReturnType<typeof setInterval> | undefined;
  status: SyncStatus = 'offline';
  error = '';
  private listeners = new Set<() => void>();
  constructor(
    readonly store: CloudStore,
    private readonly repository: StudyRepository,
    private readonly canApply: () => boolean,
    private readonly apiFactory = (base: string, token: string) => new CloudApi(base, token),
    private readonly protectApply: (work: () => Promise<void>) => Promise<boolean> = async (work) => {
      await work();
      return true;
    }
  ) {}
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private report(status: SyncStatus, error = '') {
    this.status = status;
    this.error = error;
    for (const listener of this.listeners) listener();
  }
  start(): () => void {
    const trigger = () => {
      void mirrorNative(this.store.db)
        .then(() => this.tick())
        .catch(() => this.report('error', 'Android同期状態の保存に失敗しました。'));
    };
    const visible = () => {
      if (document.visibilityState === 'visible') trigger();
    };
    this.timer = setInterval(trigger, 60000);
    addEventListener('online', trigger);
    document.addEventListener('visibilitychange', visible);
    const unwatch = this.repository.subscribePackChanges(trigger);
    trigger();
    return () => {
      clearInterval(this.timer);
      removeEventListener('online', trigger);
      document.removeEventListener('visibilitychange', visible);
      unwatch();
    };
  }
  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    let sessionToken: string | undefined;
    try {
      const settings = await this.store.settings();
      if (!settings?.token || !settings.setupComplete) {
        this.report('offline');
        return;
      }
      const api = this.apiFactory(settings.apiUrl, settings.token);
      sessionToken = settings.token;
      this.report('syncing');
      await mirrorNative(this.store.db);
      for (let i = 0; i < 10; i++) {
        const job = await this.store.claim(this.owner, Date.now());
        if (!job) break;
        try {
          if (!job.zip) {
            const bytes = await createLoopDeckZipBytes(job.pack, job.assets);
            if (bytes.byteLength > 32 * 1024 * 1024) throw new CloudHttpError(413, 'zip_too_large');
            job.zip = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/zip' });
            job.fingerprint = await contentFingerprint(job.pack, job.assets);
            job.sha256 = await sha256(await job.zip.arrayBuffer());
            if (!(await this.store.updateOwned(job))) continue;
          }
          const current = await this.store.state(job.packId);
          if (current?.mode !== 'enabled') continue;
          await stageNative(job);
          if (!(await this.store.active(job))) {
            await mirrorNative(this.store.db);
            continue;
          }
          const result = nativeReceipt(job.opId) ?? (await api.upload(job.packId, job.opId, job.zip, job.fingerprint!, job.onlyIfAbsent));
          if (result.packId !== job.packId || result.contentFingerprint !== job.fingerprint)
            throw new Error('送信結果の教材Fingerprintが一致しません。');
          // A semantic duplicate may acknowledge an older ZIP with different timestamps/SHA.
          await this.store.acknowledge(job, result);
          await mirrorNative(this.store.db);
        } catch (e) {
          if (!(await this.store.active(job))) continue;
          const http = e instanceof CloudHttpError ? e : undefined;
          if (http?.status === 412 && job.onlyIfAbsent) {
            await this.store.abandonInitialUpload(job);
            await mirrorNative(this.store.db);
            continue;
          }
          job.error = http ? `HTTP ${http.status}: ${http.code}` : '送信に失敗しました。';
          job.permanent = !!http && [400, 409, 413, 415, 422].includes(http.status);
          job.notBefore =
            Date.now() +
            Math.max(http?.retryAfter ?? 0, Math.min(3600000, 1000 * 2 ** Math.min(job.attempts, 12)) * (0.8 + Math.random() * 0.4));
          job.leaseUntil = undefined;
          job.leaseOwner = this.owner;
          await this.store.updateOwned(job);
          throw e;
        }
      }
      const heads = await api.heads();
      // One broken cloud pack must not stop every other pack from arriving.
      let pullFailure: unknown;
      for (const head of heads) {
        try {
          await this.pull(api, head);
        } catch (e) {
          if (e instanceof CloudHttpError && e.status === 401) throw e;
          pullFailure ??= e;
        }
      }
      await this.applyStaged();
      if (pullFailure) throw pullFailure;
      await mirrorNative(this.store.db);
      const outstanding = await this.store.db.all('cloudOutbox'),
        staged = await this.store.db.all('cloudStaging');
      if (outstanding.length || staged.length) this.report('waiting');
      else {
        this.report((await this.store.success(Date.now())) ? 'ready' : 'waiting');
      }
    } catch (e) {
      if (e instanceof CloudHttpError && e.status === 401) {
        await this.store.clearToken(sessionToken);
        this.report('authentication', 'ログインし直してください。');
      } else this.report('error', e instanceof CloudHttpError || e instanceof CloudApplyFailure ? e.message : '同期に失敗しました。設定画面から再試行できます。');
    } finally {
      this.busy = false;
    }
  }
  private async pull(api: CloudApi, head: CloudRevision): Promise<void> {
    const state = await this.store.state(head.packId);
    if (state && (state.mode !== 'enabled' || state.dirty || (state.remoteRevision ?? 0) >= head.revision)) return;
    if (state?.syncedFingerprint === head.contentFingerprint) {
      await this.store.markSeen(head, state.generation);
      return;
    }
    const existing = (await this.store.db.all<StagedPack>('cloudStaging')).find((s) => s.packId === head.packId);
    if (existing && existing.head.revision === head.revision && existing.expectedGeneration === (state?.generation ?? 0)) return;
    if (head.size > 32 * 1024 * 1024) throw new Error('クラウドZIPの容量が上限を超えています。');
    const stagedNative = await nativeDownload(head, state?.generation ?? 0);
    const bytes = stagedNative?.bytes ?? (await api.download(head));
    if (bytes.byteLength !== head.size || (await sha256(bytes)) !== head.sha256) throw new Error('クラウドZIPのSHA-256が一致しません。');
    const parsed = await importLoopDeckZip(
      { name: 'pack.loopdeck.zip', size: bytes.byteLength, arrayBuffer: async () => bytes } as File,
      true
    );
    if (
      !parsed.ok ||
      parsed.pack?.packId !== head.packId ||
      (await contentFingerprint(parsed.pack, parsed.assets ?? [])) !== head.contentFingerprint
    )
      throw new Error('クラウド教材の検証に失敗しました。');
    await this.store.stage({
      packId: head.packId,
      head,
      expectedGeneration: state?.generation ?? 0,
      pack: parsed.pack,
      assets: parsed.assets ?? []
    });
    if (stagedNative) nativeCloud()?.discard(stagedNative.key);
  }
  async applyStaged(): Promise<void> {
    if (!this.canApply() || !(await this.store.settings())?.token) return;
    const failures: string[] = [];
    for (const staged of await this.store.db.all<StagedPack>('cloudStaging')) {
      if (!this.canApply()) return;
      const state = await this.store.state(staged.packId);
      if (
        state &&
        (state.mode !== 'enabled' ||
          state.dirty ||
          state.generation !== staged.expectedGeneration ||
          (state.remoteRevision ?? 0) >= staged.head.revision)
      ) {
        await this.store.db.request('cloudStaging', 'readwrite', (s) => s.delete(staged.packId));
        continue;
      }
      const conflicts = validateActivePackIdentities([
        ...loadBuiltinPacks(),
        ...(await this.repository.getImportedPacks()),
        staged.pack
      ]).filter((issue) => issue.level === 'error');
      if (conflicts.length) {
        failures.push(`教材「${staged.pack.title}」(${staged.packId})は他の教材とIDが重複しています。この端末で同期OFFにするか、作成元でIDを修正してください。`);
        continue;
      }
      try {
        if (
          !(await this.protectApply(() =>
            this.repository.saveImportedPackFromCloud(staged.pack, staged.assets, {
              origin: 'remote',
              revision: staged.head.revision,
              fingerprint: staged.head.contentFingerprint,
              expectedGeneration: staged.expectedGeneration
            })
          ))
        )
          break;
      } catch {
        failures.push(`教材「${staged.pack.title}」(${staged.packId})の保存に失敗しました。設定画面から再試行してください。`);
      }
    }
    if (failures.length) throw new CloudApplyFailure(failures.join('\n'));
  }
}
