import type { ScreenContext } from '../app/context';
import type { ModuleInfo } from '../core/models';
import { getActiveModules } from '../packs/packResolver';
import { button, clear, el } from '../ui/dom';
import { createUiIcon, iconNameForModule } from '../ui/icons';
import { moduleMeta } from '../ui/modulePresentation';
import { buildHomeFolders, homeModuleMatches, type HomeFolder } from './homeFolders';

const HOME_LAST_MODULE_KEY = 'loopdeck3.library.last-module';
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
  const hero = el('section', 'hero');
  const heroCopy = el('div', 'hero-copy');
  heroCopy.append(
    (() => {
      const heading = el('h1');
      heading.setAttribute('aria-label', '今日は、何を学ぶ？');
      heading.append(
        el('span', 'home-heading-line', '今日は、'),
        document.createElement('br'),
        el('span', 'home-heading-line', '何を学ぶ？')
      );
      return heading;
    })(),
    el('p', '', '教材を開いたら、あとは問題だけに集中。必要なものを棚から選ぶだけ。')
  );
  hero.append(heroCopy);

  const toolbar = el('div', 'toolbar');
  const search = el('input', 'search') as HTMLInputElement;
  search.placeholder = '教材を検索';
  search.autocomplete = 'off';
  search.setAttribute('aria-label', '教材を検索');
  const showAll = button('すべて', 'filter');
  toolbar.append(search, showAll);

  const list = el('section', 'folder-list');
  list.setAttribute('aria-label', '教材一覧');

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

    card.append(top, el('p', 'desc', meta.description), tags);
    return card;
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

    const content = el('div', isOpen ? 'folder-content open' : 'folder-content');
    if (isOpen) for (const module of modules) content.append(renderModuleCard(module));
    head.onclick = () => {
      setFolderOpen(folder, !isOpen);
      renderList();
    };
    shell.append(head, content);
    return shell;
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

  const notice = el('div', 'notice');
  notice.append(
    el('b', '', '使い方：'),
    document.createTextNode('カードを押すと教材が開きます。主要画面の移動は下のナビゲーションからできます。')
  );

  screen.append(hero, toolbar, list, notice);
  root.append(screen);
  renderList();
}
