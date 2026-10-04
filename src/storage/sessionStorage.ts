import { questionRevision } from '../core/questionRevision';
import { parseAttempt } from './backupValidator';
import { buildChoiceCandidateIndex } from '../core/choiceGenerator';
import { buildWrongAnswerLookupIndexForStudyMode } from '../core/wrongAnswerExplanation';
import type { Attempt, ConcreteStudyQuestionMode, ModuleInfo, Question, StudySettings } from '../core/models';
import { getSupportedStudyQuestionModes, presentQuestionForStudy } from '../core/questionPresentation';
import { elapsedForSession, type QuizSession } from '../core/sessionEngine';
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
  sessionElapsedMs?: number;
  currentElapsedMs: number;
  currentHiddenTimeExcludedMs: number;
  attempts: Attempt[];
  savedAt: string;
  contentIdentity?: string;
  packRevision?: string;
  resetEpoch?: string;
}

export interface SessionStorageScope {
  packId: string;
  contentIdentity: string;
  packRevision?: string;
  resetEpoch?: string;
}

/** Canonical source identity preserves LoopDeck3's per-question revisions too. */
export async function sessionStorageScope(packId: string, module: ModuleInfo, questions: Question[]): Promise<SessionStorageScope> {
  const content = JSON.stringify([module, questions], (_key, value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, record[key]])
    );
  });
  try {
    if (globalThis.crypto?.subtle) {
      const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
      return {
        packId,
        contentIdentity: `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`
      };
    }
  } catch {
    /* Local-file and older WebView contexts may lack Web Crypto. */
  }
  return { packId, contentIdentity: `json:${content}` };
}

export function sessionStorageKey(moduleId: string, scope?: SessionStorageScope): string {
  return `loopdeck3.session.${scope ? JSON.stringify([scope.packId, moduleId]) : moduleId}`;
}

function validSettings(value: unknown): value is StudySettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const settings = value as Record<string, unknown>;
  if (typeof settings.shuffle !== 'boolean' || typeof settings.autoNext !== 'boolean') return false;
  if (
    settings.questionLimit !== 'all' &&
    !(typeof settings.questionLimit === 'number' && Number.isSafeInteger(settings.questionLimit) && settings.questionLimit > 0)
  )
    return false;
  for (const key of ['autoRevealAfterIdle', 'showExample', 'showNumber', 'showCategory']) {
    if (settings[key] !== undefined && typeof settings[key] !== 'boolean') return false;
  }
  for (const key of ['selectedRange', 'selectedCategory']) {
    if (settings[key] !== undefined && typeof settings[key] !== 'string') return false;
  }
  const optionalEnum = (item: unknown, options: string[]) => item === undefined || (typeof item === 'string' && options.includes(item));
  return (
    optionalEnum(settings.filter, ['all', 'wrong', 'bookmarked']) &&
    optionalEnum(settings.answerFormat, ['auto', 'choice', 'input', 'flashcard']) &&
    optionalEnum(settings.questionMode, ['as_stored', 'front_to_back', 'back_to_front', 'mixed'])
  );
}

function isConcreteStudyQuestionMode(value: unknown): value is ConcreteStudyQuestionMode {
  return value === 'as_stored' || value === 'front_to_back' || value === 'back_to_front';
}

export function readStoredSession(moduleId: string, byId: Map<string, Question>, scope?: SessionStorageScope): StoredSession | undefined {
  try {
    const raw = localStorage.getItem(sessionStorageKey(moduleId, scope));
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Partial<StoredSession>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    if (scope && parsed.contentIdentity !== scope.contentIdentity) return undefined;
    if (scope?.packRevision !== undefined && parsed.packRevision !== scope.packRevision) return undefined;
    if (scope?.resetEpoch !== undefined && parsed.resetEpoch !== scope.resetEpoch) return undefined;
    if (parsed.format !== 'loopdeck3.session' || parsed.version !== 1) return undefined;
    if (
      !Array.isArray(parsed.questions) ||
      !parsed.questions.length ||
      !Number.isSafeInteger(parsed.index) ||
      parsed.index === undefined ||
      parsed.index < 0 ||
      parsed.index > parsed.questions.length
    )
      return undefined;
    if (
      !parsed.questions.every((item) => {
        if (!item || typeof item.questionId !== 'string' || !isConcreteStudyQuestionMode(item.questionMode)) return false;
        const question = byId.get(item.questionId);
        return (
          question?.moduleId === moduleId &&
          getSupportedStudyQuestionModes(question).includes(item.questionMode) &&
          item.revision === questionRevision(question)
        );
      })
    )
      return undefined;
    if (new Set(parsed.questions.map((item) => item.questionId)).size !== parsed.questions.length || !validSettings(parsed.settings))
      return undefined;
    if (parsed.mode !== 'normal' && parsed.mode !== 'review') return undefined;
    if (typeof parsed.startedAt !== 'number' || !Number.isFinite(parsed.startedAt) || parsed.startedAt < 0) return undefined;
    if (
      parsed.sessionElapsedMs !== undefined &&
      (typeof parsed.sessionElapsedMs !== 'number' || !Number.isFinite(parsed.sessionElapsedMs) || parsed.sessionElapsedMs < 0)
    )
      return undefined;
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
    if (
      parsed.attempts.some(
        (attempt) => attempt.moduleId !== moduleId || !parsed.questions?.some((question) => question.questionId === attempt.questionId)
      )
    )
      return undefined;
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
    sessionElapsedMs:
      stored.sessionElapsedMs ??
      stored.attempts.reduce((sum, attempt) => sum + Math.max(0, attempt.elapsedMs), 0) + stored.currentElapsedMs,
    sessionSegmentStartedAt: Date.now(),
    currentStartedAt: Date.now(),
    currentElapsedMs: stored.currentElapsedMs,
    currentHiddenTimeExcludedMs: stored.currentHiddenTimeExcludedMs,
    mode: stored.mode,
    attempts: [...stored.attempts]
  };
}

export function saveStoredSession(moduleId: string, session: QuizSession, scope?: SessionStorageScope): boolean {
  const stored: StoredSession = {
    format: 'loopdeck3.session',
    version: 1,
    questions: session.queue.map((question) => ({
      questionId: question.id,
      revision: questionRevision(session.choicePool.find((source) => source.id === question.id) ?? question),
      questionMode: question.activeStudyMode ?? 'as_stored'
    })),
    index: session.index,
    mode: session.mode,
    settings: session.settings,
    startedAt: session.startedAt,
    sessionElapsedMs: elapsedForSession(session),
    currentElapsedMs: session.currentElapsedMs,
    currentHiddenTimeExcludedMs: session.currentHiddenTimeExcludedMs,
    attempts: session.attempts,
    savedAt: new Date().toISOString(),
    ...(scope ? { contentIdentity: scope.contentIdentity, packRevision: scope.packRevision, resetEpoch: scope.resetEpoch } : {})
  };
  try {
    localStorage.setItem(sessionStorageKey(moduleId, scope), JSON.stringify(stored));
    return true;
  } catch {
    return false;
  }
}

export function clearStoredSession(moduleId: string, scope?: SessionStorageScope): boolean {
  try {
    localStorage.removeItem(sessionStorageKey(moduleId, scope));
    return true;
  } catch {
    return false;
  }
}
