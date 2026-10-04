import type {
  AnswerFormat,
  AnswerResult,
  Attempt,
  ConcreteStudyQuestionMode,
  LoopDeckPack,
  ReviewCard,
  ReviewLog,
  ReviewRating,
  ReviewState
} from '../core/models';
import { isSafeImageDataUrl, isSafeImageAssetRef, extensionOf } from '../packs/assetSafety';
import { packAssetId } from '../packs/packAssetIdentity';
import { estimateBase64DecodedBytes, MAX_BACKUP_COLLECTION_ITEMS, MAX_IMAGE_ASSET_BYTES } from '../packs/importLimits';
import { validatePack, validateActivePackIdentities } from '../packs/packValidator';
import { loadBuiltinPacks } from '../packs/builtinLoader';
import { resolveActivePacks } from '../packs/packResolver';
import { getSupportedStudyQuestionModes } from '../core/questionPresentation';
import type { StudyBackup, StoredPackAsset } from './storageTypes';

const ANSWER_RESULTS = new Set<AnswerResult>(['correct', 'wrong', 'revealed']);
const ATTEMPT_MODES = new Set(['normal', 'review']);
const ANSWER_FORMATS = new Set<AnswerFormat>(['auto', 'choice', 'input', 'flashcard']);
const QUESTION_MODES = new Set<ConcreteStudyQuestionMode>(['as_stored', 'front_to_back', 'back_to_front']);
const REVIEW_STATES = new Set<ReviewState>(['new', 'learning', 'review', 'relearning', 'leech', 'mastered', 'suspended']);
const REVIEW_RATINGS = new Set<ReviewRating>(['again', 'hard', 'good', 'easy']);
const IMAGE_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp'
};

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string');
const isStringOrStringArray = (value: unknown): value is string | string[] => typeof value === 'string' || isStringArray(value);
const nonEmptyString = (value: unknown): value is string => typeof value === 'string' && Boolean(value.trim());
const finiteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const nonNegativeNumber = (value: unknown): value is number => finiteNumber(value) && value >= 0;
const validDate = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
const validNullableDate = (value: unknown): value is string | null => value === null || validDate(value);

function fail(message: string): never {
  throw new Error(`Invalid LoopDeck backup: ${message}`);
}

function requireArray(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) fail(`${name} must be an array.`);
  if (value.length > MAX_BACKUP_COLLECTION_ITEMS) fail(`${name} contains too many items (max ${MAX_BACKUP_COLLECTION_ITEMS}).`);
  return value;
}

function optionalArray(value: unknown, name: string): unknown[] {
  if (value === undefined) return [];
  return requireArray(value, name);
}

function requireUnique<T>(rows: T[], key: (row: T) => string, name: string): void {
  const seen = new Set<string>();
  for (const row of rows) {
    const id = key(row);
    if (seen.has(id)) fail(`${name} contains duplicate key ${id}.`);
    seen.add(id);
  }
}

export function validateBackupRelationships(backup: StudyBackup, importedPacks: LoopDeckPack[] = backup.importedPacks): void {
  const packs = [...loadBuiltinPacks(), ...importedPacks];
  const errors = validateActivePackIdentities(packs).filter((issue) => issue.level === 'error');
  if (errors.length) fail(`active pack identity conflict: ${errors.map((issue) => issue.message).join('; ')}`);
  const view = resolveActivePacks(packs);
  // Deleted material remains useful history. When material is active, ownership
  // must agree; IDs for removed questions are retained as historical records.
  for (const row of [...backup.attempts, ...(backup.reviewCards ?? []), ...(backup.reviewLogs ?? [])]) {
    if ('contentRetired' in row && row.contentRetired === true) continue;
    const question = view.questionById.get(row.questionId);
    if (question && question.moduleId !== row.moduleId) fail(`question ${row.questionId} references the wrong module ${row.moduleId}.`);
    if (question && !getSupportedStudyQuestionModes(question).includes(row.questionMode ?? 'as_stored'))
      fail(`question ${row.questionId} references an unsupported study direction.`);
  }
  const attempts = new Map(backup.attempts.map((attempt) => [attempt.attemptId, attempt]));
  for (const log of backup.reviewLogs ?? []) {
    const attempt = log.attemptId ? attempts.get(log.attemptId) : undefined;
    // Missing attempts are allowed: clearing mistake history leaves SRS intact.
    if (
      attempt &&
      (attempt.questionId !== log.questionId ||
        attempt.moduleId !== log.moduleId ||
        (attempt.questionMode ?? 'as_stored') !== (log.questionMode ?? 'as_stored') ||
        attempt.result !== log.result ||
        Date.parse(attempt.answeredAt) !== Date.parse(log.reviewedAt))
    )
      fail(`review log ${log.reviewLogId} does not match its attempt.`);
  }
}

