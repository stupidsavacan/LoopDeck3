import { loadBuiltinPacks } from '../packs/builtinLoader';
import { getQuestionsForModule, resolveActivePacks } from '../packs/packResolver';
import { questionIdentity } from './packLearningState';
import { readContentEpoch } from './packEpoch';
import { exportBackup } from './backupExport';
import { recoverReviewCard, recoverReviewRows } from './reviewRecovery';
import { buildReviewPersistence } from '../core/reviewPersistence';
import type { Attempt, ConcreteStudyQuestionMode, LoopDeckPack, QuizAnswerSource, ReviewCard, ReviewLog } from '../core/models';
import type { ImportedPackAsset, PackAssetWriteStrategy } from '../packs/packTypes';

import { database, type LocalDatabase } from './indexedDb';
import {
  installedOrder,
  installedRevision,
  savePackWithAssets,
  deletePackAndAssets,
  validatedPackForStorage,
  recoverStoredPacks,
  packAssetId
} from './packStorage';
import { importBackup } from './backupStorage';
import { notifyPackChanges, subscribePackChanges } from './packChanges';
import type { BackupImportMode } from './storageTypes';

import type { StudyBackup, StoredPackAsset } from './storageTypes';

async function deleteAttemptsByResult(database: LocalDatabase, results: Attempt['result'][]): Promise<void> {
  await database.transact('attempts', 'readwrite', (tx) => {
    const store = tx.objectStore('attempts');
    const index = store.index('byResult');
    for (const result of results) {
      const request = index.openKeyCursor(IDBKeyRange.only(result));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        store.delete(cursor.primaryKey);
        cursor.continue();
      };
    }
  });
}

