import { questionRevision as questionIdentity } from '../core/questionRevision';
import type { LoopDeckPack } from '../core/models';
import { loadBuiltinPacks } from '../packs/builtinLoader';
import { resolveActivePacks } from '../packs/packResolver';

const LEARNING_STORES = ['attempts', 'bookmarks', 'reviewCards', 'reviewLogs'] as const;
export const PACK_LIFECYCLE_STORES = ['packs', 'packAssets', ...LEARNING_STORES] as const;

export { questionRevision as questionIdentity } from '../core/questionRevision';

/** Keep historical answers in backups without attaching them to reused content IDs. */
export function retiredQuestionIds(previous: LoopDeckPack[], next: LoopDeckPack[]): Set<string> {
  const before = resolveActivePacks([...loadBuiltinPacks(), ...previous]);
  const after = resolveActivePacks([...loadBuiltinPacks(), ...next]);
  const retired = new Set(
    before.questions
      .filter((question) => {
        const replacement = after.questionById.get(question.id);
        return (
          !replacement ||
          before.questionPackIdById.get(question.id) !== after.questionPackIdById.get(question.id) ||
          questionIdentity(question) !== questionIdentity(replacement)
        );
      })
      .map((question) => question.id)
  );
  // A newly activated ID may already have orphan history from older app versions.
  // No current learning state exists for that content before this installation.
  for (const question of after.questions) if (!before.questionById.has(question.id)) retired.add(question.id);
  return retired;
}

export function reconcilePackLearningState(tx: IDBTransaction, previous: LoopDeckPack[], next: LoopDeckPack[]): void {
  retireQuestionLearningState(tx, retiredQuestionIds(previous, next));
}

export function retireQuestionLearningState(tx: IDBTransaction, retiredIds: Set<string>, onComplete?: () => void): void {
  if (!retiredIds.size) {
    onComplete?.();
    return;
  }
  let remaining = LEARNING_STORES.length;
  for (const name of LEARNING_STORES) {
    const request = tx.objectStore(name).openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        remaining -= 1;
        if (!remaining) onComplete?.();
        return;
      }
      if (retiredIds.has(cursor.value.questionId)) {
        if (name === 'attempts') cursor.update({ ...cursor.value, contentRetired: true });
        else cursor.delete();
      }
      cursor.continue();
    };
  }
}