export function parseAttempt(value: unknown, index: number): Attempt {
  const path = `attempts[${index}]`;
  if (!isObject(value)) fail(`${path} must be an object.`);
  if (!nonEmptyString(value.attemptId)) fail(`${path}.attemptId is required.`);
  if (!nonEmptyString(value.questionId)) fail(`${path}.questionId is required.`);
  if (!nonEmptyString(value.moduleId)) fail(`${path}.moduleId is required.`);
  if (!validDate(value.answeredAt)) fail(`${path}.answeredAt must be a valid date.`);
  if (typeof value.result !== 'string' || !ANSWER_RESULTS.has(value.result as AnswerResult)) fail(`${path}.result is unsupported.`);
  if (!isStringOrStringArray(value.input)) fail(`${path}.input must be a string or string array.`);
  if (!isStringOrStringArray(value.answer)) fail(`${path}.answer must be a string or string array.`);
  if (!nonNegativeNumber(value.elapsedMs)) fail(`${path}.elapsedMs must be a non-negative finite number.`);
  if (typeof value.mode !== 'string' || !ATTEMPT_MODES.has(value.mode)) fail(`${path}.mode is unsupported.`);
  if (value.nearMiss !== undefined && typeof value.nearMiss !== 'boolean') fail(`${path}.nearMiss must be boolean.`);
  if (value.contentRetired !== undefined && typeof value.contentRetired !== 'boolean') fail(`${path}.contentRetired must be boolean.`);
  if (value.hiddenTimeExcludedMs !== undefined && !nonNegativeNumber(value.hiddenTimeExcludedMs))
    fail(`${path}.hiddenTimeExcludedMs must be non-negative.`);
  if (value.priorityDelta !== undefined && !finiteNumber(value.priorityDelta)) fail(`${path}.priorityDelta must be finite.`);
  if (value.answerMode !== undefined && (typeof value.answerMode !== 'string' || !ANSWER_FORMATS.has(value.answerMode as AnswerFormat)))
    fail(`${path}.answerMode is unsupported.`);
  if (
    value.questionMode !== undefined &&
    (typeof value.questionMode !== 'string' || !QUESTION_MODES.has(value.questionMode as ConcreteStudyQuestionMode))
  )
    fail(`${path}.questionMode is unsupported.`);

  return {
    attemptId: value.attemptId,
    questionId: value.questionId,
    moduleId: value.moduleId,
    answeredAt: value.answeredAt,
    result: value.result as AnswerResult,
    input: Array.isArray(value.input) ? [...value.input] : value.input,
    answer: Array.isArray(value.answer) ? [...value.answer] : value.answer,
    elapsedMs: value.elapsedMs,
    mode: value.mode as Attempt['mode'],
    ...(value.nearMiss !== undefined ? { nearMiss: value.nearMiss } : {}),
    ...(value.contentRetired !== undefined ? { contentRetired: value.contentRetired } : {}),
    ...(value.hiddenTimeExcludedMs !== undefined ? { hiddenTimeExcludedMs: value.hiddenTimeExcludedMs } : {}),
    ...(value.priorityDelta !== undefined ? { priorityDelta: value.priorityDelta } : {}),
    ...(value.answerMode !== undefined ? { answerMode: value.answerMode as AnswerFormat } : {}),
    ...(value.questionMode !== undefined ? { questionMode: value.questionMode as ConcreteStudyQuestionMode } : {})
  };
}

