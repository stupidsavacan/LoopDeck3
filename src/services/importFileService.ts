import { importLoopDeckJson, importLoopDeckZip } from '../packs/zipImporter';
import { validateImportFileSize } from '../packs/importLimits';
import type { PackValidationResult } from '../packs/packTypes';
import { looksLikeLoopDeckBackup, validateBackupPayload } from '../storage/backupValidator';
import type { StudyBackup } from '../storage/storageTypes';

export type ImportFileResult = { kind: 'backup'; backup: StudyBackup } | { kind: 'pack'; result: PackValidationResult };

export async function readImportFile(file: File): Promise<ImportFileResult> {
  const issues = validateImportFileSize(file);
  if (issues.length) return { kind: 'pack', result: { ok: false, issues } };
  const name = file.name.toLowerCase();
  if (name.endsWith('.zip')) return { kind: 'pack', result: await importLoopDeckZip(file) };
  if (!name.endsWith('.json'))
    return {
      kind: 'pack',
      result: { ok: false, issues: [{ level: 'error', message: 'Only JSON and ZIP files are supported.', path: file.name }] }
    };
  const text = await file.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (looksLikeLoopDeckBackup(parsed)) return { kind: 'backup', backup: validateBackupPayload(parsed) };
  const jsonFile = new File([text], file.name, { type: file.type || 'application/json' });
  return { kind: 'pack', result: await importLoopDeckJson(jsonFile) };
}
