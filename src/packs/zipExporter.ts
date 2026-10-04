import JSZip from 'jszip';
import type { LoopDeckPack } from '../core/models';
import { extensionOf, isSafeImageAssetRef, isSafeImageDataUrl } from './assetSafety';
import type { ImportedPackAsset } from './packTypes';

export interface LoopDeckZipFiles {
  manifest: {
    packVersion: LoopDeckPack['packVersion'];
    packId: LoopDeckPack['packId'];
    title: LoopDeckPack['title'];
    description?: LoopDeckPack['description'];
    folders: LoopDeckPack['folders'];
  };
  modules: LoopDeckPack['modules'];
  questions: LoopDeckPack['questions'];
}

function stringifyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function assetBase64(dataUrl: string): string {
  return dataUrl.slice(dataUrl.indexOf(',') + 1);
}

function createZip(pack: LoopDeckPack, assets: ImportedPackAsset[] = []): JSZip {
  const zip = new JSZip();
  const files = createLoopDeckZipFiles(pack);

  zip.file('manifest.json', stringifyJson(files.manifest));
  zip.file('modules.json', stringifyJson(files.modules));
  zip.file('questions.json', stringifyJson(files.questions));

  const referencedPaths = new Set(pack.questions.map((question) => question.imageAsset).filter((path): path is string => Boolean(path)));
  for (const path of referencedPaths) {
    const asset = assets.find((item) => item.packId === pack.packId && item.path === path);
    if (!isSafeImageAssetRef(path) || !asset || !isSafeImageDataUrl(asset.dataUrl))
      throw new Error(`画像ファイルがないか破損しています。ZIPを書き出せません: ${path}`);
    const mime = extensionOf(path) === '.png' ? 'image/png' : extensionOf(path) === '.webp' ? 'image/webp' : 'image/jpeg';
    if (asset.mimeType.toLowerCase() !== mime || !asset.dataUrl.toLowerCase().startsWith(`data:${mime};base64,`))
      throw new Error(`Image type does not match its filename: ${path}`);
    zip.file(asset.path.replace(/\\/g, '/'), assetBase64(asset.dataUrl), { base64: true });
  }

  return zip;
}

export function createLoopDeckZipFiles(pack: LoopDeckPack): LoopDeckZipFiles {
  const manifest: LoopDeckZipFiles['manifest'] = {
    packVersion: pack.packVersion,
    packId: pack.packId,
    title: pack.title,
    folders: pack.folders
  };

  if (pack.description) manifest.description = pack.description;

  return {
    manifest,
    modules: pack.modules,
    questions: pack.questions
  };
}

export function stringifyLoopDeckJson(pack: LoopDeckPack): string {
  if (pack.questions.some((question) => question.imageAsset))
    throw new Error('画像ファイルを含む教材はZIPで書き出してください。JSONでは画像を保存できません。');
  return stringifyJson(pack);
}

export async function createLoopDeckZipBlob(pack: LoopDeckPack, assets: ImportedPackAsset[] = []): Promise<Blob> {
  return createZip(pack, assets).generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 }
  });
}

export async function createLoopDeckZipBytes(pack: LoopDeckPack, assets: ImportedPackAsset[] = []): Promise<Uint8Array> {
  return createZip(pack, assets).generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 }
  });
}

export function makePackFileStem(pack: LoopDeckPack): string {
  const candidate = pack.packId || pack.title || 'loopdeck-pack';
  const stem = candidate
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001F]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);

  return stem || 'loopdeck-pack';
}