export function parseReviewCard(value: unknown, index: number): ReviewCard {
  const path = `reviewCards[${index}]`;
  if (!isObject(value)) fail(`${path} must be an object.`);
  if (!nonEmptyString(value.questionId)) fail(`${path}.questionId is required.`);
  if (!nonEmptyString(value.moduleId)) fail(`${path}.moduleId is required.`);
  if (value.questionMode !== undefined && !QUESTION_MODES.has(value.questionMode as ConcreteStudyQuestionMode))
    fail(`${path}.questionMode is unsupported.`);
  if (typeof value.state !== 'string' || !REVIEW_STATES.has(value.state as ReviewState)) fail(`${path}.state is unsupported.`);
  for (const key of ['dueAt', 'lastReviewedAt', 'firstReviewedAt'] as const)
    if (!validNullableDate(value[key])) fail(`${path}.${key} must be null or a valid date.`);
  for (const key of [
    'intervalDays',
    'ease',
    'totalReviews',
    'totalCorrect',
    'totalWrong',
    'correctStreak',
    'wrongStreak',
    'lapseCount',
    'leechLevel'
  ] as const) {
    if (!nonNegativeNumber(value[key])) fail(`${path}.${key} must be a non-negative finite number.`);
  }
  if (typeof value.suspended !== 'boolean') fail(`${path}.suspended must be boolean.`);
  if (!validDate(value.createdAt) || !validDate(value.updatedAt)) fail(`${path}.createdAt/updatedAt must be valid dates.`);
  for (const key of [
    'intervalDays',
    'totalReviews',
    'totalCorrect',
    'totalWrong',
    'correctStreak',
    'wrongStreak',
    'lapseCount',
    'leechLevel'
  ] as const) {
    if (!Number.isSafeInteger(value[key])) fail(`${path}.${key} must be a safe integer.`);
  }
  if ((value.ease as number) < 1.3 || (value.ease as number) > 3) fail(`${path}.ease must be between 1.3 and 3.`);
  if ((value.totalCorrect as number) + (value.totalWrong as number) !== value.totalReviews)
    fail(`${path}.review counters are inconsistent.`);
  if (
    (value.correctStreak as number) > (value.totalCorrect as number) ||
    (value.wrongStreak as number) > (value.totalWrong as number) ||
    ((value.correctStreak as number) > 0 && (value.wrongStreak as number) > 0) ||
    (value.lapseCount as number) > (value.totalWrong as number) ||
    (value.leechLevel as number) > 3
  )
    fail(`${path}.streak/lapse/leech counters are inconsistent.`);
  if (value.state === 'new' && value.totalReviews !== 0) fail(`${path}.new state cannot contain review progress.`);
  if (value.state !== 'new' && value.state !== 'suspended' && value.dueAt === null) fail(`${path}.scheduled state requires dueAt.`);
  return {
    questionId: value.questionId,
    questionMode: (value.questionMode ?? 'as_stored') as ConcreteStudyQuestionMode,
    moduleId: value.moduleId,
    state: value.state as ReviewState,
    dueAt: value.dueAt as string | null,
    lastReviewedAt: value.lastReviewedAt as string | null,
    firstReviewedAt: value.firstReviewedAt as string | null,
    intervalDays: value.intervalDays as number,
    ease: value.ease as number,
    totalReviews: value.totalReviews as number,
    totalCorrect: value.totalCorrect as number,
    totalWrong: value.totalWrong as number,
    correctStreak: value.correctStreak as number,
    wrongStreak: value.wrongStreak as number,
    lapseCount: value.lapseCount as number,
    leechLevel: value.leechLevel as number,
    suspended: value.suspended,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt
  };
}

