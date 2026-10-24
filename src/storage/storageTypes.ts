import type { Attempt, QuizAnswerSource, LoopDeckPack, ReviewCard, ReviewLog } from '../core/models';
import type { CorrectRating } from '../core/scheduler';
import type { ImportedPackAsset } from '../packs/packTypes';

export interface StoredPackAsset extends ImportedPackAsset {
  assetId: string;
}

export interface StudyBackup {
  format: 'loopdeck3.backup';
  schema: 1;
  exportedAt: string;
  attempts: Attempt[];
  bookmarks: string[];
  importedPacks: LoopDeckPack[];
  importedPackAssets?: StoredPackAsset[];
  reviewCards?: ReviewCard[];
  reviewLogs?: ReviewLog[];
}

export type BackupImportMode = 'merge' | 'replace';

/** The review schedule an answer produced; absent when the answer had already been saved. */
export interface SavedReview {
  card: ReviewCard;
  log: ReviewLog;
}

export interface QuizDataStore {
  recordAnswer(attempt: Attempt, source?: QuizAnswerSource): Promise<SavedReview | void>;
  /** Replaces the inferred rating of a correct answer with the learner's own. */
  reviseAnswerRating?(attemptId: string, rating: CorrectRating): Promise<SavedReview>;
  hasBookmark(questionId: string): Promise<boolean>;
  setBookmark(questionId: string, enabled: boolean): Promise<void>;
}
