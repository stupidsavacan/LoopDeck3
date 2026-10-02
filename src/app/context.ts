import type { StudyRepository } from '../storage/studyRepository';
import type { QuestionImageAssetResolver } from '../packs/packAssetResolver';
import type { ResolvedPackView } from '../packs/packResolver';

export type AppRoute =
  | { name: 'home' | 'review' | 'import' | 'graphs' | 'pdfWorksheet' | 'debugLog' }
  | { name: 'module'; moduleId: string };

export interface Navigation {
  home(): void;
  module(moduleId: string): void;
  review(): void;
  import(): void;
  graphs(): void;
  pdfWorksheet(): void;
  debugLog(): void;
}

export interface ScreenContext {
  store: StudyRepository;
  root: HTMLElement;
  catalog: ResolvedPackView;
  navigation: Navigation;
  resolveImage: QuestionImageAssetResolver;
  isCurrent(): boolean;
  refreshCatalog(): Promise<void>;
}

const routes = { home: 'home', review: 'review', import: 'import', graphs: 'graphs', 'pdf-worksheet': 'pdfWorksheet', 'debug-log': 'debugLog' } as const;

export function parseRoute(hash: string): AppRoute {
  const value = hash.replace(/^#\/?/, '');
  if (value.startsWith('module/')) {
    try {
      const moduleId = decodeURIComponent(value.slice(7));
      if (moduleId) return { name: 'module', moduleId };
    } catch { /* Invalid URL encodings route to the library. */ }
  }
  if (Object.prototype.hasOwnProperty.call(routes, value)) return { name: routes[value as keyof typeof routes] };
  return { name: 'home' };
}

export function routeHash(route: AppRoute): string {
  if (route.name === 'module') return `#module/${encodeURIComponent(route.moduleId)}`;
  const entry = Object.entries(routes).find(([, name]) => name === route.name);
  if (!entry) throw new Error('Unknown application route.');
  return `#${entry[0]}`;
}

export function navigationFor(navigate: (route: AppRoute) => void): Navigation {
  return {
    home: () => navigate({ name: 'home' }),
    module: (moduleId) => navigate({ name: 'module', moduleId }),
    review: () => navigate({ name: 'review' }),
    import: () => navigate({ name: 'import' }),
    graphs: () => navigate({ name: 'graphs' }),
    pdfWorksheet: () => navigate({ name: 'pdfWorksheet' }),
    debugLog: () => navigate({ name: 'debugLog' })
  };
}
