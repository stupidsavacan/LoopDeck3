import JSZip from 'jszip';
import type { LoopDeckPack } from '../core/models';
import { extensionOf, isSafeImageAssetRef, isSafeImageDataUrl } from './assetSafety';
import { MAX_IMAGE_ASSET_BYTES, MAX_JSON_ENTRY_BYTES, validateImportFileSize } from './importLimits';
import type { ImportedPackAsset, PackValidationIssue, PackValidationResult } from './packTypes';
import { validatePack, validatePackFiles } from './packValidator';
import { inspectZipSafety } from './zipSafety';

const IMAGE_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp'
};

function validateContainerFile(file: File): PackValidationIssue[] {
  return [...validatePackFiles([file.name]), ...validateImportFileSize(file)];
}

async function readJson<T>(zip: JSZip, path: string, uncompressedBytesByPath: Map<string, number>): Promise<T | undefined> {
  const file = zip.file(path);
  if (!file) return undefined;
  const knownSize = uncompressedBytesByPath.get(path);
  if (knownSize !== undefined && knownSize > MAX_JSON_ENTRY_BYTES) throw new Error(`${path} exceeds the JSON entry size limit.`);
  const text = await file.async('string');
  return JSON.parse(text) as T;
}

function zipLookupPath(path: string): string {
  return path.replace(/\\/g, '/');
}

async function readReferencedAssets(
  zip: JSZip,
  pack: LoopDeckPack,
  issues: PackValidationIssue[],
  uncompressedBytesByPath: Map<string, number>
): Promise<ImportedPackAsset[]> {
  const assets: ImportedPackAsset[] = [];
  const referencedPaths = new Set(pack.questions.map((question) => question.imageAsset).filter((path): path is string => Boolean(path)));

  for (const path of referencedPaths) {
    if (!isSafeImageAssetRef(path)) {
      issues.push({ level: 'error', message: 'Unsafe or unsupported image asset reference was rejected.', path });
      continue;
    }

    const lookupPath = zipLookupPath(path);
    const zipFile = zip.file(lookupPath);
    if (!zipFile || zipFile.dir) {
      issues.push({ level: 'warning', message: 'Referenced image asset was not found in the ZIP.', path });
      continue;
    }
    const knownSize = uncompressedBytesByPath.get(lookupPath);
    if (knownSize !== undefined && knownSize > MAX_IMAGE_ASSET_BYTES) {
      issues.push({ level: 'error', message: 'Referenced image asset exceeds the per-asset size limit.', path });
      continue;
    }

    const mimeType = IMAGE_MIME_TYPES[extensionOf(path)];
    if (!mimeType) {
      issues.push({ level: 'error', message: 'Referenced image asset type is not supported.', path });
      continue;
    }

    const base64 = await zipFile.async('base64');
    const dataUrl = `data:${mimeType};base64,${base64}`;
    if (!isSafeImageDataUrl(dataUrl)) {
      issues.push({ level: 'error', message: 'Referenced asset is not a structurally valid image of its declared type.', path });
      continue;
    }
    assets.push({ packId: pack.packId, path, mimeType, dataUrl });
  }

  return assets;
}

async function readLoopDeckZip(file: File): Promise<PackValidationResult> {
  const fileIssues = validateContainerFile(file);
  if (fileIssues.some((issue) => issue.level === 'error')) return { ok: false, issues: fileIssues };

  const buffer = await file.arrayBuffer();
  const inspection = inspectZipSafety(buffer);
  if (inspection.issues.some((issue) => issue.level === 'error')) return { ok: false, issues: [...fileIssues, ...inspection.issues] };

  const zip = await JSZip.loadAsync(buffer);
  const paths = Object.values(zip.files)
    .filter((entry) => !entry.dir)
    .map((entry) => entry.name);
  const issues: PackValidationIssue[] = [...fileIssues, ...inspection.issues, ...validatePackFiles(paths)];

  const manifest = await readJson<Record<string, unknown>>(zip, 'manifest.json', inspection.uncompressedBytesByPath);
  const modules = await readJson<unknown[]>(zip, 'modules.json', inspection.uncompressedBytesByPath);
  const questions = await readJson<unknown[]>(zip, 'questions.json', inspection.uncompressedBytesByPath);

  if (!manifest) issues.push({ level: 'error', message: 'manifest.json is required.' });
  if (!modules) issues.push({ level: 'error', message: 'modules.json is required.' });
  if (!questions) issues.push({ level: 'error', message: 'questions.json is required.' });
  if (issues.some((issue) => issue.level === 'error') || !manifest || !modules || !questions) return { ok: false, issues };

  const rawPack = {
    packVersion: manifest.packVersion,
    packId: manifest.packId,
    title: manifest.title,
    description: manifest.description,
    folders: manifest.folders,
    modules,
    questions
  };
  const packResult = validatePack(rawPack);
  if (!packResult.ok || !packResult.pack) return { ok: false, issues: [...issues, ...packResult.issues] };

  const assets = await readReferencedAssets(zip, packResult.pack, issues, inspection.uncompressedBytesByPath);
  if (issues.some((entry) => entry.level === 'error')) return { ok: false, issues: [...issues, ...packResult.issues] };
  return { ok: true, issues: [...issues, ...packResult.issues], pack: packResult.pack, assets };
}

async function readLoopDeckJson(file: File): Promise<PackValidationResult> {
  const issues = validateContainerFile(file);
  if (issues.some((issue) => issue.level === 'error')) return { ok: false, issues };

  const text = await file.text();
  const json = JSON.parse(text) as unknown;
  const packResult = validatePack(json);
  return {
    ok: packResult.ok && !issues.some((issue) => issue.level === 'error'),
    issues: [...issues, ...packResult.issues],
    pack: packResult.pack,
    assets: []
  };
}

export async function importLoopDeckZip(file: File): Promise<PackValidationResult> {
  try {
    return await readLoopDeckZip(file);
  } catch (error) {
    return {
      ok: false,
      issues: [
        { level: 'error', message: `ZIP could not be read: ${error instanceof Error ? error.message : String(error)}`, path: file.name }
      ]
    };
  }
}

export async function importLoopDeckJson(file: File): Promise<PackValidationResult> {
  try {
    return await readLoopDeckJson(file);
  } catch (error) {
    return {
      ok: false,
      issues: [
        { level: 'error', message: `JSON could not be read: ${error instanceof Error ? error.message : String(error)}`, path: file.name }
      ]
    };
  }
}
