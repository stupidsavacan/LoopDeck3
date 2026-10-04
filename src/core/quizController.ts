import { isNearMissAnswer, judgeQuestion } from './answerJudge';
import type { AnswerFormat, Attempt, Question } from './models';
import { buildQuizAttempt } from './quizAnswer';
import { advanceSession, elapsedForCurrent, elapsedForSession, type QuizSession } from './sessionEngine';

export type QuizPhase = 'answering' | 'pending' | 'saving' | 'failed' | 'saved' | 'advanced' | 'disposed';
export interface QuizControllerOptions {
  session: QuizSession;
  question: Question;
  answerMode: AnswerFormat;
  isCurrent(): boolean;
  persist(attempt: Attempt): Promise<void>;
  onAdvance(session: QuizSession): void;
  onCheckpoint?(session: QuizSession): void;
  onCheckpointError(error: unknown): void;
  onPersistenceChange(phase: 'saving' | 'failed' | 'saved', error?: unknown): void;
}

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
  answer(input: string | string[], revealed = false): Attempt | undefined {
    if (!this.canAnswer) return undefined;
    const { question, session, answerMode } = this.options;
    const nearMiss = !revealed && typeof input === 'string' && question.type !== 'multi_select' && isNearMissAnswer(question, input);
    const result = revealed ? 'revealed' : judgeQuestion(question, input) ? 'correct' : 'wrong';
    this.attempt = buildQuizAttempt(
      question,
      result,
      revealed ? '' : Array.isArray(input) ? [...input] : input,
      elapsedForCurrent(session, this.excluded()),
      session.mode,
      answerMode,
      session.currentHiddenTimeExcludedMs + this.excluded(),
      nearMiss
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
    if (this.phase === 'saved' && this.options.isCurrent() && this.attempt.result === 'correct' && this.options.session.settings.autoNext)
      this.autoNext = setTimeout(() => this.advance(), 650);
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
