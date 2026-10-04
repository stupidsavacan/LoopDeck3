import { buildChoiceCandidateIndex, type ChoiceCandidateIndex } from './choiceGenerator';
import type { Attempt, ModuleInfo, Question, QuizAnswerSource, StudySettings } from './models';
import { decodeStudyCategory } from './studyCategory';
import { getSupportedStudyQuestionModes, presentQuestionForStudy, resolveConcreteStudyQuestionMode } from './questionPresentation';
import { buildWrongAnswerLookupIndexForStudyMode, type WrongAnswerLookupIndex } from './wrongAnswerExplanation';

export interface QuizSession {
  module: ModuleInfo;
  queue: Question[];
  choicePool: Question[];
  sourceByQuestionId?: ReadonlyMap<string, QuizAnswerSource>;
  choiceCandidateIndex: ChoiceCandidateIndex;
  wrongAnswerLookupIndex: WrongAnswerLookupIndex;
  index: number;
  settings: StudySettings;
  startedAt: number;
  sessionElapsedMs?: number;
  sessionSegmentStartedAt?: number;
  currentStartedAt: number;
  currentElapsedMs: number;
  currentHiddenTimeExcludedMs: number;
  mode: 'normal' | 'review';
  attempts: Attempt[];
}

export interface StudyRangeOption {
  value: string;
  label: string;
}
export interface StudySelectionContext {
  wrongQuestionIds?: Iterable<string>;
  bookmarkedQuestionIds?: Iterable<string>;
}

function shuffle<T>(items: T[]): T[] {
  const copied = [...items];
  for (let i = copied.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copied[i], copied[j]] = [copied[j], copied[i]];
  }
  return copied;
}

function idSet(values?: Iterable<string>): Set<string> | undefined {
  return values ? new Set(values) : undefined;
}
function questionOrdinal(question: Question, index: number): number {
  return typeof question.number === 'number' && Number.isSafeInteger(question.number) && question.number > 0 ? question.number : index + 1;
}
function parseRange(value?: string): [number, number] | undefined {
  if (!value || value === 'all' || value === 'wrong' || value === 'bookmarked') return undefined;
  const [left, right, extra] = value.split('-');
  if (extra !== undefined || !left || !right) return undefined;
  const start = Number(left);
  const end = Number(right);
  return Number.isFinite(start) && Number.isFinite(end) && start > 0 && end >= start ? [start, end] : undefined;
}

export function buildRangeOptions(questions: Question[], step = 25): StudyRangeOption[] {
  const options: StudyRangeOption[] = [{ value: 'all', label: `全範囲 (${questions.length}問)` }];
  if (!questions.length) return options;
  const ordinals = questions.map(questionOrdinal);
  const first = Math.min(...ordinals);
  const last = Math.max(...ordinals);
  if (last - first + 1 <= step) return options;
  if (!Number.isSafeInteger(step) || step <= 0) return options;
  const starts = [...new Set(ordinals.map((ordinal) => first + Math.floor((ordinal - first) / step) * step))].sort((a, b) => a - b);
  for (const start of starts) {
    const end = Math.min(last, start + step - 1);
    options.push({ value: `${start}-${end}`, label: `${String(start).padStart(3, '0')}〜${String(end).padStart(3, '0')}` });
  }
  return options;
}

export function listQuestionCategories(questions: Question[]): string[] {
  const categories = questions.map((question) => question.category?.trim()).filter((category): category is string => Boolean(category));
  return [...new Set(categories)].sort((a, b) => a.localeCompare(b, 'ja'));
}