export function parseReviewLog(value: unknown, index: number): ReviewLog {
  const path = `reviewLogs[${index}]`;
  if (!isObject(value)) fail(`${path} must be an object.`);
  if (!nonEmptyString(value.reviewLogId)) fail(`${path}.reviewLogId is required.`);
  if (!nonEmptyString(value.questionId)) fail(`${path}.questionId is required.`);
  if (!nonEmptyString(value.moduleId)) fail(`${path}.moduleId is required.`);
  if (value.questionMode !== undefined && !QUESTION_MODES.has(value.questionMode as ConcreteStudyQuestionMode))
    fail(`${path}.questionMode is unsupported.`);
  if (!validDate(value.reviewedAt)) fail(`${path}.reviewedAt must be a valid date.`);
  if (typeof value.rating !== 'string' || !REVIEW_RATINGS.has(value.rating as ReviewRating)) fail(`${path}.rating is unsupported.`);
  if (typeof value.result !== 'string' || !ANSWER_RESULTS.has(value.result as AnswerResult)) fail(`${path}.result is unsupported.`);
  if (typeof value.previousState !== 'string' || !REVIEW_STATES.has(value.previousState as ReviewState))
    fail(`${path}.previousState is unsupported.`);
  if (typeof value.nextState !== 'string' || !REVIEW_STATES.has(value.nextState as ReviewState)) fail(`${path}.nextState is unsupported.`);
  if (!validNullableDate(value.previousDueAt) || !validNullableDate(value.nextDueAt))
    fail(`${path}.previousDueAt/nextDueAt must be null or valid dates.`);
  for (const key of ['previousIntervalDays', 'nextIntervalDays', 'previousEase', 'nextEase', 'elapsedMs'] as const) {
    if (!nonNegativeNumber(value[key])) fail(`${path}.${key} must be a non-negative finite number.`);
  }
  if (value.attemptId !== undefined && !nonEmptyString(value.attemptId)) fail(`${path}.attemptId must be a non-empty string.`);
  for (const key of ['previousIntervalDays', 'nextIntervalDays'] as const) {
    if (!Number.isSafeInteger(value[key])) fail(`${path}.${key} must be a safe integer.`);
  }
  for (const key of ['previousEase', 'nextEase'] as const) {
    if ((value[key] as number) < 1.3 || (value[key] as number) > 3) fail(`${path}.${key} must be between 1.3 and 3.`);
  }
  if (value.nextState !== 'new' && value.nextState !== 'suspended' && value.nextDueAt === null)
    fail(`${path}.scheduled next state requires nextDueAt.`);
  return {
    reviewLogId: value.reviewLogId,
    questionId: value.questionId,
    questionMode: (value.questionMode ?? 'as_stored') as ConcreteStudyQuestionMode,
    moduleId: value.moduleId,
    reviewedAt: value.reviewedAt,
    rating: value.rating as ReviewRating,
    result: value.result as AnswerResult,
    previousState: value.previousState as ReviewState,
    nextState: value.nextState as ReviewState,
    previousDueAt: value.previousDueAt as string | null,
    nextDueAt: value.nextDueAt as string | null,
    previousIntervalDays: value.previousIntervalDays as number,
    nextIntervalDays: value.nextIntervalDays as number,
    previousEase: value.previousEase as number,
    nextEase: value.nextEase as number,
    elapsedMs: value.elapsedMs as number,
    ...(value.attemptId !== undefined ? { attemptId: value.attemptId } : {})
  };
}

