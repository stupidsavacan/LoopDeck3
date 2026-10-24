import type { ScreenContext } from '../app/context';
import {
  buildAnalyticsOverview,
  buildDueForecast,
  buildMasteryGrid,
  type DueForecastDay,
  type DailyStudyStat,
  type MistakeBreakdownItem,
  type MistakeTrendPoint,
  type ModuleStudyStat
} from '../core/analyticsEngine';
import { indexCardsByQuestion, type MasteryLevel } from '../core/mastery';
import type { ModuleInfo, Question, ReviewCard } from '../core/models';
import { activeReviewCards } from '../core/todayPlan';
import { buildWeeklyRecap } from '../core/weeklyRecap';
import { openWeeklyStory } from '../ui/weeklyStory';
import { getActiveModules, getActiveQuestions } from '../packs/packResolver';
import { LAST_MODULE_KEY } from '../storage/libraryState';

import { button, clear, el } from '../ui/dom';
import { appendIconLabel } from '../ui/icons';

const percent = (value: number): string => `${Math.round(value * 100)}%`;
const seconds = (value: number): string => `${Math.round(value / 100) / 10}秒`;

function renderHeatmap(root: HTMLElement, stats: DailyStudyStat[], hasAttempts: boolean): void {
  const card = el('section', 'card graph-card');
  card.append(el('h2', '', '学習の継続'));
  if (!hasAttempts) {
    card.append(el('p', 'empty', 'まだ学習履歴がありません。問題を解くとここに日別の記録が出ます。'));
    root.append(card);
    return;
  }

  const max = Math.max(1, ...stats.map((item) => item.attempts));
  const grid = el('div', 'heatmap-grid');
  for (const day of stats) {
    const cell = el('span', 'heat-cell') as HTMLSpanElement;
    cell.style.setProperty('--level', String(day.attempts / max));
    cell.title = `${day.date}: ${day.attempts}問 / 正答率 ${percent(day.accuracy)}`;
    cell.setAttribute('aria-label', cell.title);
    grid.append(cell);
  }
  card.append(grid, el('p', 'hint', '直近28日の回答数です。濃い日ほど多く解いています。'));
  root.append(card);
}

const LEVEL_LABELS: Record<MasteryLevel, string> = { solid: '定着', learning: '学習中', weak: '弱い', unseen: '未学習' };
const FORECAST_DAY = 2;

function forecastLabel(offset: number): string {
  return offset === 0 ? '今日' : offset === 1 ? '明日' : offset === 2 ? 'あさって' : `${offset}日後`;
}

function renderDueForecast(root: HTMLElement, forecast: DueForecastDay[], hasCards: boolean, startToday: () => void): void {
  const card = el('section', 'card graph-card due-forecast');
  card.append(el('h2', '', '復習の予定'));
  if (!hasCards) {
    card.append(el('p', 'empty', '問題を解くと、復習の予定がここに出ます。'));
    root.append(card);
    return;
  }
  const ahead = forecast[Math.min(FORECAST_DAY, forecast.length - 1)];
  const today = forecast[0]?.due ?? 0;
  card.append(
    el(
      'p',
      'due-forecast-lead',
      ahead.due > today
        ? `このまま復習しないと、${forecastLabel(FORECAST_DAY)}には ${ahead.due}問 が期限切れになります。`
        : today > 0
          ? `今日が期限の復習が ${today}問 あります。`
          : 'しばらく期限の来る復習はありません。'
    )
  );
  const max = Math.max(1, ...forecast.map((day) => day.due));
  const bars = el('div', 'due-forecast-bars');
  for (const [offset, day] of forecast.entries()) {
    const column = el('div', offset === FORECAST_DAY ? 'due-forecast-day is-focus' : 'due-forecast-day');
    column.setAttribute('role', 'img');
    column.setAttribute('aria-label', `${forecastLabel(offset)}: ${day.due}問`);
    const bar = el('span', 'due-forecast-bar');
    bar.style.height = `${Math.max(4, Math.round((day.due / max) * 100))}%`;
    column.append(el('span', 'due-forecast-value', String(day.due)), bar, el('span', 'due-forecast-label', forecastLabel(offset)));
    bars.append(column);
  }
  card.append(bars);
  if (today > 0) {
    const start = button('今日のループで復習する', 'btn primary');
    start.onclick = startToday;
    card.append(start);
  }
  root.append(card);
}

