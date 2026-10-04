import type { LoopDeckPack } from '../core/models';
import { loadBuiltinPacks } from '../packs/builtinLoader';
import { resolveActivePacks } from '../packs/packResolver';
import { validateActivePackIdentities } from '../packs/packValidator';
import { getSupportedStudyQuestionModes } from '../core/questionPresentation';
import type { ConcreteStudyQuestionMode } from '../core/models';
import { parseAttempt, parseReviewLog, parseStoredAsset, validateBackupPayload } from './backupValidator';
import { USER_DATA_STORES, type LocalDatabase } from './indexedDb';
import { installedOrder, recoverStoredPacks } from './packStorage';
import { recoverReviewCard, recoverStoredRows } from './reviewRecovery';
import type { StudyBackup } from './storageTypes';

export async function exportBackup(database: LocalDatabase): Promise<StudyBackup> {
  // Queue all reads together. Overlapping writes cannot interleave between stores.
  const requests = await database.transact([...USER_DATA_STORES], 'readonly', (tx) =>
    Object.fromEntries(USER_DATA_STORES.map((name) => [name, tx.objectStore(name).getAll() as IDBRequest<unknown[]>]))
  );
  const builtin = loadBuiltinPacks();
  const candidates = recoverStoredPacks(requests.packs.result.sort((a, b) => installedOrder(a) - installedOrder(b)));
  const importedPacks: LoopDeckPack[] = [];
  for (const candidate of candidates.reverse()) {
    const errors = validateActivePackIdentities([...builtin, candidate, ...importedPacks]).filter((issue) => issue.level === 'error');
    if (errors.length) {
      console.warn('Ignoring a conflicting stored LoopDeck pack during export.', candidate.packId, errors);
      continue;
    }
    importedPacks.unshift(candidate);
  }
  const view = resolveActivePacks([...builtin, ...importedPacks]);
  const ownsQuestion = (row: {
    questionId: string;
    moduleId: string;
    questionMode?: ConcreteStudyQuestionMode;
    contentRetired?: boolean;
  }) => {
    if (row.contentRetired) return true;
    const question = view.questionById.get(row.questionId);
    const valid =
      !question ||
      (question.moduleId === row.moduleId && getSupportedStudyQuestionModes(question).includes(row.questionMode ?? 'as_stored'));
    if (!valid) console.warn('Ignoring a stored LoopDeck record with mismatched active question ownership during export.', row.questionId);
    return valid;
  };
  const attempts = recoverStoredRows(requests.attempts.result, (row) => parseAttempt(row, 0)).filter(ownsQuestion);
  const attemptsById = new Map(attempts.map((attempt) => [attempt.attemptId, attempt]));
  const reviewCards = recoverStoredRows(requests.reviewCards.result, recoverReviewCard).filter(ownsQuestion);
  const reviewLogs = recoverStoredRows(requests.reviewLogs.result, (row) => parseReviewLog(row, 0))
    .filter(ownsQuestion)
    .filter((log) => {
      const attempt = log.attemptId ? attemptsById.get(log.attemptId) : undefined;
      if (!attempt) return true;
      const valid =
        attempt.questionId === log.questionId &&
        attempt.moduleId === log.moduleId &&
        (attempt.questionMode ?? 'as_stored') === (log.questionMode ?? 'as_stored') &&
        attempt.result === log.result &&
        Date.parse(attempt.answeredAt) === Date.parse(log.reviewedAt);
      if (!valid) console.warn('Ignoring a stored LoopDeck review log with a mismatched attempt during export.', log.reviewLogId);
      return valid;
    });
  const packIds = new Set(importedPacks.map((pack) => pack.packId));
  const assets = recoverStoredRows(requests.packAssets.result, (row) => parseStoredAsset(row, 0, packIds));
  const importedPackAssets = [...new Map(assets.map((asset) => [asset.assetId, asset])).values()];
  const bookmarks = requests.bookmarks.result.flatMap((row) => {
    const questionId = typeof row === 'object' && row !== null && 'questionId' in row ? row.questionId : undefined;
    return typeof questionId === 'string' && questionId.trim() ? [questionId] : [];
  });
  return validateBackupPayload({
    format: 'loopdeck3.backup',
    schema: 1,
    exportedAt: new Date().toISOString(),
    attempts,
    bookmarks,
    importedPacks,
    importedPackAssets,
    reviewCards,
    reviewLogs
  });
}
