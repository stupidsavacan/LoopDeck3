import type { ScreenContext } from '../app/context';
import {
  buildAnalyticsOverview,
  type DailyStudyStat,
  type MistakeBreakdownItem,
  type MistakeTrendPoint,
  type ModuleStudyStat
} from '../core/analyticsEngine';
import { getActiveModules, getActiveQuestions } from '../packs/packResolver';

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
  card.append(bars, el('p', 'hint', '現時点では、復習キューの近似として日別のミス件数を表示しています。'));
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
  const overview = buildAnalyticsOverview(attempts, getActiveModules(packView), getActiveQuestions(packView));
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
    el('p', 'eyebrow', 'ANALYTICS'),
    el('h1', '', '学習の記録'),
    el('p', '', '続けた日、正答率、ミスの傾向をまとめて振り返ります。')
  );
  const stats = el('div', 'stats-row');
  stats.append(
    el('span', '', `${overview.totalAttempts}回答`),
    el('span', '', `正解 ${overview.correct}`),
    el('span', '', `ミス ${overview.mistakes}`)
  );
  hero.append(stats);

  const grid = el('section', 'graph-grid');
  renderHeatmap(grid, overview.dailyStudyStats, overview.totalAttempts > 0);
  renderModuleStats(grid, overview.moduleStudyStats);
  renderTrend(grid, overview.mistakeTrend);
  renderBreakdown(grid, overview.mistakeBreakdown);

  screen.append(header, hero, grid);
  root.append(screen);
}