export function filterStudyQuestions(questions: Question[], settings: StudySettings, context: StudySelectionContext = {}): Question[] {
  const ordinals = new Map(questions.map((question, index) => [question.id, questionOrdinal(question, index)]));
  let selected = [...questions];
  const wrong = idSet(context.wrongQuestionIds);
  const bookmarked = idSet(context.bookmarkedQuestionIds);
  const activeFilter = settings.filter ?? 'all';
  const range = settings.selectedRange ?? 'all';
  if (activeFilter === 'wrong' && wrong) selected = selected.filter((question) => wrong.has(question.id));
  if (activeFilter === 'bookmarked' && bookmarked) selected = selected.filter((question) => bookmarked.has(question.id));
  if (range === 'wrong' && wrong) selected = selected.filter((question) => wrong.has(question.id));
  if (range === 'bookmarked' && bookmarked) selected = selected.filter((question) => bookmarked.has(question.id));
  const parsed = parseRange(range);
  if (parsed) {
    const [start, end] = parsed;
    selected = selected.filter((question) => {
      const ordinal = ordinals.get(question.id);
      return ordinal !== undefined && ordinal >= start && ordinal <= end;
    });
  }
  const category = decodeStudyCategory(settings.selectedCategory);
  return category ? selected.filter((question) => question.category?.trim() === category) : selected;
}

export function selectSessionQuestions(questions: Question[], settings: StudySettings, context: StudySelectionContext = {}): Question[] {
  const filtered = filterStudyQuestions(questions, settings, context);
  const requestedMode = settings.questionMode ?? 'as_stored';
  const modeCompatible = filtered.filter((question) => {
    if (requestedMode === 'as_stored') return true;
    const supported = getSupportedStudyQuestionModes(question);
    if (requestedMode === 'mixed') return supported.some((mode) => mode === 'front_to_back' || mode === 'back_to_front');
    return supported.includes(requestedMode);
  });
  const ordered = settings.shuffle ? shuffle(modeCompatible) : [...modeCompatible];
  return settings.questionLimit === 'all' ? ordered : ordered.slice(0, settings.questionLimit);
}

export function createSession(
  module: ModuleInfo,
  questions: Question[],
  settings: StudySettings,
  mode: 'normal' | 'review' = 'normal',
  choicePool: Question[] = questions
): QuizSession {
  const requestedMode = settings.questionMode ?? 'as_stored';
  const queue = selectSessionQuestions(questions, settings).map((question) =>
    presentQuestionForStudy(question, resolveConcreteStudyQuestionMode(question, requestedMode))
  );
  const now = Date.now();
  const sessionPool = [...choicePool];
  const explanationPool = sessionPool.length ? sessionPool : queue;
  return {
    module,
    queue,
    choicePool: sessionPool,
    choiceCandidateIndex: buildChoiceCandidateIndex(sessionPool),
    wrongAnswerLookupIndex: buildWrongAnswerLookupIndexForStudyMode(explanationPool, requestedMode),
    index: 0,
    settings,
    startedAt: now,
    sessionElapsedMs: 0,
    sessionSegmentStartedAt: now,
    currentStartedAt: now,
    currentElapsedMs: 0,
    currentHiddenTimeExcludedMs: 0,
    mode,
    attempts: []
  };
}

export function currentQuestion(session: QuizSession): Question | undefined {
  return session.queue[session.index];
}
export function elapsedForCurrent(session: QuizSession, excludedMs = 0): number {
  return session.currentElapsedMs + Math.max(0, Date.now() - session.currentStartedAt - Math.max(0, excludedMs));
}
/** Active time survives resume; the original start remains a wall-clock timestamp. */
export function elapsedForSession(session: QuizSession, excludedMs = 0, now = Date.now()): number {
  const accumulated =
    session.sessionElapsedMs ??
    session.attempts.reduce((sum, attempt) => sum + Math.max(0, attempt.elapsedMs), 0) + session.currentElapsedMs;
  if (isSessionComplete(session)) return accumulated;
  return accumulated + Math.max(0, now - (session.sessionSegmentStartedAt ?? session.currentStartedAt) - Math.max(0, excludedMs));
}
export function advanceSession(session: QuizSession, attempt?: Attempt, sessionElapsedMs = elapsedForSession(session)): QuizSession {
  const now = Date.now();
  return {
    ...session,
    index: session.index + 1,
    sessionElapsedMs,
    sessionSegmentStartedAt: now,
    currentStartedAt: now,
    currentElapsedMs: 0,
    currentHiddenTimeExcludedMs: 0,
    attempts: attempt ? [...session.attempts, attempt] : session.attempts
  };
}
export function isSessionComplete(session: QuizSession): boolean {
  return session.index >= session.queue.length;
}
