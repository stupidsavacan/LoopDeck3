import type { LoopDeckPack } from '../core/models';
import type { ImportedPackAsset } from './packTypes';
import { validatePack } from './packValidator';

export async function sha256(bytes: ArrayBuffer): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
}
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return (
      '{' +
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => JSON.stringify(k) + ':' + canonicalJson(v))
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(value);
}
/** ZIP timestamps and installedOrder/contentRevision are deliberately excluded. */
export async function contentFingerprint(raw: LoopDeckPack, assets: ImportedPackAsset[]): Promise<string> {
  const result = validatePack(raw);
  if (!result.ok || !result.pack) throw new Error('Invalid pack fingerprint input');
  const pack = result.pack;
  const paths = [...new Set(pack.questions.map((q) => q.imageAsset).filter((p): p is string => !!p))].sort();
  const images: { path: string; sha256: string }[] = [];
  for (const path of paths) {
    const asset = assets.find((a) => a.packId === pack.packId && a.path === path);
    if (!asset) throw new Error('Referenced image is missing');
    const binary = atob(asset.dataUrl.slice(asset.dataUrl.indexOf(',') + 1));
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    images.push({ path, sha256: await sha256(bytes.buffer) });
  }
  return sha256(new TextEncoder().encode(canonicalJson({ pack, images })).buffer);
}
