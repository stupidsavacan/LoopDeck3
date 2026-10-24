import type { ScreenContext } from '../app/context';
import { currentStreak } from '../core/analyticsEngine';
import { endOfLocalCalendarDay, startOfLocalCalendarDay } from '../core/calendarDay';
import { buildExamPlan, examCountdownLabel, examFolders, examLoopOptions, nearestExamPlan } from '../core/examPlan';
import { indexCardsByQuestion, moduleMastery } from '../core/mastery';
import type { ModuleInfo, ReviewCard } from '../core/models';
import { activeReviewCards, buildTodayPlan } from '../core/todayPlan';
import { buildWeeklyRecap, weekStartOf } from '../core/weeklyRecap';
import { getActiveModules, getActiveQuestions } from '../packs/packResolver';
import { readExamSettings } from '../storage/examPlans';
import { listStoredSessionSummaries, type StoredSessionSummary } from '../storage/sessionStorage';
import { button, clear, el } from '../ui/dom';
import { createUiIcon, iconNameForModule } from '../ui/icons';
import { moduleMeta } from '../ui/modulePresentation';
import { renderTodayHero, renderTodayHeroLoading } from '../ui/todayHero';
import { openWeeklyStory } from '../ui/weeklyStory';
import { buildHomeFolders, homeModuleMatches, type HomeFolder } from './homeFolders';
import {
  AUTO_RESUME_KEY,
  LAST_MODULE_KEY as HOME_LAST_MODULE_KEY,
  LIBRARY_VIEW_KEY,
  TODAY_MODULE_ID,
  WEEKLY_SEEN_KEY
} from '../storage/libraryState';
const HOME_IN_PLAYER_KEY = 'loopdeck3.library.in-player';
const FOLDER_STATE_PREFIX = 'loopdeck3.library.folders.';

function hexToRgba(hexColor: string, alpha: number): string {
  const red = Number.parseInt(hexColor.slice(1, 3), 16);
  const green = Number.parseInt(hexColor.slice(3, 5), 16);
  const blue = Number.parseInt(hexColor.slice(5, 7), 16);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function safeGetStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSetStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage may be unavailable in some embedded contexts.
  }
}

function moduleMatches(module: ModuleInfo, query: string): boolean {
  return homeModuleMatches(module, query, moduleMeta(module));
}

function folderStateKey(folder: HomeFolder): string {
  return FOLDER_STATE_PREFIX + JSON.stringify([folder.kind, folder.id]);
}

function folderOpen(folder: HomeFolder): boolean {
  const stored = safeGetStorage(folderStateKey(folder));
  return stored !== '0';
}

function setFolderOpen(folder: HomeFolder, open: boolean): void {
  safeSetStorage(folderStateKey(folder), open ? '1' : '0');
}

function displayTags(module: ModuleInfo): string[] {
  const meta = moduleMeta(module);
  return [...meta.tags, `${module.questionIds.length}問`].slice(0, 5);
}

/** Spines at or above this mastery get the gold edge. */
const MASTERED_SPINE_RATIO = 0.9;

interface ModuleProgress {
  ratio: number;
  dueToday: number;
}

function relativeTime(savedAt: string, now: Date): string {
  const time = Date.parse(savedAt);
  if (!Number.isFinite(time)) return '';
  if (time >= startOfLocalCalendarDay(now)) {
    const saved = new Date(time);
    return `今日 ${saved.getHours()}:${String(saved.getMinutes()).padStart(2, '0')}`;
  }
  const days = Math.ceil((startOfLocalCalendarDay(now) - time) / 86_400_000);
  return days <= 1 ? '昨日' : `${days}日前`;
}

function dueTodayByModule(cards: ReviewCard[], now: Date): Map<string, number> {
  const end = endOfLocalCalendarDay(now);
  const questionsByModule = new Map<string, Set<string>>();
  for (const card of cards) {
    if (card.suspended || card.state === 'suspended' || !card.dueAt || Date.parse(card.dueAt) > end) continue;
    const ids = questionsByModule.get(card.moduleId) ?? new Set<string>();
    ids.add(card.questionId);
    questionsByModule.set(card.moduleId, ids);
  }
  return new Map([...questionsByModule].map(([moduleId, ids]) => [moduleId, ids.size]));
}

