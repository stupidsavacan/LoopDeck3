import type { Attempt, QuizAnswerSource, LoopDeckPack, ReviewCard, ReviewLog } from '../core/models';
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

export interface QuizDataStore {
  recordAnswer(attempt: Attempt, source?: QuizAnswerSource): Promise<void>;
  hasBookmark(questionId: string): Promise<boolean>;
  setBookmark(questionId: string, enabled: boolean): Promise<void>;
}
