import { buildChoiceCandidateIndex } from '../core/choiceGenerator';
import { buildWrongAnswerLookupIndexForStudyMode } from '../core/wrongAnswerExplanation';
import type { Attempt, ConcreteStudyQuestionMode, ModuleInfo, Question, StudySettings } from '../core/models';
import { presentQuestionForStudy, resolveConcreteStudyQuestionMode } from '../core/questionPresentation';
import type { QuizSession } from '../core/sessionEngine';
import { runtimeSettings } from '../core/studySettings';

export interface StoredSessionQuestion {
  questionId: string;
  questionMode: ConcreteStudyQuestionMode;
}

export interface StoredSession {
  version: 2;
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

interface LegacyStoredSession {
  questionIds: string[];
  index: number;
  mode: 'normal' | 'review';
  settings: StudySettings;
  savedAt: string;
}

function resumeKey(moduleId: string): string {
  return `loopdeck3_session_${moduleId}`;
}

function isConcreteStudyQuestionMode(value: unknown): value is ConcreteStudyQuestionMode {
  return value === 'as_stored' || value === 'front_to_back' || value === 'back_to_front';
}

function normalizeLegacyStoredSession(parsed: LegacyStoredSession, byId: Map<string, Question>): StoredSession | undefined {
  if (!Array.isArray(parsed.questionIds) || parsed.index < 0 || parsed.index >= parsed.questionIds.length) return undefined;
  if (!parsed.questionIds.every((id) => typeof id === 'string' && byId.has(id))) return undefined;
  if (!parsed.settings || typeof parsed.settings !== 'object') return undefined;
  if (parsed.settings.questionMode === 'mixed') return undefined;
  const requestedMode = parsed.settings.questionMode ?? 'as_stored';
  const questions = parsed.questionIds.map((questionId) => {
    const question = byId.get(questionId);
    if (!question) throw new Error('Stored question is unavailable.');
    return { questionId, questionMode: resolveConcreteStudyQuestionMode(question, requestedMode) };
  });
  const parsedSavedAt = Date.parse(parsed.savedAt);
  return {
    version: 2,
    questions,
    index: parsed.index,
    mode: parsed.mode,
    settings: parsed.settings,
    startedAt: Number.isFinite(parsedSavedAt) ? parsedSavedAt : Date.now(),
    currentElapsedMs: 0,
    currentHiddenTimeExcludedMs: 0,
    attempts: [],
    savedAt: parsed.savedAt
  };
}

export function readStoredSession(moduleId: string, byId: Map<string, Question>): StoredSession | undefined {
  try {
    const raw = localStorage.getItem(resumeKey(moduleId));
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Partial<StoredSession> & Partial<LegacyStoredSession>;
    if (parsed.version !== 2) return normalizeLegacyStoredSession(parsed as LegacyStoredSession, byId);
    if (!Array.isArray(parsed.questions) || typeof parsed.index !== 'number' || parsed.index < 0 || parsed.index > parsed.questions.length)
      return undefined;
    if (
      !parsed.questions.every(
        (item) => item && typeof item.questionId === 'string' && byId.has(item.questionId) && isConcreteStudyQuestionMode(item.questionMode)
      )
    )
      return undefined;
    if (!parsed.settings || typeof parsed.settings !== 'object') return undefined;
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
    if (typeof parsed.savedAt !== 'string') return undefined;
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
    if (!question) return undefined;
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
    version: 2,
    questions: session.queue.map((question) => ({
      questionId: question.id,
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

