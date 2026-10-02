import type { ScreenContext } from '../app/context';
import { clearDebugLogs, formatDebugLogsForCopy, readDebugLogs, writeDebugLog, type DebugLogEntry } from '../debug/debugLog';
import { button, clear, el, toast } from '../ui/dom';
import { appendIconLabel } from '../ui/icons';

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('ja-JP', { hour12: false });
}

function renderLogCard(log: DebugLogEntry): HTMLElement {
  const card = el('details', `debug-log-card ${log.level}`);
  const summary = el('summary', 'debug-log-summary');
  const head = el('div', 'debug-log-head');
  head.append(el('strong', '', formatDate(log.timestamp)), el('span', '', `${log.level.toUpperCase()} / ${log.area}`));
  const summaryMeta = el('div', 'debug-log-summary-meta');
  if (log.code) summaryMeta.append(el('code', '', log.code));
  if (log.userMessage) summaryMeta.append(el('span', '', log.userMessage));
  summary.append(head, summaryMeta);

  const details = el('div', 'debug-log-details');
  if (log.detail) details.append(el('p', 'hint', log.detail));
  if (log.route) details.append(el('small', '', `route: ${log.route}`));
  if (log.stack) {
    const stackDetails = el('details', 'debug-stack-details');
    const stackSummary = el('summary', '', 'スタックトレース');
    const stack = el('pre', 'debug-stack');
    stack.textContent = log.stack;
    stackDetails.append(stackSummary, stack);
    details.append(stackDetails);
  }

  card.append(summary, details);
  return card;
}

export function renderDebugLogScreen(context: ScreenContext): void {
  const { root: root } = context;
  const { home: navigateHome } = context.navigation;

  clear(root);
  const logs = readDebugLogs();
  const screen = el('main', 'screen debug-log-screen');
  const header = el('header', 'topbar');
  const back = button('', 'btn ghost');
  appendIconLabel(back, 'arrowLeft', 'ホーム');
  back.onclick = navigateHome;
  header.append(back);

  const hero = el('section', 'hero-card debug-hero');
  hero.append(
    el('p', 'eyebrow', 'DEVELOPER / SYSTEM LOG'),
    el('h1', '', 'デバッグログ'),
    el('p', '', '通常UIには出さない内部エラーコードや例外情報を確認します。')
  );
  const stats = el('div', 'stats-row');
  stats.append(el('span', '', `${logs.length}件`));
  hero.append(stats);

  const actions = el('section', 'debug-actions');
  const copy = button('', 'btn primary');
  appendIconLabel(copy, 'copy', 'ログをコピー');
  copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(formatDebugLogsForCopy(readDebugLogs()));
      toast('デバッグログをコピーしました。');
    } catch (error) {
      writeDebugLog({
        level: 'error',
        area: 'debugLog',
        code: 'DBG-COPY',
        userMessage: 'コピーできませんでした。',
        detail: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
      toast('コピーできませんでした。');
    }
  };

  const clearButton = button('', 'btn ghost danger');
  appendIconLabel(clearButton, 'trash', 'ログを消去');
  clearButton.onclick = () => {
    if (!window.confirm('ログをすべて消去しますか？')) return;
    clearDebugLogs();
    toast('デバッグログを消去しました。');
    renderDebugLogScreen(context);
  };
  actions.append(copy, clearButton);

  const list = el('section', 'debug-log-list');
  if (!logs.length) {
    list.append(el('p', 'empty', 'まだログはありません。'));
  } else {
    for (const log of logs) list.append(renderLogCard(log));
  }

  screen.append(header, hero, actions, list);
  root.append(screen);
}
