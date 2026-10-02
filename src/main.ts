import './styles.css';
import { version as appVersion } from '../package.json';
import './homeFeatures.css';
import './mobileUxFixes.css';
import './editorialUi.css';
import { registerGlobalErrorLogging, writeDebugLog } from './debug/debugLog';
import { loadBuiltinPacks } from './packs/builtinLoader';
import { setActivePackAssetView } from './packs/packAssetResolver';
import { resolveActivePacks, type ResolvedPackView } from './packs/packResolver';
import { db } from './storage/db';
import { renderHomeScreen } from './screens/homeScreen';
import { renderModuleScreen } from './screens/moduleScreen';
import { disposeInlineQuizzes } from './screens/inlineQuiz';
import { renderReviewCenter } from './screens/reviewCenter';
import { renderImportScreen } from './screens/importScreen';
import { renderGraphsScreen } from './screens/graphsScreen';
import { renderPdfWorksheetScreen } from './screens/pdfWorksheetScreen';
import { renderDebugLogScreen } from './screens/debugLogScreen';
import { renderBottomNav, type BottomNavSection } from './ui/bottomNav';
import { button, el } from './ui/dom';
import { createUiIcon } from './ui/icons';
import { renderLoading } from './ui/loading';
import { RouteRenderCoordinator, type RouteRenderLease } from './ui/routeRenderGuard';

const appRoot = document.querySelector<HTMLDivElement>('#app');
if (!appRoot) throw new Error('Missing #app root.');
const root: HTMLElement = appRoot;
const ROUTE_LOADING_DELAY_MS = 2000;

registerGlobalErrorLogging();

let packView: ResolvedPackView = resolveActivePacks([]);
const routeRenderCoordinator = new RouteRenderCoordinator();
let packViewLoaded = false;

export type AppRoute =
  | { name: 'home' }
  | { name: 'module'; moduleId: string }
  | { name: 'review' }
  | { name: 'import' }
  | { name: 'graphs' }
  | { name: 'pdfWorksheet' }
  | { name: 'debugLog' };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function renderStartupError(error: unknown): void {
  writeDebugLog({
    level: 'error',
    area: 'startup',
    code: 'APP-STARTUP',
    userMessage: 'LoopDeck3を起動できませんでした。',
    detail: errorMessage(error),
    stack: error instanceof Error ? error.stack : undefined
  });

  const screen = document.createElement('main');
  screen.className = 'screen startup-error-screen';
  const card = document.createElement('section');
  card.className = 'editorial-system-state startup-error-card';
  const mark = document.createElement('div');
  mark.className = 'system-state-mark error';
  mark.textContent = '!';
  mark.setAttribute('aria-hidden', 'true');
  const copy = document.createElement('div');
  copy.className = 'system-state-copy';
  const eyebrow = document.createElement('p');
  eyebrow.className = 'eyebrow';
  eyebrow.textContent = 'SYSTEM ERROR';
  const title = document.createElement('h1');
  title.textContent = 'LoopDeck3を起動できませんでした';
  const body = document.createElement('p');
  body.className = 'system-error-detail';
  body.textContent = errorMessage(error);
  const hint = document.createElement('p');
  hint.className = 'hint';
  hint.textContent = 'アプリを再起動しても続く場合は、この画面の内容を確認してください。';
  copy.append(eyebrow, title, body, hint);
  card.append(mark, copy);
  screen.append(card);
  root.replaceChildren(screen);
}

function invalidatePackView(): void {
  packViewLoaded = false;
}

async function loadPacks(): Promise<ResolvedPackView> {
  if (packViewLoaded) return packView;
  const loadedPacks = [...loadBuiltinPacks(), ...(await db.getImportedPacks())];
  return resolveActivePacks(loadedPacks);
}

function startRouteRender(route: AppRoute): void {
  disposeInlineQuizzes(root);
  const lease = routeRenderCoordinator.begin();
  root.inert = true;
  root.setAttribute('aria-busy', 'true');
  void renderRoute(route, lease).catch((error) => {
    if (!lease.isCurrent()) return;
    renderStartupError(error);
  });
}

