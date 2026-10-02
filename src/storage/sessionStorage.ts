import { questionRevision } from '../core/questionRevision';
import { parseAttempt } from './backupValidator';
import { buildChoiceCandidateIndex } from '../core/choiceGenerator';
import { buildWrongAnswerLookupIndexForStudyMode } from '../core/wrongAnswerExplanation';
import type { Attempt, ConcreteStudyQuestionMode, ModuleInfo, Question, StudySettings } from '../core/models';
import { presentQuestionForStudy } from '../core/questionPresentation';
import type { QuizSession } from '../core/sessionEngine';
import { runtimeSettings } from '../core/studySettings';

export interface StoredSessionQuestion {
  questionId: string;
  revision: string;
  questionMode: ConcreteStudyQuestionMode;
}

export interface StoredSession {
  format: 'loopdeck3.session';
  version: 1;
  questions: StoredSessionQuestion[];
  index: number;
  mode: 'normal' | 'review';
  settings: StudySettings;
  startedAt: number;
  currentElapsedMs: number;
  currentHiddenTimeExcludedMs: number;
  attempts: Attempt[];
  savedAt: string;
}

function resumeKey(moduleId: string): string {
  return `loopdeck3.session.${moduleId}`;
}

function isConcreteStudyQuestionMode(value: unknown): value is ConcreteStudyQuestionMode {
  return value === 'as_stored' || value === 'front_to_back' || value === 'back_to_front';
}

export function readStoredSession(moduleId: string, byId: Map<string, Question>): StoredSession | undefined {
  try {
    const raw = localStorage.getItem(resumeKey(moduleId));
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Partial<StoredSession>;
    if (parsed.format !== 'loopdeck3.session' || parsed.version !== 1) return undefined;
    if (!Array.isArray(parsed.questions) || !Number.isSafeInteger(parsed.index) || parsed.index === undefined || parsed.index < 0 || parsed.index > parsed.questions.length)
      return undefined;
    if (
      !parsed.questions.every(
        (item) => item && typeof item.questionId === 'string' && byId.has(item.questionId) && isConcreteStudyQuestionMode(item.questionMode) && item.revision === questionRevision(byId.get(item.questionId) as Question)
      )
    )
      return undefined;
    if (!parsed.settings || typeof parsed.settings !== 'object' || Array.isArray(parsed.settings) || typeof parsed.settings.shuffle !== 'boolean' || typeof parsed.settings.autoNext !== 'boolean') return undefined;
    if (parsed.mode !== 'normal' && parsed.mode !== 'review') return undefined;
    if (typeof parsed.startedAt !== 'number' || !Number.isFinite(parsed.startedAt)) return undefined;
    if (typeof parsed.currentElapsedMs !== 'number' || !Number.isFinite(parsed.currentElapsedMs) || parsed.currentElapsedMs < 0)
      return undefined;
    if (
      typeof parsed.currentHiddenTimeExcludedMs !== 'number' ||
      !Number.isFinite(parsed.currentHiddenTimeExcludedMs) ||
      parsed.currentHiddenTimeExcludedMs < 0
    )
      return undefined;
    if (!Array.isArray(parsed.attempts)) return undefined;
    if (typeof parsed.savedAt !== 'string' || !Number.isFinite(Date.parse(parsed.savedAt))) return undefined;
    parsed.attempts = parsed.attempts.map(parseAttempt);
    if (parsed.attempts.some(attempt => !parsed.questions?.some(question => question.questionId === attempt.questionId))) return undefined;
    return parsed as StoredSession;
  } catch {
    return undefined;
  }
}

export function restoreStoredSession(
  module: ModuleInfo,
  stored: StoredSession,
  byId: Map<string, Question>,
  choicePool: Question[]
): QuizSession | undefined {
  const queue: Question[] = [];
  for (const item of stored.questions) {
    const question = byId.get(item.questionId);
    if (!question || item.revision !== questionRevision(question)) return undefined;
    queue.push(presentQuestionForStudy(question, item.questionMode));
  }
  return {
    module,
    queue,
    choicePool: [...choicePool],
    choiceCandidateIndex: buildChoiceCandidateIndex(choicePool),
    wrongAnswerLookupIndex: buildWrongAnswerLookupIndexForStudyMode(
      choicePool.length ? choicePool : queue,
      stored.settings.questionMode ?? 'as_stored'
    ),
    index: stored.index,
    settings: runtimeSettings(stored.settings),
    startedAt: stored.startedAt,
    currentStartedAt: Date.now(),
    currentElapsedMs: stored.currentElapsedMs,
    currentHiddenTimeExcludedMs: stored.currentHiddenTimeExcludedMs,
    mode: stored.mode,
    attempts: [...stored.attempts]
  };
}

export function saveStoredSession(moduleId: string, session: QuizSession): void {
  const stored: StoredSession = {
    format: 'loopdeck3.session', version: 1,
    questions: session.queue.map((question) => ({
      questionId: question.id,
      revision: questionRevision(session.choicePool.find(source => source.id === question.id) ?? question),
      questionMode: question.activeStudyMode ?? 'as_stored'
    })),
    index: session.index,
    mode: session.mode,
    settings: session.settings,
    startedAt: session.startedAt,
    currentElapsedMs: session.currentElapsedMs,
    currentHiddenTimeExcludedMs: session.currentHiddenTimeExcludedMs,
    attempts: session.attempts,
    savedAt: new Date().toISOString()
  };
  localStorage.setItem(resumeKey(moduleId), JSON.stringify(stored));
}

export function clearStoredSession(moduleId: string): void {
  localStorage.removeItem(resumeKey(moduleId));
}