function renderMasteryMap(
  root: HTMLElement,
  modules: ModuleInfo[],
  questionsById: ReadonlyMap<string, Question>,
  cards: ReviewCard[]
): void {
  const card = el('section', 'card graph-card mastery-map');
  card.append(el('h2', '', '習熟マップ'));
  const cardsByQuestion = indexCardsByQuestion(cards);
  const studied = modules.filter((module) => module.questionIds.some((id) => cardsByQuestion.has(id)));
  if (!studied.length) {
    card.append(el('p', 'empty', '問題を解くと、教材ごとの定着ぐあいが1問1マスで出ます。'));
    root.append(card);
    return;
  }
  let lastModule: string | null = null;
  try {
    lastModule = localStorage.getItem(LAST_MODULE_KEY);
  } catch {
    lastModule = null;
  }
  const field = el('label', 'mastery-select-field');
  field.htmlFor = 'mastery-module';
  field.append(el('span', '', '教材'));
  const select = el('select', 'study-select') as HTMLSelectElement;
  select.id = 'mastery-module';
  for (const module of studied) {
    const option = el('option', '', module.title) as HTMLOptionElement;
    option.value = module.id;
    select.append(option);
  }
  select.value = studied.some((module) => module.id === lastModule) ? (lastModule as string) : studied[0].id;
  const body = el('div', 'mastery-body');
  const legend = el('div', 'mastery-legend');
  for (const level of ['unseen', 'weak', 'learning', 'solid'] as const) {
    const item = el('span', 'mastery-legend-item');
    item.append(el('span', `mastery-swatch level-${level}`), document.createTextNode(LEVEL_LABELS[level]));
    legend.append(item);
  }

  function draw(): void {
    const module = studied.find((item) => item.id === select.value) ?? studied[0];
    body.replaceChildren(
      ...buildMasteryGrid(module, questionsById, cardsByQuestion).map((category) => {
        const total = category.cells.length;
        const solidShare = total ? Math.round(((category.counts.solid + category.counts.learning * 0.5) / total) * 100) : 0;
        const row = el('div', 'mastery-row');
        const head = el('div', 'mastery-row-head');
        head.append(el('span', 'mastery-row-title', category.category), el('span', 'mastery-row-percent', `${solidShare}%`));
        const cells = el('div', 'mastery-cells');
        cells.setAttribute('role', 'img');
        cells.setAttribute(
          'aria-label',
          `${category.category}: ${(['solid', 'learning', 'weak', 'unseen'] as const).map((level) => `${LEVEL_LABELS[level]} ${category.counts[level]}問`).join('、')}`
        );
        for (const cell of category.cells) {
          const mark = el('span', `mastery-cell level-${cell.level}`);
          mark.title = `${cell.label}（${LEVEL_LABELS[cell.level]}）`;
          cells.append(mark);
        }
        row.append(head, cells);
        return row;
      })
    );
  }
  select.onchange = draw;
  const controls = el('div', 'mastery-controls');
  controls.append(field, select);
  card.append(controls, legend, body);
  draw();
  root.append(card);
}

function renderModuleStats(root: HTMLElement, stats: ModuleStudyStat[]): void {
  stats = stats.slice(0, 8);
  const card = el('section', 'card graph-card');
  card.append(el('h2', '', '正答率と回答速度'));

  if (!stats.length) {
    card.append(el('p', 'empty', 'まだ比較できる回答履歴がありません。'));
    root.append(card);
    return;
  }

  const list = el('div', 'module-stat-list');
  for (const item of stats) {
    const row = el('div', 'module-stat-row');
    const accuracyWidth = `${Math.max(4, Math.round(item.accuracy * 100))}%`;
    const meta = el('div');
    meta.append(el('strong', '', item.title), el('small', '', `${item.attempts}回 / 平均 ${seconds(item.averageElapsedMs)}`));
    const meter = el('div', 'accuracy-meter');
    const fill = el('span');
    fill.style.width = accuracyWidth;
    meter.append(fill);
    row.append(meta, meter, el('b', '', percent(item.accuracy)));
    list.append(row);
  }
  card.append(list);
  root.append(card);
}