function routeToUrl(route: AppRoute): string {
  switch (route.name) {
    case 'home':
      return '#home';
    case 'module':
      return `#module/${encodeURIComponent(route.moduleId)}`;
    case 'review':
      return '#review';
    case 'import':
      return '#import';
    case 'graphs':
      return '#graphs';
    case 'pdfWorksheet':
      return '#pdf-worksheet';
    case 'debugLog':
      return '#debug-log';
  }
}

function routeFromUrl(): AppRoute {
  const hash = window.location.hash.replace(/^#\/?/, '');
  if (!hash || hash === 'home') return { name: 'home' };
  const [routeName, ...parts] = hash.split('/');
  if (routeName === 'module') {
    const encodedId = parts.join('/');
    if (!encodedId) return { name: 'home' };
    try {
      return { name: 'module', moduleId: decodeURIComponent(encodedId) };
    } catch {
      return { name: 'home' };
    }
  }
  if (routeName === 'review') return { name: 'review' };
  if (routeName === 'import') return { name: 'import' };
  if (routeName === 'graphs') return { name: 'graphs' };
  if (routeName === 'pdf-worksheet') return { name: 'pdfWorksheet' };
  if (routeName === 'debug-log') return { name: 'debugLog' };
  return { name: 'home' };
}

function isAppRoute(value: unknown): value is AppRoute {
  if (typeof value !== 'object' || value === null) return false;
  const route = value as Partial<AppRoute>;
  return (
    route.name === 'home' ||
    route.name === 'review' ||
    route.name === 'import' ||
    route.name === 'graphs' ||
    route.name === 'pdfWorksheet' ||
    route.name === 'debugLog' ||
    (route.name === 'module' && typeof route.moduleId === 'string')
  );
}

function loadingMessage(route: AppRoute): string {
  switch (route.name) {
    case 'home':
      return '教材を読み込んでいます…';
    case 'module':
      return '教材情報を読み込んでいます…';
    case 'review':
      return '復習データを読み込んでいます…';
    case 'graphs':
      return '学習記録を集計しています…';
    case 'import':
      return '教材データを読み込んでいます…';
    case 'pdfWorksheet':
      return 'PDF作成画面を準備しています…';
    case 'debugLog':
      return 'デバッグログを読み込んでいます…';
  }
}

function navigate(route: AppRoute, options: { replace?: boolean } = {}): void {
  const url = routeToUrl(route);
  const sameRoute = window.location.hash === url;
  if (options.replace) history.replaceState(route, '', url);
  else if (!sameRoute) history.pushState(route, '', url);
  startRouteRender(route);
}

function appendMainNavigation(current: BottomNavSection | undefined): void {
  const screen = root.querySelector<HTMLElement>('main.screen');
  if (!screen || root.querySelector(':scope > .bottom-nav')) return;
  root.append(
    renderBottomNav(
      current,
      () => navigate({ name: 'home' }),
      () => navigate({ name: 'review' }),
      () => navigate({ name: 'graphs' })
    )
  );
}

function appendHomeManagementLinks(): void {
  const screen = root.querySelector<HTMLElement>('main.home-screen');
  if (!screen || screen.querySelector('[data-home-management]')) return;

  const management = el('details', 'home-tools management-card');
  management.dataset.homeManagement = 'true';
  const summary = el('summary', 'home-tools-summary');
  const summaryIcon = el('span', 'home-tools-icon');
  summaryIcon.append(createUiIcon('toolbox', 'home-tools-svg'));
  const summaryCopy = el('span', 'home-tools-summary-copy');
  summaryCopy.append(el('strong', '', '教材・データ・PDF'), el('small', '', '管理ツール'));
  summary.append(summaryIcon, summaryCopy);
  const body = el('div', 'home-tools-body');
  const actions = el('div', 'update-actions');
  const importButton = button('教材とデータを開く', 'tool-link');
  importButton.onclick = () => navigate({ name: 'import' });
  const pdfButton = button('PDFプリントを作る', 'tool-link secondary');
  pdfButton.onclick = () => navigate({ name: 'pdfWorksheet' });
  actions.append(importButton, pdfButton);
  body.append(el('p', 'small-note', '教材パック、バックアップ、PDF出力などの補助機能です。'), actions);
  management.append(summary, body);
  management.addEventListener('toggle', () => {
    if (!management.open) return;
    window.requestAnimationFrame(() => management.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' }));
  });
  screen.append(management);

  const version = button(`LoopDeck3 v${appVersion}`, 'version-trigger');
  version.setAttribute('aria-label', 'LoopDeck3 バージョン情報');
  let tapCount = 0;
  let resetTimer = 0;
  version.onclick = () => {
    tapCount += 1;
    window.clearTimeout(resetTimer);
    resetTimer = window.setTimeout(() => {
      tapCount = 0;
    }, 5000);
    if (tapCount >= 7) {
      tapCount = 0;
      navigate({ name: 'debugLog' });
    }
  };
  screen.append(version);
}

async function renderRoute(route: AppRoute, lease: RouteRenderLease): Promise<void> {
  const loadingTimer = window.setTimeout(() => {
    if (!lease.isCurrent()) return;
    renderLoading(root, loadingMessage(route));
  }, ROUTE_LOADING_DELAY_MS);
  try {
    if (route.name === 'debugLog') {
      if (lease.isCurrent()) renderDebugLogScreen(root, () => navigate({ name: 'home' }));
      return;
    }

    const nextPackView = await loadPacks();
    if (!lease.isCurrent()) return;
    packView = nextPackView;
    packViewLoaded = true;
    setActivePackAssetView(packView);

    const isCurrent = () => lease.isCurrent();
    switch (route.name) {
      case 'home':
        if (!isCurrent()) return;
        renderHomeScreen(
          root,
          packView,
          (moduleId) => navigate({ name: 'module', moduleId }),
          () => navigate({ name: 'review' }),
          () => navigate({ name: 'import' }),
          () => navigate({ name: 'graphs' })
        );
        if (!isCurrent()) return;
        appendHomeManagementLinks();
        appendMainNavigation('home');
        return;
      case 'module':
        await renderModuleScreen(
          root,
          packView,
          route.moduleId,
          () => navigate({ name: 'home' }),
          () => navigate({ name: 'review' }),
          () => navigate({ name: 'graphs' }),
          isCurrent
        );
        return;
      case 'review':
        await renderReviewCenter(
          root,
          packView,
          () => navigate({ name: 'home' }),
          () => navigate({ name: 'graphs' }),
          isCurrent
        );
        if (!isCurrent()) return;
        appendMainNavigation('review');
        return;
      case 'import':
        await renderImportScreen(
          root,
          packView,
          () => navigate({ name: 'home' }),
          async () => {
            invalidatePackView();
            navigate({ name: 'home' });
          },
          isCurrent
        );
        if (!isCurrent()) return;
        appendMainNavigation(undefined);
        return;
      case 'graphs':
        await renderGraphsScreen(
          root,
          packView,
          () => navigate({ name: 'home' }),
          () => navigate({ name: 'review' }),
          isCurrent
        );
        if (!isCurrent()) return;
        appendMainNavigation('graphs');
        return;
      case 'pdfWorksheet':
        if (!isCurrent()) return;
        await renderPdfWorksheetScreen(root, packView, () => navigate({ name: 'home' }));
        if (!isCurrent()) return;
        appendMainNavigation(undefined);
        return;
    }
  } finally {
    window.clearTimeout(loadingTimer);
    if (lease.isCurrent()) {
      root.inert = false;
      root.removeAttribute('aria-busy');
    }
  }
}

window.addEventListener('popstate', (event) => {
  const route = isAppRoute(event.state) ? event.state : routeFromUrl();
  startRouteRender(route);
});

const initialRoute = routeFromUrl();
history.replaceState(initialRoute, '', routeToUrl(initialRoute));
navigate(initialRoute, { replace: true });
