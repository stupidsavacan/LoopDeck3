import { isNearMissAnswer, judgeQuestion } from './answerJudge';
import type { AnswerConfidence, AnswerFormat, Attempt, Question } from './models';
import { buildQuizAttempt } from './quizAnswer';
import type { AnswerSignals } from './reviewEngine';
import { advanceSession, elapsedForCurrent, elapsedForSession, type QuizSession } from './sessionEngine';

export type QuizPhase = 'answering' | 'pending' | 'saving' | 'failed' | 'saved' | 'advanced' | 'disposed';
export interface QuizControllerOptions {
  session: QuizSession;
  question: Question;
  answerMode: AnswerFormat;
  isCurrent(): boolean;
  persist(attempt: Attempt): Promise<unknown>;
  onAdvance(session: QuizSession): void;
  onCheckpoint?(session: QuizSession): void;
  onCheckpointError(error: unknown): void;
  onPersistenceChange(phase: 'saving' | 'failed' | 'saved', error?: unknown): void;
  /** A correct answer will move on by itself after `delayMs` unless the learner holds it. */
  onAutoAdvanceScheduled?(delayMs: number): void;
}

/** Long enough to see the result and reach for the explanation before the next question replaces it. */
export const AUTO_ADVANCE_DELAY_MS = 1400;

/** One question's state machine. No DOM, IndexedDB or screen dependency. */
export class QuizController {
  private state: QuizPhase = 'answering';
  private attempt: Attempt | undefined;
  private hiddenSince: number | undefined;
  private excludedMs = 0;
  private autoNext: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly options: QuizControllerOptions) {}
  get phase(): QuizPhase {
    return this.state;
  }
  get canAnswer(): boolean {
    return this.state === 'answering' && this.options.isCurrent();
  }

  private excluded(now = Date.now()): number {
    return this.excludedMs + (this.hiddenSince === undefined ? 0 : Math.max(0, now - this.hiddenSince));
  }
  checkpoint(): void {
    if (!this.options.isCurrent() || (this.state !== 'answering' && this.state !== 'saved')) return;
    const now = Date.now();
    const session = this.options.session;
    const sessionElapsedMs = elapsedForSession(session, this.excluded(now), now);
    if (this.state === 'saved') {
      this.options.onCheckpoint?.(advanceSession(session, this.attempt, sessionElapsedMs));
      return;
    }
    this.options.onCheckpoint?.({
      ...session,
      sessionElapsedMs,
      sessionSegmentStartedAt: now,
      currentElapsedMs: elapsedForCurrent(session, this.excluded(now)),
      currentStartedAt: now,
      currentHiddenTimeExcludedMs: session.currentHiddenTimeExcludedMs + this.excluded(now)
    });
  }
  setHidden(hidden: boolean): void {
    if (!this.options.isCurrent() || this.state === 'advanced' || this.state === 'disposed') return;
    const now = Date.now();
    if (hidden) {
      this.checkpoint();
      this.hiddenSince ??= now;
    } else if (this.hiddenSince !== undefined) {
      this.excludedMs += Math.max(0, now - this.hiddenSince);
      this.hiddenSince = undefined;
    }
  }
  excludeSuspension(elapsed: number): void {
    if (!this.options.isCurrent() || this.state === 'advanced' || this.state === 'disposed') return;
    this.excludedMs += elapsed;
    this.checkpoint();
  }
  /** `confusedWithQuestionId` is kept only when the answer turns out wrong; confidence only for real answers. */
  answer(
    input: string | string[],
    revealed = false,
    extras: { confusedWithQuestionId?: string; confidence?: AnswerConfidence } & AnswerSignals = {}
  ): Attempt | undefined {
    if (!this.canAnswer) return undefined;
    const { question } = this.options;
    const { confusedWithQuestionId } = extras;
    const nearMiss = !revealed && typeof input === 'string' && question.type !== 'multi_select' && isNearMissAnswer(question, input);
    const result = revealed ? 'revealed' : judgeQuestion(question, input) ? 'correct' : 'wrong';
    const attempt = this.record(
      result,
      revealed ? '' : Array.isArray(input) ? [...input] : input,
      nearMiss,
      revealed ? undefined : extras.confidence,
      { readingChars: extras.readingChars, hintUsed: revealed ? undefined : extras.hintUsed }
    );
    if (result === 'wrong' && confusedWithQuestionId && confusedWithQuestionId !== question.id) {
      attempt.confusedWithQuestionId = confusedWithQuestionId;
    }
    return attempt;
  }
  gradeFlashcard(known: boolean): Attempt | undefined {
    if (!this.canAnswer || this.options.answerMode !== 'flashcard') return undefined;
    return this.record(known ? 'correct' : 'wrong', '', false);
  }
  private record(
    result: Attempt['result'],
    input: string | string[],
    nearMiss: boolean,
    confidence?: AnswerConfidence,
    signals: AnswerSignals = {}
  ): Attempt {
    const { question, session, answerMode } = this.options;
    this.attempt = buildQuizAttempt(
      question,
      result,
      input,
      elapsedForCurrent(session, this.excluded()),
      session.mode,
      answerMode,
      session.currentHiddenTimeExcludedMs + this.excluded(),
      nearMiss,
      confidence,
      signals
    );
    this.state = 'pending';
    return this.attempt;
  }
  async save(): Promise<void> {
    if (!this.attempt || (this.state !== 'pending' && this.state !== 'failed') || !this.options.isCurrent()) return;
    this.state = 'saving';
    this.options.onPersistenceChange('saving');
    try {
      await this.options.persist(this.attempt);
    } catch (error) {
      if (this.phase === 'disposed' || !this.options.isCurrent()) return;
      this.state = 'failed';
      this.options.onPersistenceChange('failed', error);
      return;
    }
    if (this.phase === 'disposed' || !this.options.isCurrent()) return;
    this.state = 'saved';
    try {
      this.checkpoint();
    } catch (error) {
      this.options.onCheckpointError(error);
    }
    if (this.state !== 'saved' || !this.options.isCurrent()) return;
    this.options.onPersistenceChange('saved');
    if (
      this.phase === 'saved' &&
      this.options.isCurrent() &&
      this.options.answerMode !== 'flashcard' &&
      this.attempt.result === 'correct' &&
      this.options.session.settings.autoNext
    ) {
      this.autoNext = setTimeout(() => this.advance(), AUTO_ADVANCE_DELAY_MS);
      this.options.onAutoAdvanceScheduled?.(AUTO_ADVANCE_DELAY_MS);
    }
  }
  /** The learner is reading or acting on the result, so only their own tap moves on. */
  holdAutoAdvance(): boolean {
    if (this.autoNext === undefined) return false;
    this.clearTimer();
    return true;
  }
  advance(): void {
    if (this.state !== 'saved' || !this.options.isCurrent()) return;
    this.clearTimer();
    this.state = 'advanced';
    this.options.onAdvance(advanceSession(this.options.session, this.attempt, elapsedForSession(this.options.session, this.excluded())));
  }
  private clearTimer(): void {
    if (this.autoNext !== undefined) clearTimeout(this.autoNext);
    this.autoNext = undefined;
  }
  dispose(): void {
    this.clearTimer();
    this.state = 'disposed';
  }
}
