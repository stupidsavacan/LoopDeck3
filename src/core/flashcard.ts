import { restartSessionRound, type QuizSession } from './sessionEngine';

export type FlashcardGesture = 'flip' | 'known' | 'again' | 'none';

export function resolveFlashcardGesture(dx: number, dy: number, duration: number, moved: boolean): FlashcardGesture {
  const dt = Math.max(1, duration);
  const tap = !moved && Math.hypot(dx, dy) < 9 && dt < 500;
  // A tap's tiny coordinate jitter and vertical scrolling must not self-grade a card.
  if (!tap && Math.abs(dx) > Math.abs(dy) && (Math.abs(dx) > 105 || Math.abs(dx / dt) > 0.68)) return dx > 0 ? 'known' : 'again';
  return tap ? 'flip' : 'none';
}

/** Preserve the round's concrete queue directions, including mixed and explicit sides. */
export function restartFlashcardSession(session: QuizSession, onlyAgain: boolean, now = Date.now()): QuizSession {
  return restartSessionRound(session, onlyAgain ? (attempt) => attempt.result === 'wrong' : undefined, now);
}