function renderTrend(root: HTMLElement, trend: MistakeTrendPoint[]): void {
  const card = el('section', 'card graph-card');
  card.append(el('h2', '', 'ミスの推移'));

  if (!trend.some((item) => item.mistakes > 0)) {
    card.append(el('p', 'empty', 'まだミス履歴がありません。'));
    root.append(card);
    return;
  }

  const max = Math.max(1, ...trend.map((item) => item.mistakes));
  const bars = el('div', 'trend-bars');
  for (const item of trend) {
    const bar = el('span', 'trend-bar') as HTMLSpanElement;
    bar.style.setProperty('--height', `${Math.max(6, (item.mistakes / max) * 100)}%`);
    bar.title = `${item.date}: ${item.mistakes}件`;
    bar.setAttribute('aria-label', bar.title);
    bars.append(bar);
  }
  card.append(bars, el('p', 'hint', '直近14日の、日ごとの不正解の数です。'));
  root.append(card);
}

function renderBreakdown(root: HTMLElement, breakdown: MistakeBreakdownItem[]): void {
  const card = el('section', 'card graph-card');
  card.append(el('h2', '', 'ミスの内訳'));

  if (!breakdown.length) {
    card.append(el('p', 'empty', '分類できるミス履歴がまだありません。'));
    root.append(card);
    return;
  }

  const list = el('div', 'breakdown-list');
  const max = Math.max(1, ...breakdown.map((item) => item.count));
  for (const item of breakdown) {
    const row = el('div', 'breakdown-row');
    const meter = el('div', 'breakdown-meter');
    const fill = el('span');
    fill.style.width = `${Math.max(8, (item.count / max) * 100)}%`;
    meter.append(fill);
    row.append(el('span', '', item.label), meter, el('strong', '', String(item.count)));
    list.append(row);
  }
  card.append(list);
  root.append(card);
}

export async function renderGraphsScreen(context: ScreenContext): Promise<void> {
  const { store: studyStore, root: root, catalog: packView, isCurrent } = context;
  const { home: navigateHome, review: navigateReview } = context.navigation;

  if (!isCurrent()) return;
  const attempts = await studyStore.getAttempts();
  if (!isCurrent()) return;
  const allCards = await studyStore.getReviewCards();
  if (!isCurrent()) return;
  const questions = getActiveQuestions(packView);
  const questionsById = new Map(questions.map((question) => [question.id, question]));
  const cards = activeReviewCards(allCards, questionsById);
  const overview = buildAnalyticsOverview(attempts, getActiveModules(packView), questions);
  clear(root);

  const screen = el('main', 'screen graphs-screen');
  const header = el('header', 'topbar');
  const back = button('', 'btn ghost');
  appendIconLabel(back, 'arrowLeft', 'ホーム');
  back.onclick = navigateHome;
  const review = button('', 'btn ghost');
  appendIconLabel(review, 'review', '復習');
  review.onclick = navigateReview;
  header.append(back, review);

  const hero = el('section', 'hero-card study-hero-card');
  hero.append(
    el('h1', '', '学習の記録'),
    el('p', '', '続けた日、正答率、ミスの傾向をまとめて振り返ります。')
  );
  const stats = el('div', 'stats-row');
  stats.append(
    el('span', '', `${overview.totalAttempts}回答`),
    el('span', '', `正解 ${overview.correct}`),
    el('span', '', `ミス ${overview.mistakes}`)
  );
  const weekly = button('今週のふりかえり', 'btn weekly-open');
  weekly.onclick = () =>
    openWeeklyStory(buildWeeklyRecap(attempts, getActiveModules(packView), questionsById, new Date()), '今週のあなた');
  hero.append(stats, weekly);

  const grid = el('section', 'graph-grid');
  renderHeatmap(grid, overview.dailyStudyStats, overview.totalAttempts > 0);
  renderDueForecast(grid, buildDueForecast(cards), cards.length > 0, context.navigation.today);
  renderMasteryMap(
    grid,
    getActiveModules(packView).filter((module) => module.questionIds.length > 0),
    questionsById,
    cards
  );
  renderModuleStats(grid, overview.moduleStudyStats);
  renderTrend(grid, overview.mistakeTrend);
  renderBreakdown(grid, overview.mistakeBreakdown);

  screen.append(header, hero, grid);
  root.append(screen);
}
