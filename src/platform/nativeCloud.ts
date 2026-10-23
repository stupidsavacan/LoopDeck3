import type { SyncJob, PackSyncState } from '../storage/cloudRecords';
import type { LocalDatabase } from '../storage/indexedDb';
import { CloudHttpError, type CloudRevision } from '../cloud/api';
interface NativeCloud {
  origin(): string;
  token(): string;
  credentials(origin: string, token: string): boolean;
  logout(): void;
  mirror(json: string): boolean;
  begin(json: string): boolean;
  append(op: string, offset: number, base64: string): boolean;
  finish(op: string): boolean;
  staged(): string;
  read(key: string, offset: number): string;
  discard(key: string): void;
  ack(op: string): string;
}
export function nativeCloud(): NativeCloud | undefined {
  return (globalThis as typeof globalThis & { LoopDeckCloud?: NativeCloud }).LoopDeckCloud;
}
export const NATIVE_TOKEN_REFERENCE = '@android-keystore';
export async function mirrorNative(db: LocalDatabase): Promise<void> {
  const bridge = nativeCloud();
  if (!bridge) return;
  const requests = await db.transact(['packSync', 'cloudOutbox', 'cloudConfig'], 'readonly', (tx) => ({
    states: tx.objectStore('packSync').getAll(),
    jobs: tx.objectStore('cloudOutbox').getAll(),
    config: tx.objectStore('cloudConfig').get('settings')
  }));
  if (
    !bridge.mirror(
      JSON.stringify({
        setupComplete: !!requests.config.result?.setupComplete,
        states: Object.fromEntries((requests.states.result as PackSyncState[]).map((s) => [s.packId, s])),
        jobs: Object.fromEntries((requests.jobs.result as SyncJob[]).map((j) => [j.opId, { packId: j.packId, generation: j.generation }]))
      })
    )
  )
    throw new Error('Android同期状態の永続化に失敗しました。');
}
export async function stageNative(job: SyncJob): Promise<void> {
  const bridge = nativeCloud();
  if (!bridge || !job.zip) return;
  if (
    !bridge.begin(
      JSON.stringify({
        opId: job.opId,
        onlyIfAbsent: job.onlyIfAbsent,
        packId: job.packId,
        generation: job.generation,
        size: job.zip.size,
        sha256: job.sha256,
        fingerprint: job.fingerprint,
        createdAt: job.createdAt
      })
    )
  )
    throw new Error('Android送信ZIPの準備に失敗しました。');
  for (let offset = 0; offset < job.zip.size; offset += 49152) {
    const chunk = new Uint8Array(await job.zip.slice(offset, offset + 49152).arrayBuffer());
    let binary = '';
    for (let i = 0; i < chunk.length; i += 8192) binary += String.fromCharCode(...chunk.subarray(i, i + 8192));
    if (!bridge.append(job.opId, offset, btoa(binary))) throw new Error('Android送信ZIPの保存に失敗しました。');
  }
  if (!bridge.finish(job.opId)) throw new Error('Android送信ZIPの照合に失敗しました。');
}
export function nativeReceipt(op: string): CloudRevision | undefined {
  const value = nativeCloud()?.ack(op);
  const result = value ? JSON.parse(value) : undefined;
  if (result?.creationConflict) throw new CloudHttpError(412, 'cloud_pack_exists');
  return result;
}
export async function nativeDownload(head: CloudRevision, generation: number): Promise<{ bytes: ArrayBuffer; key: string } | undefined> {
  const bridge = nativeCloud();
  if (!bridge) return;
  const entries = JSON.parse(bridge.staged()) as { head: CloudRevision; key: string; expectedGeneration: number }[];
  const entry = entries.find(
    (e) => e.head.packId === head.packId && e.head.revision === head.revision && e.expectedGeneration === generation
  );
  if (!entry) return;
  if (head.size < 0 || head.size > 32 * 1024 * 1024) throw new Error('Android受信ZIPの容量が不正です。');
  const bytes = new Uint8Array(head.size);
  for (let offset = 0; offset < head.size;) {
    const raw = atob(bridge.read(entry.key, offset));
    if (!raw.length || offset + raw.length > head.size) throw new Error('Android受信ZIPが不完全です。');
    for (let i = 0; i < raw.length; i++) bytes[offset + i] = raw.charCodeAt(i);
    offset += raw.length;
  }
  return { bytes: bytes.buffer, key: entry.key };
}
