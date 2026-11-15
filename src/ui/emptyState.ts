import { button, el } from './dom';
import { appendIconLabel, createUiIcon, type UiIconName } from './icons';

export interface EmptyStateOptions {
  icon: UiIconName;
  title: string;
  body: string;
  actionLabel: string;
  onAction: () => void;
}

/** One composed empty state (icon, headline, a line of copy, one action) instead of a stack of empty cards. */
export function renderEmptyState(options: EmptyStateOptions): HTMLElement {
  const box = el('section', 'editorial-empty');
  const icon = el('span', 'editorial-empty-icon');
  icon.append(createUiIcon(options.icon));
  const action = button('', 'btn primary editorial-empty-action');
  appendIconLabel(action, 'arrowRight', options.actionLabel, 'end');
  action.onclick = options.onAction;
  box.append(icon, el('h2', '', options.title), el('p', '', options.body), action);
  return box;
}
