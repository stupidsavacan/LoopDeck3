import type { ModuleInfo, ReviewCard } from './models';

/** How well a question is held, judged from its review cards only. */
export type MasteryLevel = 'unseen' | 'weak' | 'learning' | 'solid';

/** A review interval of a week or more counts as solidly learned. */
export const SOLID_INTERVAL_DAYS = 7;

const RANK: Record<MasteryLevel, number> = { unseen: 0, weak: 1, learning: 2, solid: 3 };

export function cardMasteryLevel(card: ReviewCard): MasteryLevel {
  if (card.state === 'mastered') return 'solid';
  if (card.state === 'relearning' || card.state === 'leech' || card.wrongStreak > 0) return 'weak';
  if (card.state === 'review' && card.intervalDays >= SOLID_INTERVAL_DAYS) return 'solid';
  return 'learning';
}

/** A question studied in several directions counts by its best direction. */
export function questionMasteryLevel(cards: readonly ReviewCard[] | undefined): MasteryLevel {
  let best: MasteryLevel = 'unseen';
  for (const card of cards ?? []) {
    const level = cardMasteryLevel(card);
    if (RANK[level] > RANK[best]) best = level;
  }
  return best;
}

export function indexCardsByQuestion(cards: readonly ReviewCard[]): Map<string, ReviewCard[]> {
  const byQuestion = new Map<string, ReviewCard[]>();
  for (const card of cards) {
    const list = byQuestion.get(card.questionId);
    if (list) list.push(card);
    else byQuestion.set(card.questionId, [card]);
  }
  return byQuestion;
}

export interface ModuleMastery {
  total: number;
  counts: Record<MasteryLevel, number>;
  /** 0–1: solid questions count fully, learning ones half. */
  ratio: number;
}

export function moduleMastery(module: Pick<ModuleInfo, 'questionIds'>, cardsByQuestion: ReadonlyMap<string, ReviewCard[]>): ModuleMastery {
  const counts: Record<MasteryLevel, number> = { unseen: 0, weak: 0, learning: 0, solid: 0 };
  for (const questionId of new Set(module.questionIds)) counts[questionMasteryLevel(cardsByQuestion.get(questionId))] += 1;
  const total = counts.unseen + counts.weak + counts.learning + counts.solid;
  return { total, counts, ratio: total ? (counts.solid + counts.learning * 0.5) / total : 0 };
}
