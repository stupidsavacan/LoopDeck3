import { version } from '../../package.json';
import { loadBuiltinPacks } from '../packs/builtinLoader';
import { resolveActivePacks, type ResolvedPackView } from '../packs/packResolver';
import { createQuestionImageAssetResolver } from '../packs/packAssetResolver';
import { studyStore, type StudyRepository } from '../storage/studyRepository';
import { renderHomeScreen } from '../screens/homeScreen';
import { renderModuleScreen } from '../screens/moduleScreen';
import { renderReviewCenter } from '../screens/reviewCenter';
import { renderGraphsScreen } from '../screens/graphsScreen';
import { renderImportScreen } from '../screens/importScreen';
import { renderPdfWorksheetScreen } from '../screens/pdfWorksheetScreen';
import { renderDebugLogScreen } from '../screens/debugLogScreen';
import { disposeInlineQuizzes } from '../screens/inlineQuiz';
import { renderBottomNav } from '../ui/bottomNav';
import { button, el } from '../ui/dom';
import { renderLoading } from '../ui/loading';
import { RouteRenderCoordinator, type RouteRenderLease } from '../ui/routeRenderGuard';
import { navigationFor, parseRoute, routeHash, type AppRoute, type ScreenContext, type Navigation } from './context';
import { renderStartupError } from './errorView';

type CatalogLoader = () => Promise<ResolvedPackView>;
interface ApplicationDependencies { store?: StudyRepository; loadCatalog?: CatalogLoader; }

async function loadCatalog(store: StudyRepository): Promise<ResolvedPackView> {
  return resolveActivePacks([...loadBuiltinPacks(), ...(await store.getImportedPacks())]);
}

/** Owns one mounted application; route leases prevent late work from publishing. */
export class StudyApplication {
  private readonly coordinator = new RouteRenderCoordinator();
  private readonly timers = new Set<number>();
  private catalog: ResolvedPackView = resolveActivePacks([]);
  private catalogLoaded = false;
  private active = false;
  private currentHash = '';

  private readonly catalogLoader: CatalogLoader;
  private readonly store: StudyRepository;
  constructor(private readonly root: HTMLElement, dependencies: ApplicationDependencies = {}) {
    this.store = dependencies.store ?? studyStore;
    this.catalogLoader = dependencies.loadCatalog ?? (() => loadCatalog(this.store));
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    window.addEventListener('popstate', this.locationChanged);
    window.addEventListener('hashchange', this.locationChanged);
    const route = parseRoute(location.hash);
    history.replaceState(null, '', routeHash(route));
    this.navigate(route);
  }

  dispose(): void {
    if (!this.active) return;
    this.active = false;
    this.coordinator.begin();
    window.removeEventListener('popstate', this.locationChanged);
    window.removeEventListener('hashchange', this.locationChanged);
    for (const timer of this.timers) window.clearTimeout(timer);
    this.timers.clear();
    disposeInlineQuizzes(this.root);
    this.root.inert = false;
    this.root.removeAttribute('aria-busy');
    this.root.replaceChildren();
  }

  navigate(route: AppRoute): void {
    if (!this.active) return;
    const hash = routeHash(route);
    if (location.hash !== hash) history.pushState(null, '', hash);
    this.currentHash = hash;
    disposeInlineQuizzes(this.root);
    const lease = this.coordinator.begin();
    this.root.inert = true;
    this.root.setAttribute('aria-busy', 'true');
    void this.render(route, lease).catch((error: unknown) => {
      if (this.active && lease.isCurrent()) renderStartupError(this.root, error);
    });
  }

  private readonly locationChanged = (): void => {
    if (!this.active || location.hash === this.currentHash) return;
    const route = parseRoute(location.hash);
    history.replaceState(null, '', routeHash(route));
    this.navigate(route);
  };

  private context(lease: RouteRenderLease): ScreenContext {
    return {
      root: this.root,
      store: this.store,
      catalog: this.catalog,
      navigation: navigationFor(route => { if (this.active && lease.isCurrent()) this.navigate(route); }),
      resolveImage: createQuestionImageAssetResolver(this.catalog, this.store),
      isCurrent: () => this.active && lease.isCurrent(),
      refreshCatalog: async () => {
        if (!this.active || !lease.isCurrent()) return;
        this.catalogLoaded = false;
        this.navigate({ name: 'home' });
      }
    };
  }

  private async render(route: AppRoute, lease: RouteRenderLease): Promise<void> {
    const current = () => this.active && lease.isCurrent();
    const timer = window.setTimeout(() => {
      if (current()) renderLoading(this.root, '読み込んでいます…');
    }, 2000);
    this.timers.add(timer);
    try {
      if (route.name !== 'debugLog' && !this.catalogLoaded) {
        const next = await this.catalogLoader();
        if (!current()) return;
        this.catalog = next;
        this.catalogLoaded = true;
      }
      if (!current()) return;
      const context = this.context(lease);
      switch (route.name) {
        case 'home': renderHomeScreen(context); break;
        case 'module': await renderModuleScreen({ ...context, moduleId: route.moduleId }); break;
        case 'review': await renderReviewCenter(context); break;
        case 'graphs': await renderGraphsScreen(context); break;
        case 'import': await renderImportScreen(context); break;
        case 'pdfWorksheet': await renderPdfWorksheetScreen(context); break;
        case 'debugLog': renderDebugLogScreen(context); break;
      }
      if (current()) this.appendShell(route, context.navigation);
    } finally {
      window.clearTimeout(timer);
      this.timers.delete(timer);
      if (current()) {
        this.root.inert = false;
        this.root.removeAttribute('aria-busy');
      }
    }
  }

  private appendShell(route: AppRoute, navigation: Navigation): void {
    if (route.name === 'module' || route.name === 'debugLog') return;
    this.root.append(renderBottomNav(
      route.name === 'home' || route.name === 'review' || route.name === 'graphs' ? route.name : undefined,
      navigation.home, navigation.review, navigation.graphs
    ));
    if (route.name !== 'home') return;
    const screen = this.root.querySelector('main.home-screen');
    if (!screen) return;
    const tools = el('details', 'home-tools management-card');
    tools.dataset.homeManagement = 'true';
    tools.append(el('summary', 'home-tools-summary', '教材・データ・PDF'));
    const body = el('div', 'home-tools-body');
    const actions = el('div', 'update-actions');
    const materials = button('教材とデータを開く', 'tool-link');
    materials.onclick = navigation.import;
    const worksheet = button('PDFプリントを作る', 'tool-link secondary');
    worksheet.onclick = navigation.pdfWorksheet;
    actions.append(materials, worksheet);
    body.append(actions);
    tools.append(body);
    const diagnostics = button(`LoopDeck3 v${version} · 診断`, 'version-trigger');
    diagnostics.onclick = navigation.debugLog;
    screen.append(tools, diagnostics);
  }
}