export class StudyRepository {
  constructor(private readonly data: LocalDatabase = database) {}
  subscribePackChanges(onChange: () => void): () => void {
    return subscribePackChanges(this.data.identity, onChange);
  }
  async addAttempt(attempt: Attempt): Promise<void> {
    await this.data.request('attempts', 'readwrite', (store) => store.put(attempt));
  }
  async recordAnswer(attempt: Attempt, source?: QuizAnswerSource): Promise<void> {
    let failure: unknown;
    try {
      await this.data.transact(
        ['attempts', 'reviewCards', 'reviewLogs', ...(source ? (['packs', 'packAssets', 'contentMetadata'] as const) : [])],
        'readwrite',
        (tx) => {
          const abort = (error: unknown) => {
            failure = error;
            tx.abort();
          };
          const attempts = tx.objectStore('attempts');
          const cards = tx.objectStore('reviewCards');
          const saveAnswer = () => {
            const existing = attempts.get(attempt.attemptId);
            existing.onsuccess = () => {
              try {
                if (existing.result) return;
                const current = cards.get([attempt.questionId, attempt.questionMode ?? 'as_stored']);
                current.onsuccess = () => {
                  try {
                    let recovered: ReviewCard | undefined;
                    if (current.result) {
                      try {
                        recovered = recoverReviewCard(current.result);
                      } catch (error) {
                        console.warn('Replacing an unrecoverable stored review card.', attempt.questionId, error);
                      }
                    }
                    const { card, log } = buildReviewPersistence(attempt, recovered);
                    attempts.add(attempt);
                    cards.put(card);
                    tx.objectStore('reviewLogs').add(log);
                  } catch (error) {
                    abort(error);
                  }
                };
              } catch (error) {
                abort(error);
              }
            };
          };
          if (!source) {
            saveAnswer();
            return;
          }
          const packs = tx.objectStore('packs').getAll();
          const epoch = tx.objectStore('contentMetadata').get('contentEpoch');
          epoch.onsuccess = () => {
            try {
              const rows = packs.result.sort((a, b) => installedOrder(a) - installedOrder(b));
              const active = resolveActivePacks([...loadBuiltinPacks(), ...recoverStoredPacks(rows)]);
              const current = getQuestionsForModule(active, source.question.moduleId).find((q) => q.id === source.question.id);
              const stale = () => abort(new Error('教材が変更されたため、この回答を保存できません。教材を開き直してください。'));
              if (
                !current ||
                active.modulePackIdById.get(source.question.moduleId) !== source.packId ||
                attempt.questionId !== source.question.id ||
                attempt.moduleId !== source.question.moduleId ||
                questionIdentity(current) !== questionIdentity(source.question) ||
                (source.packRevision !== undefined &&
                  installedRevision(rows.find((row) => row.packId === source.packId)) !== source.packRevision) ||
                (source.resetEpoch !== undefined && readContentEpoch(epoch.result) !== source.resetEpoch)
              ) {
                stale();
                return;
              }
              if (source.imageDataUrl === undefined) {
                saveAnswer();
                return;
              }
              const image = tx.objectStore('packAssets').get(packAssetId(source.packId, source.question.imageAsset ?? ''));
              image.onsuccess = () => {
                if ((image.result?.dataUrl ?? null) !== source.imageDataUrl) stale();
                else saveAnswer();
              };
            } catch (error) {
              abort(error);
            }
          };
        }
      );
    } catch (error) {
      throw failure ?? error;
    }
  }
  async getAttempts(): Promise<Attempt[]> {
    return (await this.data.all<Attempt>('attempts')).filter((row) => !row.contentRetired);
  }
  async clearAttempts(): Promise<void> {
    await this.data.request('attempts', 'readwrite', (store) => store.clear());
  }
  async clearWrongAttempts(): Promise<void> {
    await deleteAttemptsByResult(this.data, ['wrong', 'revealed']);
  }
  async setBookmark(questionId: string, enabled: boolean): Promise<void> {
    if (enabled)
      await this.data.request('bookmarks', 'readwrite', (store) => store.put({ questionId, createdAt: new Date().toISOString() }));
    else await this.data.request('bookmarks', 'readwrite', (store) => store.delete(questionId));
  }
  async getBookmarks(): Promise<string[]> {
    return (await this.data.all<{ questionId: string }>('bookmarks')).map((row) => row.questionId);
  }
  async hasBookmark(questionId: string): Promise<boolean> {
    return Boolean(await this.data.request<{ questionId: string }>('bookmarks', 'readonly', (store) => store.get(questionId)));
  }
  async clearBookmarks(): Promise<void> {
    await this.data.request('bookmarks', 'readwrite', (store) => store.clear());
  }
  async saveImportedPack(pack: LoopDeckPack): Promise<void> {
    const normalized = validatedPackForStorage(pack);
    await savePackWithAssets(this.data, normalized, [], 'upsert');
    notifyPackChanges(this.data.identity);
  }
  async saveImportedPackWithAssets(pack: LoopDeckPack, assets: ImportedPackAsset[], strategy: PackAssetWriteStrategy): Promise<void> {
    await savePackWithAssets(this.data, validatedPackForStorage(pack), assets, strategy);
    notifyPackChanges(this.data.identity);
  }
  async getImportedPacks(): Promise<LoopDeckPack[]> {
    const rows = await this.data.all<unknown>('packs');
    return recoverStoredPacks(rows.sort((left, right) => installedOrder(left) - installedOrder(right)));
  }
  async getImportedPackRevisions(): Promise<ReadonlyMap<string, string>> {
    const requests = await this.data.transact(['packs', 'contentMetadata'], 'readonly', (tx) => ({
      packs: tx.objectStore('packs').getAll(),
      epoch: tx.objectStore('contentMetadata').get('contentEpoch')
    }));
    return new Map([
      ...requests.packs.result.map((row) => [row.packId, installedRevision(row)] as [string, string]),
      ['', readContentEpoch(requests.epoch.result)]
    ]);
  }
  async getImportedPackAssets(): Promise<StoredPackAsset[]> {
    return this.data.all<StoredPackAsset>('packAssets');
  }
  async getPackAsset(packId: string, path: string): Promise<StoredPackAsset | undefined> {
    return (await this.data.request<StoredPackAsset>('packAssets', 'readonly', (store) => store.get(packAssetId(packId, path)))) as
      StoredPackAsset | undefined;
  }
  async deleteImportedPack(packId: string): Promise<void> {
    await deletePackAndAssets(this.data, packId);
    notifyPackChanges(this.data.identity);
  }
  async getReviewCards(): Promise<ReviewCard[]> {
    const rows: ReviewCard[] = [];
    await this.data.transact('reviewCards', 'readwrite', (tx) => recoverReviewRows(tx.objectStore('reviewCards'), rows));
    return rows;
  }
  async getReviewCard(questionId: string, questionMode: ConcreteStudyQuestionMode = 'as_stored'): Promise<ReviewCard | undefined> {
    const rows: ReviewCard[] = [];
    await this.data.transact('reviewCards', 'readwrite', (tx) => {
      const store = tx.objectStore('reviewCards');
      recoverReviewRows(store, rows, store, IDBKeyRange.only([questionId, questionMode]));
    });
    return rows[0];
  }
  async putReviewCard(card: ReviewCard): Promise<void> {
    await this.data.request('reviewCards', 'readwrite', (store) => store.put(recoverReviewCard(card)));
  }
  async putReviewLog(log: ReviewLog): Promise<void> {
    await this.data.request('reviewLogs', 'readwrite', (store) => store.put({ ...log, questionMode: log.questionMode ?? 'as_stored' }));
  }
  async getReviewLogs(): Promise<ReviewLog[]> {
    const rows: ReviewLog[] = [];
    await this.data.transact('reviewLogs', 'readwrite', (tx) => recoverReviewRows(tx.objectStore('reviewLogs'), rows));
    return rows;
  }
  async getReviewLogsForQuestion(questionId: string): Promise<ReviewLog[]> {
    const rows: ReviewLog[] = [];
    await this.data.transact('reviewLogs', 'readwrite', (tx) => {
      const store = tx.objectStore('reviewLogs');
      recoverReviewRows(store, rows, store.index('byQuestionId'), IDBKeyRange.only(questionId));
    });
    return rows.sort((a, b) => Date.parse(a.reviewedAt) - Date.parse(b.reviewedAt));
  }
  async clearReviewData(): Promise<void> {
    await this.data.transact(['reviewCards', 'reviewLogs'], 'readwrite', (tx) => {
      tx.objectStore('reviewCards').clear();
      tx.objectStore('reviewLogs').clear();
    });
  }
  async exportSnapshot(): Promise<StudyBackup> {
    return exportBackup(this.data);
  }
  async restoreSnapshot(backup: unknown, mode: BackupImportMode): Promise<void> {
    await importBackup(this.data, backup, mode);
    notifyPackChanges(this.data.identity);
  }
}
export const studyStore = new StudyRepository();
