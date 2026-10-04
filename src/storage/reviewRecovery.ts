import type { ReviewCard, ReviewLog } from '../core/models';
import { createReviewCard } from '../core/scheduler';
import { parseReviewCard, parseReviewLog } from './backupValidator';

// Missing creation times must not depend on when an upgrade/read happens.
const LEGACY_CREATED_AT = '1970-01-01T00:00:00.000Z';

export function recoverReviewCard(value: unknown): ReviewCard {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return parseReviewCard(value, 0);
  const row = value as Record<string, unknown>;
  const defaults = createReviewCard('', '', new Date(LEGACY_CREATED_AT));
  const normalized: Record<string, unknown> = { ...row };
  // IDs alone describe a new card. Existing progress requires an explicit state;
  // guessing it could reset learning history or silently remove a due card.
  const hasProgress = [
    'intervalDays',
    'totalReviews',
    'totalCorrect',
    'totalWrong',
    'correctStreak',
    'wrongStreak',
    'lapseCount',
    'leechLevel'
  ].some((key) => Number(row[key]) > 0);
  if (row.state === undefined && (hasProgress || row.lastReviewedAt || row.firstReviewedAt || row.dueAt)) {
    throw new Error('Legacy review card has progress but no recoverable state.');
  }
  if (row.state !== undefined && row.state !== 'new' && row.state !== 'suspended' && row.dueAt === undefined) {
    throw new Error('Legacy scheduled review card has no recoverable due date.');
  }
  for (const [key, fallback] of Object.entries(defaults)) {
    if (normalized[key] === undefined && key !== 'questionId' && key !== 'moduleId') normalized[key] = fallback;
  }
  if (row.totalReviews === undefined) normalized.totalReviews = Number(normalized.totalCorrect) + Number(normalized.totalWrong);
  if (row.totalCorrect === undefined && row.totalWrong !== undefined)
    normalized.totalCorrect = Number(normalized.totalReviews) - Number(normalized.totalWrong);
  if (row.totalWrong === undefined && row.totalCorrect !== undefined)
    normalized.totalWrong = Number(normalized.totalReviews) - Number(normalized.totalCorrect);
  if (row.suspended === undefined && row.state === 'suspended') normalized.suspended = true;
  return parseReviewCard(normalized, 0);
}

export function recoverStoredRows<T>(rows: unknown[], parse: (value: unknown) => T): T[] {
  const recovered: T[] = [];
  for (const row of rows) {
    try {
      recovered.push(parse(row));
    } catch (error) {
      console.warn('Ignoring an unrecoverable stored LoopDeck record during export.', error);
    }
  }
  return recovered;
}

/** Repair in the caller's transaction so an upgrade/read only exposes valid rows. */
export function recoverReviewRows<T extends ReviewCard | ReviewLog>(
  store: IDBObjectStore,
  rows: T[],
  source: IDBObjectStore | IDBIndex = store,
  range?: IDBKeyRange,
  onComplete?: () => void
): void {
  const request = source.openCursor(range);
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) {
      onComplete?.();
      return;
    }
    let recovered: ReviewCard | ReviewLog;
    try {
      // Logs record historical facts. Missing timestamps, ratings, results or
      // transitions cannot be faithfully invented; the strict parser rejects them.
      recovered = store.name === 'reviewCards' ? recoverReviewCard(cursor.value) : parseReviewLog(cursor.value, 0);
    } catch (error) {
      console.warn(`Removing an unrecoverable stored LoopDeck ${store.name} record.`, cursor.primaryKey, error);
      cursor.delete();
      cursor.continue();
      return;
    }
    const stored = cursor.value as Record<string, unknown>;
    if (
      Object.keys(recovered).length !== Object.keys(stored).length ||
      Object.entries(recovered).some(([key, value]) => stored[key] !== value)
    ) {
      cursor.update(recovered);
    }
    rows.push(recovered as T);
    cursor.continue();
  };
}
