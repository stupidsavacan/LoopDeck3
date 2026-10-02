import { writeDebugLog } from '../debug/debugLog';
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
export function renderStartupError(root: HTMLElement, error: unknown): void {
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
