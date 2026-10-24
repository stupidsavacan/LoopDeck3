import type { ScreenContext } from '../app/context';
import type { Attempt, ConcreteStudyQuestionMode, ModuleInfo, Question, ReviewCard, StudySettings } from '../core/models';
import { presentQuestionForStudy } from '../core/questionPresentation';
import { buildQuizAnswerSources } from '../core/reviewPersistence';
import { createSession, type QuizSession } from '../core/sessionEngine';
import { examFolders, examLoopOptions, nearestExamPlan } from '../core/examPlan';
import { indexCardsByQuestion } from '../core/mastery';
import { activeReviewCards, buildTodayPlan, DEFAULT_FRESH_COUNT, todayKey, type TodayPlan } from '../core/todayPlan';
import { getActiveModules, getActiveQuestions } from '../packs/packResolver';
import {
  readStoredSession,
  restoreStoredSession,
  saveStoredSession,
  sessionStorageScope,
  type SessionStorageScope
} from '../storage/sessionStorage';
import { readExamSettings } from '../storage/examPlans';
import { LAST_MODULE_KEY, TODAY_MODULE_ID } from '../storage/libraryState';
import { button, clear, el, toast } from '../ui/dom';
import { appendIconLabel } from '../ui/icons';
import type { SessionNextSteps } from '../ui/inlineQuizView';
import { renderInlineQuiz } from './inlineQuiz';

export const TODAY_RECORD_KEY = 'loopdeck3.today.v1';

interface TodayRecordItem {
  id: string;
  mode: ConcreteStudyQuestionMode;
}

/** Today's question list, kept so a reopened loop resumes against the same content identity. */
export interface TodayRecord {
  date: string;
  items: TodayRecordItem[];
}

const TODAY_SETTINGS: StudySettings = {
  shuffle: false,
  autoNext: true,
  autoRevealAfterIdle: false,
  questionLimit: 'all',
  selectedRange: 'all',
  selectedCategory: 'all',
  filter: 'all',
  answerFormat: 'auto',
  questionMode: 'as_stored',
  showExample: true,
  showNumber: false,
  showCategory: true
};

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage can be unavailable; the loop still works without resume.
  }
}

export function readTodayRecord(now = new Date()): TodayRecord | undefined {
  try {
    const parsed = JSON.parse(safeGet(TODAY_RECORD_KEY) ?? 'null') as Partial<TodayRecord> | null;
    if (!parsed || parsed.date !== todayKey(now) || !Array.isArray(parsed.items)) return undefined;
    const items = parsed.items.filter(
      (item): item is TodayRecordItem =>
        typeof item?.id === 'string' && (item.mode === 'as_stored' || item.mode === 'front_to_back' || item.mode === 'back_to_front')
    );
    return items.length ? { date: parsed.date, items } : undefined;
  } catch {
    return undefined;
  }
}

function writeTodayRecord(items: Question[], now = new Date()): void {
  const record: TodayRecord = {
    date: todayKey(now),
    items: items.map((item) => ({ id: item.id, mode: item.activeStudyMode ?? 'as_stored' }))
  };
  safeSet(TODAY_RECORD_KEY, JSON.stringify(record));
}

function todayModule(items: Question[]): ModuleInfo {
  return { id: TODAY_MODULE_ID, folderId: 'today', title: '今日のループ', subject: '今日', questionIds: items.map((item) => item.id) };
}

export function planQuestions(plan: TodayPlan): Question[] {
  return [...plan.review, ...plan.fresh];
}

