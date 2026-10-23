import type { Attempt } from './models';

/** How many recent answers on each side must be correct for a pair to count as overcome. */
export const RIVAL_DEFEAT_STREAK = 3;

export interface RivalPair {
  /** Sorted question ids: [a, b] with a < b. */
  questionIds: [string, string];
  /** Times either question was answered with the other one's answer. */
  confusions: number;
  lastConfusedAt: string;
  /** Both questions were answered correctly in each of their last {@link RIVAL_DEFEAT_STREAK} attempts since the last confusion. */
  defeated: boolean;
  /** When the pair became defeated, if it is. */
  defeatedAt?: string;
}

function pairKey(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

/** Confusions recorded on attempts, grouped into question pairs. */
export function buildRivalPairs(attempts: readonly Attempt[]): RivalPair[] {
  const byPair = new Map<string, { ids: [string, string]; confusions: number; last: string }>();
  for (const attempt of attempts) {
    if (!attempt.confusedWithQuestionId || attempt.contentRetired) continue;
    const ids = pairKey(attempt.questionId, attempt.confusedWithQuestionId);
    const key = JSON.stringify(ids);
    const entry = byPair.get(key) ?? { ids, confusions: 0, last: attempt.answeredAt };
    entry.confusions += 1;
    if (Date.parse(attempt.answeredAt) > Date.parse(entry.last)) entry.last = attempt.answeredAt;
    byPair.set(key, entry);
  }

  const byQuestion = new Map<string, Attempt[]>();
  for (const attempt of attempts) {
    if (attempt.contentRetired || attempt.answerMode === 'flashcard') continue;
    byQuestion.set(attempt.questionId, [...(byQuestion.get(attempt.questionId) ?? []), attempt]);
  }

  return [...byPair.values()]
    .map(({ ids, confusions, last }) => {
      const since = Date.parse(last);
      const streakEnds = ids.map((id) => {
        const after = (byQuestion.get(id) ?? [])
          .filter((attempt) => Date.parse(attempt.answeredAt) > since)
          .sort((a, b) => Date.parse(a.answeredAt) - Date.parse(b.answeredAt));
        const recent = after.slice(-RIVAL_DEFEAT_STREAK);
        return recent.length === RIVAL_DEFEAT_STREAK && recent.every((attempt) => attempt.result === 'correct')
          ? recent[recent.length - 1].answeredAt
          : undefined;
      });
      const defeated = streakEnds.every(Boolean);
      const defeatedAt = defeated ? streakEnds.sort((a, b) => Date.parse(b ?? '') - Date.parse(a ?? ''))[0] : undefined;
      return { questionIds: ids, confusions, lastConfusedAt: last, defeated, ...(defeatedAt ? { defeatedAt } : {}) };
    })
    .sort((a, b) => Date.parse(b.lastConfusedAt) - Date.parse(a.lastConfusedAt));
}

/** Reorders a queue so each unresolved pair whose questions are both present sits side by side. */
export function placeRivalsTogether<T extends { id: string }>(queue: readonly T[], pairs: readonly RivalPair[]): T[] {
  const partner = new Map<string, string>();
  for (const pair of pairs) {
    if (pair.defeated) continue;
    const [a, b] = pair.questionIds;
    if (!partner.has(a) && !partner.has(b)) {
      partner.set(a, b);
      partner.set(b, a);
    }
  }
  const byId = new Map(queue.map((item) => [item.id, item]));
  const placed = new Set<string>();
  const result: T[] = [];
  for (const item of queue) {
    if (placed.has(item.id)) continue;
    result.push(item);
    placed.add(item.id);
    const other = partner.get(item.id);
    const match = other ? byId.get(other) : undefined;
    if (match && !placed.has(match.id)) {
      result.push(match);
      placed.add(match.id);
    }
  }
  return result;
}