export function parseStoredAsset(value: unknown, index: number, packIds: Set<string>): StoredPackAsset {
  const path = `importedPackAssets[${index}]`;
  if (!isObject(value)) fail(`${path} must be an object.`);
  if (!nonEmptyString(value.packId) || !packIds.has(value.packId)) fail(`${path}.packId must reference an imported pack.`);
  if (!nonEmptyString(value.path) || !isSafeImageAssetRef(value.path)) fail(`${path}.path must be a safe supported image path.`);
  const expectedMime = IMAGE_MIME_TYPES[extensionOf(value.path)];
  if (typeof value.mimeType !== 'string' || value.mimeType !== expectedMime) fail(`${path}.mimeType does not match the asset extension.`);
  if (typeof value.dataUrl !== 'string' || !isSafeImageDataUrl(value.dataUrl)) fail(`${path}.dataUrl must be a supported image data URL.`);
  if (estimateBase64DecodedBytes(value.dataUrl) > MAX_IMAGE_ASSET_BYTES) fail(`${path}.dataUrl exceeds the per-asset size limit.`);
  if (!value.dataUrl.toLowerCase().startsWith(`data:${expectedMime};base64,`))
    fail(`${path}.dataUrl MIME does not match the asset extension.`);
  const expectedAssetId = packAssetId(value.packId, value.path);
  const legacyAssetId = `${value.packId}:${value.path}`;
  if (value.assetId !== undefined && value.assetId !== expectedAssetId && value.assetId !== legacyAssetId)
    fail(`${path}.assetId does not match packId/path.`);
  return {
    assetId: expectedAssetId,
    packId: value.packId,
    path: value.path,
    mimeType: value.mimeType,
    dataUrl: value.dataUrl
  };
}

export function looksLikeLoopDeckBackup(value: unknown): boolean {
  return isObject(value) && value.format === 'loopdeck3.backup';
}

export function validateBackupPayload(value: unknown): StudyBackup {
  if (!isObject(value)) fail('root must be an object.');
  if (value.format !== 'loopdeck3.backup' || value.schema !== 1) fail('Unsupported backup format or schema.');
  if (!validDate(value.exportedAt)) fail('exportedAt must be a valid date.');

  const attempts = requireArray(value.attempts, 'attempts').map(parseAttempt);
  const bookmarkValues = requireArray(value.bookmarks, 'bookmarks');
  if (!bookmarkValues.every(nonEmptyString)) fail('bookmarks must contain only non-empty strings.');
  const bookmarks = [...bookmarkValues] as string[];

  const rawPacks = requireArray(value.importedPacks, 'importedPacks');
  const importedPacks = rawPacks.map((pack, index) => {
    const result = validatePack(pack);
    if (!result.ok || !result.pack) {
      const detail = result.issues
        .filter((entry) => entry.level === 'error')
        .map((entry) => entry.message)
        .join('; ');
      fail(`importedPacks[${index}] failed pack validation: ${detail || 'invalid pack'}`);
    }
    return result.pack;
  });
  const packIds = new Set(importedPacks.map((pack) => pack.packId));
  if (packIds.size !== importedPacks.length) fail('importedPacks contains duplicate packId values.');

  const importedPackAssets = optionalArray(value.importedPackAssets, 'importedPackAssets').map((asset, index) =>
    parseStoredAsset(asset, index, packIds)
  );
  const reviewCards = optionalArray(value.reviewCards, 'reviewCards').map(parseReviewCard);
  const reviewLogs = optionalArray(value.reviewLogs, 'reviewLogs').map(parseReviewLog);

  requireUnique(attempts, (row) => row.attemptId, 'attempts');
  requireUnique(bookmarks, (row) => row, 'bookmarks');
  requireUnique(importedPackAssets, (row) => row.assetId, 'importedPackAssets');
  requireUnique(reviewCards, (row) => JSON.stringify([row.questionId, row.questionMode]), 'reviewCards');
  requireUnique(reviewLogs, (row) => row.reviewLogId, 'reviewLogs');

  const backup: StudyBackup = {
    format: 'loopdeck3.backup',
    schema: 1,
    exportedAt: value.exportedAt,
    attempts,
    bookmarks,
    importedPacks,
    ...(value.importedPackAssets !== undefined ? { importedPackAssets } : {}),
    ...(value.reviewCards !== undefined ? { reviewCards } : {}),
    ...(value.reviewLogs !== undefined ? { reviewLogs } : {})
  };
  validateBackupRelationships(backup);
  return backup;
}