export async function renderTodayScreen(context: ScreenContext): Promise<void> {
  const { store, root, catalog, resolveImage, isCurrent, navigation } = context;
  if (!isCurrent()) return;
  const [attempts, cards, assets, revisions] = await Promise.all([
    store.getAttempts(),
    store.getReviewCards(),
    store.getImportedPackAssets(),
    store.getImportedPackRevisions()
  ]);
  if (!isCurrent()) return;

  const questions = getActiveQuestions(catalog);
  const modules = getActiveModules(catalog).filter((module) => module.questionIds.length > 0);
  const questionsById = new Map(questions.map((question) => [question.id, question]));
  const sources = buildQuizAnswerSources(questions, catalog.modulePackIdById, assets, revisions);
  const preferredFormats = new Map(
    modules.flatMap((module) => (module.preferredAnswerFormat ? [[module.id, module.preferredAnswerFormat] as const] : []))
  );

  async function scopeFor(module: ModuleInfo, items: Question[]): Promise<SessionStorageScope> {
    const originals = items.map((item) => questionsById.get(item.id) ?? item);
    const scope = await sessionStorageScope('', module, originals);
    const packIds = [...new Set(originals.map((item) => catalog.questionPackIdById.get(item.id) ?? ''))].sort();
    scope.packRevision = packIds.map((packId) => revisions.get(packId) ?? 'builtin').join('|');
    scope.resetEpoch = revisions.get('') ?? '0';
    return scope;
  }

  const examOptions = examLoopOptions(
    nearestExamPlan(
      examFolders(catalog.packs, modules),
      readExamSettings(),
      indexCardsByQuestion(activeReviewCards(cards, questionsById))
    )
  );

  function freshPlan(
    extraAttempts: Attempt[] = [],
    reviewCards: ReviewCard[] = cards,
    reviewLimit?: number,
    beyondDailyQuota = false
  ): TodayPlan {
    return buildTodayPlan({
      questions,
      modules,
      cards: reviewCards,
      attempts: [...attempts, ...extraAttempts],
      focusModuleId: safeGet(LAST_MODULE_KEY) ?? undefined,
      ...examOptions,
      reviewLimit,
      beyondDailyQuota
    });
  }

  clear(root);
  const screen = el('main', 'screen today-screen');
  const header = el('header', 'topbar');
  const back = button('', 'btn ghost');
  appendIconLabel(back, 'arrowLeft', 'ホーム');
  back.onclick = navigation.home;
  header.append(back);
  const title = el('section', 'today-screen-title');
  title.append(el('h1', '', '今日のループ'));
  const mount = el('div', 'quiz-mount');
  screen.append(header, title, mount);
  root.append(screen);

  async function start(items: Question[], restore = false): Promise<void> {
    const module = todayModule(items);
    const scope = await scopeFor(module, items);
    if (!isCurrent()) return;
    const persist = (session: QuizSession) => {
      if (!saveStoredSession(TODAY_MODULE_ID, session, scope)) toast('再開位置を保存できませんでした。');
    };
    let session: QuizSession | undefined;
    if (restore) {
      const stored = readStoredSession(TODAY_MODULE_ID, questionsById, scope, { mixedModules: true });
      if (stored && stored.index < stored.questions.length) session = restoreStoredSession(module, stored, questionsById, questions);
    }
    if (!session) {
      session = createSession(module, items, TODAY_SETTINGS, 'normal', questions);
      // Reviews arrive already turned to the direction their card tracks; keep that presentation.
      session.queue = [...items];
      writeTodayRecord(items);
    }
    session.sourceByQuestionId = sources;
    session.preferredFormatByModuleId = preferredFormats;
    mountSession(session, module, scope, persist);
  }

  function mountSession(
    session: QuizSession,
    module: ModuleInfo,
    scope: SessionStorageScope,
    persist: (session: QuizSession) => void
  ): void {
    persist(session);
    const update = (next: QuizSession) => mountSession(next, module, scope, persist);
    renderInlineQuiz(
      mount,
      session,
      {
        onSessionChange: update,
        onSessionCheckpoint: persist,
        onComplete: navigation.home,
        onExit: navigation.home,
        nextSteps: (done) => nextSteps(done, module, scope, persist)
      },
      { store, isCurrent, resolveImageAsset: resolveImage }
    );
  }

  function nextSteps(
    done: QuizSession,
    module: ModuleInfo,
    scope: SessionStorageScope,
    persist: (session: QuizSession) => void
  ): SessionNextSteps {
    const actions: SessionNextSteps['actions'] = [];
    const missedAttempts = done.attempts.filter((attempt) => attempt.result !== 'correct');
    const missed = [...new Map(missedAttempts.map((attempt) => [attempt.questionId, attempt])).values()].flatMap((attempt) => {
      const question = questionsById.get(attempt.questionId);
      return question ? [presentQuestionForStudy(question, attempt.questionMode ?? 'as_stored')] : [];
    });
    if (missed.length) {
      actions.push({
        id: 'retry-mistakes',
        label: `間違えた${missed.length}問だけもう一周`,
        detail: '答えを見た問題も入ります',
        primary: true,
        run: () => {
          const retry = createSession(module, missed, done.settings, 'review', questions);
          retry.queue = [...missed];
          retry.sourceByQuestionId = sources;
          retry.preferredFormatByModuleId = preferredFormats;
          mountSession(retry, module, scope, persist);
        }
      });
    }
    const more = freshPlan(done.attempts, cards, 0, true);
    if (more.fresh.length && more.focusModule) {
      actions.push({
        id: 'continue',
        label: `新しい問題を${more.fresh.length}問`,
        detail: more.focusModule.title,
        primary: !missed.length,
        run: () => void start(more.fresh)
      });
    }
    actions.push({ id: 'finish', label: '今日はここまで', detail: 'ホームに戻ります', run: navigation.home });
    return { actions };
  }

  const record = readTodayRecord();
  const recorded = record?.items.flatMap((item) => {
    const question = questionsById.get(item.id);
    return question ? [presentQuestionForStudy(question, item.mode)] : [];
  });
  if (recorded && record && recorded.length === record.items.length) {
    const stored = readStoredSession(TODAY_MODULE_ID, questionsById, await scopeFor(todayModule(recorded), recorded), {
      mixedModules: true
    });
    if (!isCurrent()) return;
    if (stored && stored.index < stored.questions.length) {
      await start(recorded, true);
      return;
    }
  }

  const plan = freshPlan();
  const items = planQuestions(plan);
  if (!items.length) {
    const empty = el('section', 'card today-empty');
    empty.append(
      el('h2', '', '今日の分は終わりました'),
      el('p', '', `期限の来た復習も、新しい問題もありません。新しい問題は最大${DEFAULT_FRESH_COUNT}問ずつ出ます。`)
    );
    const home = button('ホームに戻る', 'btn primary');
    home.onclick = navigation.home;
    empty.append(home);
    mount.append(empty);
    return;
  }
  await start(items);
}