export function renderHomeScreen(context: ScreenContext): void {
  const { root: root, catalog: packView } = context;
  const { module: onOpenModule } = context.navigation;

  clear(root);
  safeSetStorage(HOME_IN_PLAYER_KEY, '0');
  let query = '';

  const visibleModules = getActiveModules(packView).filter((module) => module.questionIds.length > 0);
  const modulesById = new Map(visibleModules.map((module) => [module.id, module]));
  const homeFolders = buildHomeFolders(packView.packs, visibleModules);

  const screen = el('main', 'screen home-screen');
  let hero = renderTodayHeroLoading();
  const resumeSlot = el('div', 'resume-slot');
  const weeklySlot = el('div', 'resume-slot weekly-slot');
  let view: 'cards' | 'shelf' = safeGetStorage(LIBRARY_VIEW_KEY) === 'shelf' ? 'shelf' : 'cards';
  const shelfHeading = el('div', 'home-section-row');
  const viewToggle = el('div', 'library-view-toggle');
  viewToggle.setAttribute('role', 'group');
  viewToggle.setAttribute('aria-label', '教材の表示');
  const viewButtons = (['cards', 'shelf'] as const).map((value) => {
    const option = button(value === 'cards' ? 'カード' : '背表紙', 'library-view-option');
    option.onclick = () => {
      view = value;
      safeSetStorage(LIBRARY_VIEW_KEY, value);
      syncViewButtons();
      renderList();
    };
    return [value, option] as const;
  });
  function syncViewButtons(): void {
    for (const [value, option] of viewButtons) option.setAttribute('aria-pressed', String(value === view));
  }
  syncViewButtons();
  viewToggle.append(...viewButtons.map(([, option]) => option));
  shelfHeading.append(el('h2', 'home-section-heading', '自分で選ぶ'), viewToggle);
  const progressByModule = new Map<string, ModuleProgress>();
  const examLabels = new Map<string, string>();
  const progressNodes = new Map<string, HTMLElement[]>();

  const toolbar = el('div', 'toolbar');
  const search = el('input', 'search') as HTMLInputElement;
  search.placeholder = '教材を検索';
  search.autocomplete = 'off';
  search.setAttribute('aria-label', '教材を検索');
  const showAll = button('すべて表示', 'filter');
  toolbar.append(search, showAll);

  const list = el('section', 'folder-list');
  list.setAttribute('aria-label', '教材一覧');

  function fillProgress(node: HTMLElement, moduleId: string): void {
    const progress = progressByModule.get(moduleId);
    if (!progress) return;
    const percent = Math.round(progress.ratio * 100);
    if (node.classList.contains('module-spine')) {
      node.style.setProperty('--mastery', `${percent}%`);
      node.classList.toggle('is-mastered', progress.ratio >= MASTERED_SPINE_RATIO);
      node.setAttribute('aria-label', `${node.dataset.title ?? ''} ${node.dataset.count ?? ''}問 習熟${percent}%`);
      return;
    }
    const bar = el('span', 'module-progress-bar');
    const fill = el('span', 'module-progress-fill');
    fill.style.width = `${percent}%`;
    bar.append(fill);
    const label = el('span', 'module-progress-label', `習熟 ${percent}%`);
    if (progress.dueToday) label.append(el('b', '', ` · 復習 ${progress.dueToday}問`));
    node.replaceChildren(bar, label);
    node.hidden = false;
  }

  function openModule(moduleId: string): void {
    safeSetStorage(HOME_LAST_MODULE_KEY, moduleId);
    safeSetStorage(HOME_IN_PLAYER_KEY, '1');
    onOpenModule(moduleId);
  }

  function renderModuleCard(module: ModuleInfo): HTMLButtonElement {
    const meta = moduleMeta(module);
    const card = el('button', 'module-card ready') as HTMLButtonElement;
    card.type = 'button';
    card.style.setProperty('--deck-accent', meta.accent);
    card.style.borderColor = hexToRgba(meta.accent, 0.2);
    if (meta.accentColor) card.style.background = `linear-gradient(180deg, ${meta.accentColor}, rgba(255, 255, 255, 0.94) 70%)`;
    card.onclick = () => openModule(module.id);

    const top = el('div', 'card-top');
    const icon = el('div', 'module-icon');
    icon.style.background = meta.accent;
    icon.append(createUiIcon(iconNameForModule(module), 'deck-icon-svg'));
    const title = el('div', 'title');
    title.append(el('h2', '', module.title), el('div', 'subtitle', meta.subtitle));
    top.append(icon, title);

    const tags = el('div', 'tags');
    for (const tag of displayTags(module)) tags.append(el('span', 'tag', tag));

    const progress = el('div', 'module-progress');
    progress.hidden = true;
    progressNodes.set(module.id, [...(progressNodes.get(module.id) ?? []).filter((node) => screen.contains(node)), progress]);
    fillProgress(progress, module.id);

    card.append(top, el('p', 'desc', meta.description), tags, progress);
    return card;
  }

  /** A book spine: thickness follows the question count, the bottom band fills with mastery. */
  function renderModuleSpine(module: ModuleInfo): HTMLButtonElement {
    const meta = moduleMeta(module);
    const count = module.questionIds.length;
    const spine = el('button', 'module-spine') as HTMLButtonElement;
    spine.type = 'button';
    spine.dataset.title = module.title;
    spine.dataset.count = String(count);
    spine.setAttribute('aria-label', `${module.title} ${count}問`);
    spine.style.setProperty('--deck-accent', meta.accent);
    spine.style.setProperty('--spine-width', `${Math.round(Math.min(84, Math.max(48, 32 + count / 5)))}px`);
    spine.onclick = () => openModule(module.id);
    spine.append(el('span', 'module-spine-title', module.title), el('span', 'module-spine-band'));
    progressNodes.set(module.id, [...(progressNodes.get(module.id) ?? []).filter((node) => screen.contains(node)), spine]);
    fillProgress(spine, module.id);
    return spine;
  }

  function renderSearchResults(modules: ModuleInfo[]): void {
    clear(list);
    list.className = 'module-grid search-grid';
    for (const module of modules) list.append(renderModuleCard(module));
    if (!modules.length) {
      list.append(el('div', 'empty-state', '該当する教材がありません。'));
    }
  }

  function renderFolder(folder: HomeFolder): HTMLElement | undefined {
    const modules = folder.moduleIds.map((id) => modulesById.get(id)).filter((module): module is ModuleInfo => Boolean(module));
    if (!modules.length) return undefined;

    const isOpen = folderOpen(folder);
    const shell = el('section', 'folder-shell');
    const head = button('', 'folder-head');
    head.setAttribute('aria-expanded', String(isOpen));
    const titleBox = el('div', 'folder-titlebox');
    titleBox.append(el('h2', '', folder.title), el('p', '', folder.description));
    const folderTags = el('div', 'folder-tags');
    for (const tag of folder.tags) folderTags.append(el('span', '', tag));
    titleBox.append(folderTags);
    head.append(titleBox, el('div', 'folder-count', `${modules.length}件`));
    const exam = renderFolderExam(folder);

    const shelf = view === 'shelf';
    const content = el('div', `${isOpen ? 'folder-content open' : 'folder-content'}${shelf ? ' shelf' : ''}`);
    if (isOpen) for (const module of modules) content.append(shelf ? renderModuleSpine(module) : renderModuleCard(module));
    head.onclick = () => {
      setFolderOpen(folder, !isOpen);
      renderList();
    };
    shell.append(head, exam, content);
    return shell;
  }

  const examSlots = new Map<string, HTMLElement>();

  function renderFolderExam(folder: HomeFolder): HTMLElement {
    const link = button('', 'folder-exam');
    link.onclick = () => context.navigation.exam(folder.id);
    examSlots.set(folder.id, link);
    fillFolderExam(folder.id);
    return link;
  }

  function fillFolderExam(folderId: string): void {
    const link = examSlots.get(folderId);
    if (!link) return;
    const label = examLabels.get(folderId);
    link.textContent = label ?? '試験日を設定';
    link.classList.toggle('has-exam', Boolean(label));
  }

  function renderList(): void {
    const modules = visibleModules.filter((module) => moduleMatches(module, query));
    if (query.trim()) {
      renderSearchResults(modules);
      return;
    }

    clear(list);
    list.className = 'folder-list';
    for (const folder of homeFolders) {
      const folderNode = renderFolder(folder);
      if (folderNode) list.append(folderNode);
    }

    if (!list.childElementCount) {
      list.append(el('div', 'empty-state', '表示できる教材がありません。'));
    }
  }

  search.addEventListener('input', () => {
    query = search.value;
    renderList();
  });
  showAll.onclick = () => {
    search.value = '';
    query = '';
    for (const folder of homeFolders) setFolderOpen(folder, true);
    renderList();
  };

  function renderResumeBanner(summary: StoredSessionSummary, now: Date): void {
    const module = modulesById.get(summary.moduleId);
    if (!module) return;
    const banner = button('', 'resume-banner');
    const icon = el('span', 'resume-banner-icon');
    icon.append(createUiIcon('arrowRight', 'resume-banner-svg'));
    const text = el('span', 'resume-banner-text');
    text.append(
      el('strong', '', `中断中：${module.title}`),
      el('span', '', [`${summary.index + 1} / ${summary.total}`, relativeTime(summary.savedAt, now)].filter(Boolean).join(' · '))
    );
    banner.append(icon, text, el('span', 'resume-banner-action', '続きから'));
    banner.onclick = () => {
      try {
        sessionStorage.setItem(AUTO_RESUME_KEY, module.id);
      } catch {
        // Without the flag the module screen still shows its resume button.
      }
      openModule(module.id);
    };
    resumeSlot.replaceChildren(banner);
  }

  async function loadStudyState(): Promise<void> {
    const [attempts, cards] = await Promise.all([context.store.getAttempts(), context.store.getReviewCards()]);
    if (!context.isCurrent()) return;
    const now = new Date();
    const questions = getActiveQuestions(packView);
    const activeCards = activeReviewCards(cards, new Map(questions.map((question) => [question.id, question])));
    const cardsByQuestion = indexCardsByQuestion(activeCards);
    const folders = examFolders(packView.packs, visibleModules);
    const examSettings = readExamSettings();
    for (const folder of folders) {
      const setting = examSettings[folder.id];
      if (!setting) continue;
      const examPlan = buildExamPlan(folder, setting, cardsByQuestion, now);
      if (examPlan.daysLeft >= 0) examLabels.set(folder.id, examPlan.daysLeft === 0 ? '試験は今日' : `試験まで ${examPlan.daysLeft}日`);
    }
    for (const folderId of examSlots.keys()) fillFolderExam(folderId);
    const nearest = nearestExamPlan(folders, examSettings, cardsByQuestion, now);
    const plan = buildTodayPlan({
      questions,
      modules: visibleModules,
      cards: activeCards,
      attempts,
      focusModuleId: safeGetStorage(HOME_LAST_MODULE_KEY) ?? undefined,
      ...examLoopOptions(nearest),
      now
    });
    const saved = listStoredSessionSummaries().filter((summary) => summary.index < summary.total);
    const today = saved.find(
      (summary) => summary.moduleId === TODAY_MODULE_ID && Date.parse(summary.savedAt) >= startOfLocalCalendarDay(now)
    );
    const next = renderTodayHero({
      now,
      streak: currentStreak(attempts, now),
      done: plan.answeredToday,
      reviewCount: plan.review.length,
      freshCount: plan.fresh.length,
      focusTitle: plan.focusModule?.title,
      estimatedMinutes: plan.estimatedMinutes,
      resume: today ? { index: today.index, total: today.total } : undefined,
      examLabel: nearest ? examCountdownLabel(nearest) : undefined,
      onExam: nearest ? () => context.navigation.exam(nearest.folder.id) : undefined,
      onStart: context.navigation.today
    });
    hero.replaceWith(next);
    hero = next;

    const latest = saved
      .filter((summary) => summary.moduleId !== TODAY_MODULE_ID && modulesById.has(summary.moduleId))
      .sort((a, b) => Date.parse(b.savedAt) - Date.parse(a.savedAt))[0];
    if (latest) renderResumeBanner(latest, now);

    // Once per week, offer the recap of the week that just ended.
    const lastWeek = weekStartOf(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7));
    const recap = buildWeeklyRecap(attempts, visibleModules, new Map(questions.map((question) => [question.id, question])), lastWeek);
    if (recap.answered > 0 && safeGetStorage(WEEKLY_SEEN_KEY) !== recap.weekStart) {
      const offer = button('', 'resume-banner weekly-banner');
      const icon = el('span', 'resume-banner-icon weekly-banner-icon');
      icon.append(createUiIcon('chart', 'resume-banner-svg'));
      const text = el('span', 'resume-banner-text');
      text.append(el('strong', '', '先週のふりかえり'), el('span', '', `${recap.studyDays}日学習 · ${recap.answered}問`));
      offer.append(icon, text, el('span', 'resume-banner-action', '見る'));
      offer.onclick = () => {
        safeSetStorage(WEEKLY_SEEN_KEY, recap.weekStart);
        weeklySlot.replaceChildren();
        openWeeklyStory(recap, '先週のあなた');
      };
      weeklySlot.replaceChildren(offer);
    }

    const due = dueTodayByModule(activeCards, now);
    for (const module of visibleModules) {
      progressByModule.set(module.id, { ratio: moduleMastery(module, cardsByQuestion).ratio, dueToday: due.get(module.id) ?? 0 });
    }
    for (const [moduleId, nodes] of progressNodes) for (const node of nodes) if (screen.contains(node)) fillProgress(node, moduleId);
  }

  screen.append(hero, resumeSlot, weeklySlot, shelfHeading, toolbar, list);
  root.append(screen);
  renderList();
  void loadStudyState().catch(() => {
    if (!context.isCurrent()) return;
    hero.classList.remove('is-loading');
    hero.removeAttribute('aria-busy');
    const line = hero.querySelector('.today-plan');
    if (line) line.textContent = '今日の計画を読み込めませんでした。下の棚から教材を選べます。';
  });
}
