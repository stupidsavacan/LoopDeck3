import { writeDebugLog } from '../debug/debugLog';
import { el } from '../ui/dom';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function renderStartupError(root: HTMLElement, error: unknown): void {
  writeDebugLog({
    level: 'error',
    area: 'startup',
    code: 'APP-STARTUP',
    userMessage: 'LoopDeck3を起動できませんでした。',
    detail: errorMessage(error),
    stack: error instanceof Error ? error.stack : undefined
  });

  const screen = el('main', 'screen startup-error-screen');
  const card = el('section', 'editorial-system-state startup-error-card');
  const mark = el('div', 'system-state-mark error', '!');
  mark.setAttribute('aria-hidden', 'true');
  const copy = el('div', 'system-state-copy');
  copy.append(
    el('p', 'eyebrow', 'SYSTEM ERROR'),
    el('h1', '', 'LoopDeck3を起動できませんでした'),
    el('p', 'system-error-detail', errorMessage(error)),
    el('p', 'hint', 'アプリを再起動しても続く場合は、この画面の内容を確認してください。')
  );
  card.append(mark, copy);
  screen.append(card);
  root.replaceChildren(screen);
}
