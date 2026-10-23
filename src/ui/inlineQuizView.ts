import { getCorrectAnswer, judgeInputAnswer, normalizeAnswer } from '../core/answerJudge';
import type { Attempt, Question } from '../core/models';
import { getPresentedStudyPair, type StudyPair } from '../core/questionPresentation';
import { elapsedForSession, type QuizSession } from '../core/sessionEngine';
import type { WrongAnswerExplanation } from '../core/wrongAnswerExplanation';
import { isSafeImageAssetRef, isSafeImageDataUrl } from '../packs/assetSafety';
import type { QuestionImageAssetResolver } from '../packs/packAssetResolver';
import { el } from '../ui/dom';

const IMAGE_MISSING_MESSAGE = '画像参照は保持されていますが、画像ファイルが見つかりません。';
const IMAGE_UNSAFE_MESSAGE = '画像参照は保持されています。表示は未実装または安全でない参照のためスキップしました。';
const IMAGE_LOAD_ERROR_MESSAGE = '画像参照は保持されています。画像ファイルはまだ表示できません。';

function answerToText(answer: string | string[]): string {
  return Array.isArray(answer) ? answer.join(' / ') : answer;
}

function wrongAnswerLabel(source: WrongAnswerExplanation['source']): string {
  return source === 'choice'
    ? '\u9078\u3093\u3060\u7b54\u3048\u306b\u3064\u3044\u3066'
    : '\u5165\u529b\u3057\u305f\u7b54\u3048\u306b\u3064\u3044\u3066';
}

function wrongAnswerFallback(source: WrongAnswerExplanation['source']): string {
  return source === 'choice'
    ? '\u3053\u306e\u9078\u629e\u80a2\u306f\u3001\u3053\u306e\u554f\u984c\u306e\u7b54\u3048\u3067\u306f\u3042\u308a\u307e\u305b\u3093\u3002'
    : '\u5165\u529b\u3057\u305f\u7b54\u3048\u306f\u3001\u3053\u306e\u554f\u984c\u306e\u7b54\u3048\u3067\u306f\u3042\u308a\u307e\u305b\u3093\u3002';
}

function appendExplanation(container: HTMLElement, className: string, label: string, text: string): void {
  const node = el('p', `explanation ${className}`);
  node.append(el('strong', '', `${label}\uff1a`), document.createTextNode(text));
  container.append(node);
}

function pairText(explanation: WrongAnswerExplanation): string | undefined {
  if (!explanation.pair) return undefined;
  const { front, back } = explanation.pair;
  const alias =
    explanation.matchRole === 'acceptable_answer' ||
    explanation.matchRole === 'accepted_answer' ||
    explanation.matchRole === 'front_alias' ||
    explanation.matchRole === 'back_alias';
  const multipleRoles = explanation.matchKind === 'lookup' && (explanation.alternatives?.length ?? 0) > 1;
  const aliasNote = alias
    ? ` / \u300c${explanation.value}\u300d\u306f\u767b\u9332\u6e08\u307f\u306e\u5225\u89e3\u30fb\u8868\u73fe\u306e1\u3064\u3067\u3059\u3002`
    : '';
  const roleNote = multipleRoles
    ? ` / \u300c${explanation.value}\u300d\u306f\u540c\u3058\u554f\u984c\u5185\u306e\u8907\u6570\u306e\u767b\u9332\u6b04\u306b\u4e00\u81f4\u3057\u307e\u3059\u3002`
    : '';
  return `${front.label}: ${front.text} / ${back.label}: ${back.text}${aliasNote}${roleNote}`;
}

function matchedSideOf(explanation: WrongAnswerExplanation): 'front' | 'back' {
  return explanation.matchRole === 'front' || explanation.matchRole === 'front_alias' ? 'front' : 'back';
}

/** The table shows the details, so one plain sentence says where the answer came from. */
function confusionNote(explanation: WrongAnswerExplanation, pair: StudyPair): string {
  const alias =
    explanation.matchRole === 'acceptable_answer' ||
    explanation.matchRole === 'accepted_answer' ||
    explanation.matchRole === 'front_alias' ||
    explanation.matchRole === 'back_alias';
  const label = pair[matchedSideOf(explanation)].label;
  return `「${explanation.value}」は、右の問題の「${label}」${alias ? 'の別の言い方' : ''}です。`;
}

function confusionCell(heading: string, pair: StudyPair, matchedSide?: 'front' | 'back'): HTMLElement {
  const cell = el('div', 'confusion-column');
  cell.append(el('span', 'confusion-heading', heading));
  for (const side of ['front', 'back'] as const) {
    const row = el('div', side === matchedSide ? 'confusion-side is-match' : 'confusion-side');
    row.append(el('span', 'confusion-label', pair[side].label), el('strong', 'confusion-text', pair[side].text));
    cell.append(row);
  }
  return cell;
}

/** Side-by-side view of the current question and the question the learner's answer belongs to. */
export function renderConfusionTable(current: Question, explanation: WrongAnswerExplanation): HTMLElement | undefined {
  if ((explanation.matchKind !== 'lookup' && explanation.matchKind !== 'exact_origin') || !explanation.pair) return undefined;
  const matchedSide = matchedSideOf(explanation);
  const table = el('div', 'confusion-table');
  table.setAttribute('role', 'group');
  table.setAttribute('aria-label', '問題の比較');
  table.append(
    confusionCell('この問題', getPresentedStudyPair(current)),
    confusionCell(`「${explanation.value}」が答えの問題`, explanation.pair, matchedSide)
  );
  return table;
}

function appendWrongAnswerExplanation(container: HTMLElement, question: Question, explanation: WrongAnswerExplanation | undefined): void {
  if (!explanation) return;
  const label = wrongAnswerLabel(explanation.source);
  if (explanation.matchKind === 'not_found' || !explanation.found) {
    appendExplanation(container, 'wrong-answer-explanation', label, wrongAnswerFallback(explanation.source));
    return;
  }

  const table = renderConfusionTable(question, explanation);
  if (table && explanation.pair) {
    const block = el('div', 'explanation wrong-answer-explanation');
    const intro = el('p');
    intro.append(el('strong', '', `${label}：`), document.createTextNode(confusionNote(explanation, explanation.pair)));
    block.append(intro, table);
    container.append(block);
    return;
  }

  if (explanation.matchKind === 'ambiguous') {
    const alternatives = explanation.alternatives ?? [];
    const summaries = alternatives.map((alternative) => {
      if (!alternative.pair) return alternative.matchedAnswer;
      return `${alternative.pair.front.label}: ${alternative.pair.front.text} / ${alternative.pair.back.label}: ${alternative.pair.back.text}`;
    });
    appendExplanation(
      container,
      'wrong-answer-explanation',
      label,
      `\u300c${explanation.value}\u300d\u306f\u8907\u6570\u306e\u554f\u984c\u30fb\u767b\u9332\u8868\u73fe\u306b\u4e00\u81f4\u3057\u307e\u3059\u3002 ${summaries.join(' / ')}`
    );
    return;
  }

  const matched = explanation.matchedAnswer ?? explanation.value;
  appendExplanation(container, 'wrong-answer-explanation', label, pairText(explanation) ?? matched);
}

export function appendQuizResult(
  container: HTMLElement,
  question: Question,
  result: Attempt['result'],
  elapsedMs: number,
  nearMiss = false,
  wrongExplanation?: WrongAnswerExplanation
): void {
  const resultBox = el('div', result === 'correct' ? 'result correct' : 'result wrong');
  resultBox.append(
    el('strong', '', result === 'revealed' ? '答え表示' : result === 'correct' ? '正解' : '不正解'),
    el('span', '', `答え：${answerToText(getCorrectAnswer(question))}`),
    el('small', '', `${Math.round(elapsedMs / 100) / 10}秒`)
  );
  if (nearMiss) resultBox.append(el('span', 'near-miss-note', 'かなり近い答えです。復習優先度は軽めに記録しました。'));
  container.append(resultBox);
  appendResultTabs(container, resultPanels(question, result, wrongExplanation));
}

interface ResultPanel {
  id: 'correct' | 'picked' | 'more';
  label: string;
  fill(panel: HTMLElement): void;
}

function resultPanels(question: Question, result: Attempt['result'], wrongExplanation?: WrongAnswerExplanation): ResultPanel[] {
  const panels: ResultPanel[] = [];
  const correctText = question.explanation;
  if (correctText) {
    panels.push({
      id: 'correct',
      label: '正解の解説',
      fill: (panel) => appendExplanation(panel, 'correct-answer-explanation', '正解の解説', correctText)
    });
  }
  if (result !== 'wrong' || !wrongExplanation) return panels;
  panels.push({
    id: 'picked',
    label: wrongExplanation.source === 'choice' ? '選んだ答え' : '入力した答え',
    fill: (panel) => appendWrongAnswerExplanation(panel, question, wrongExplanation)
  });
  const supplement = wrongExplanation.found && wrongExplanation.matchKind !== 'ambiguous' ? wrongExplanation.explanation : undefined;
  if (supplement) {
    panels.push({
      id: 'more',
      label: '補足',
      fill: (panel) => appendExplanation(panel, 'wrong-answer-supplement', '補足', supplement)
    });
  }
  return panels;
}

let resultTabSequence = 0;

/** Several explanations become tabs; the learner's own answer opens first after a miss. */
function appendResultTabs(container: HTMLElement, panels: ResultPanel[]): void {
  if (panels.length <= 1) {
    panels[0]?.fill(container);
    return;
  }
  const prefix = `result-tab-${++resultTabSequence}`;
  const initial = Math.max(
    0,
    panels.findIndex((panel) => panel.id === 'picked')
  );
  const tabs = el('div', 'result-tabs');
  const list = el('div', 'result-tab-list');
  list.setAttribute('role', 'tablist');
  list.setAttribute('aria-label', '解説');
  const buttons: HTMLButtonElement[] = [];
  const bodies: HTMLElement[] = [];

  const select = (index: number, focus = false) => {
    buttons.forEach((tab, tabIndex) => {
      const selected = tabIndex === index;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      bodies[tabIndex].hidden = !selected;
    });
    if (focus) buttons[index].focus();
  };

  panels.forEach((panel, index) => {
    const tab = el('button', 'result-tab', panel.label) as HTMLButtonElement;
    tab.type = 'button';
    tab.id = `${prefix}-${panel.id}`;
    tab.dataset.panel = panel.id;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', `${tab.id}-panel`);
    tab.onclick = () => select(index);
    tab.onkeydown = (event) => {
      if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
      event.preventDefault();
      const step = event.key === 'ArrowRight' ? 1 : -1;
      select((index + step + panels.length) % panels.length, true);
    };
    const body = el('div', 'result-tab-panel');
    body.id = `${tab.id}-panel`;
    body.dataset.panel = panel.id;
    body.setAttribute('role', 'tabpanel');
    body.setAttribute('aria-labelledby', tab.id);
    panel.fill(body);
    buttons.push(tab);
    bodies.push(body);
    list.append(tab);
  });
  tabs.append(list, ...bodies);
  container.append(tabs);
  select(initial);
}

function isCorrectChoice(question: Question, choice: string): boolean {
  if (question.type === 'multi_select')
    return question.correctChoices.some((answer) => normalizeAnswer(answer) === normalizeAnswer(choice));
  return judgeInputAnswer(question, choice);
}

/** After answering, show which choice was right and which one the learner picked. */
export function markChoiceResults(
  buttons: ReadonlyMap<HTMLButtonElement, string>,
  question: Question,
  answer: string | string[],
  revealed: boolean
): void {
  const picked = new Set(revealed ? [] : Array.isArray(answer) ? answer : [answer]);
  for (const [choiceButton, choice] of buttons) {
    const correct = isCorrectChoice(question, choice);
    const chosen = picked.has(choice);
    if (!correct && !chosen) continue;
    choiceButton.classList.add(correct ? 'is-correct' : 'is-wrong-pick');
    if (chosen) choiceButton.classList.add('is-picked');
    choiceButton.append(el('span', 'choice-mark', correct ? (chosen ? '正解・あなたの答え' : '正解') : 'あなたの答え'));
  }
}

function fallback(message: string): HTMLElement {
  return el('p', 'image-fallback', message);
}

export function renderQuestionImage(question: Question, resolveImageAsset: QuestionImageAssetResolver): HTMLElement | undefined {
  if (!question.imageAsset) return undefined;
  if (!isSafeImageAssetRef(question.imageAsset)) return fallback(IMAGE_UNSAFE_MESSAGE);
  const mount = el('div', 'question-image-mount');
  mount.append(fallback('画像を読み込んでいます。'));
  void resolveImageAsset(question)
    .then((resolvedAsset) => {
      if (!resolvedAsset) {
        mount.replaceChildren(fallback(IMAGE_MISSING_MESSAGE));
        return;
      }
      if (!isSafeImageDataUrl(resolvedAsset) && !isSafeImageAssetRef(resolvedAsset)) {
        mount.replaceChildren(fallback(IMAGE_UNSAFE_MESSAGE));
        return;
      }
      const image = el('img', 'question-image') as HTMLImageElement;
      image.src = resolvedAsset;
      image.alt = '問題資料画像';
      image.loading = 'lazy';
      image.onerror = () => mount.replaceChildren(fallback(IMAGE_LOAD_ERROR_MESSAGE));
      mount.replaceChildren(image);
    })
    .catch(() => mount.replaceChildren(fallback(IMAGE_LOAD_ERROR_MESSAGE)));
  return mount;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}分${String(seconds).padStart(2, '0')}秒` : `${seconds}秒`;
}

export function renderQuizMeta(session: QuizSession, question: Question): HTMLElement {
  const wrap = el('div', 'quiz-meta-wrap');
  const meta = el('div', 'quiz-meta');
  meta.append(el('span', '', `${session.index + 1} / ${session.queue.length}`));
  if (session.settings.showNumber && question.number) meta.append(el('span', '', `No.${question.number}`));
  if (session.settings.showCategory && question.category) meta.append(el('span', '', question.category));

  const progress = session.queue.length > 0 ? Math.min(100, ((session.index + 1) / session.queue.length) * 100) : 0;
  const progressNode = el('div', 'quiz-progress');
  progressNode.setAttribute('role', 'progressbar');
  progressNode.setAttribute('aria-label', '学習進捗');
  progressNode.setAttribute('aria-valuemin', '0');
  progressNode.setAttribute('aria-valuemax', '100');
  progressNode.setAttribute('aria-valuenow', String(Math.round(progress)));
  const fill = el('div', 'quiz-progress-fill') as HTMLDivElement;
  fill.style.width = `${progress}%`;
  progressNode.append(fill);

  wrap.append(meta, progressNode);
  return wrap;
}

function summaryGrid(items: Array<[string, string]>, className = 'session-summary-grid'): HTMLElement {
  const grid = el('div', className);
  for (const [label, value] of items) {
    const item = el('div', 'summary-stat');
    item.append(el('span', '', label), el('strong', '', value));
    grid.append(item);
  }
  return grid;
}

export function renderSessionSummary(session: QuizSession, now = Date.now()): HTMLElement {
  const attempts = session.attempts;
  const correct = attempts.filter((attempt) => attempt.result === 'correct').length;
  const wrong = attempts.filter((attempt) => attempt.result === 'wrong').length;
  const revealed = attempts.filter((attempt) => attempt.result === 'revealed').length;
  const nearMiss = attempts.filter((attempt) => attempt.nearMiss).length;
  const answered = attempts.length;
  const accuracy = answered > 0 ? Math.round((correct / answered) * 100) : 0;
  const elapsed = elapsedForSession(session, 0, now);
  const average = answered > 0 ? attempts.reduce((sum, attempt) => sum + attempt.elapsedMs, 0) / answered : 0;

  const summary = el('div', 'session-summary');
  summary.append(
    summaryGrid(
      [
        ['正解', `${correct}問`],
        ['ミス', `${wrong}問`],
        ['所要時間', formatDuration(elapsed)]
      ],
      'session-summary-grid session-summary-main'
    )
  );
  const more = el('details', 'session-summary-more');
  more.append(
    el('summary', '', '詳しい記録'),
    summaryGrid([
      ['正答率', `${accuracy}%`],
      ['答え表示', `${revealed}問`],
      ['ニアミス', `${nearMiss}問`],
      ['学習問題数', `${session.queue.length}問`],
      ['回答記録', `${answered}件`],
      ['平均回答時間', answered > 0 ? `${Math.round(average / 100) / 10}秒 / 問` : '記録なし']
    ])
  );
  summary.append(more);
  return summary;
}

export interface SessionNextAction {
  id: 'retry-mistakes' | 'continue' | 'finish';
  label: string;
  detail?: string;
  primary?: boolean;
  run(): void;
}

export interface SessionNextSteps {
  actions: SessionNextAction[];
  /** One line about tomorrow's reviews; resolves after the summary is already on screen. */
  preview?: Promise<string | undefined>;
}

/** The end of a session offers what to do next instead of only a way back. */
export function renderNextActions(steps: SessionNextSteps): HTMLElement {
  const section = el('section', 'next-actions');
  section.setAttribute('aria-label', '次にやること');
  section.append(el('h4', 'next-actions-title', '次にやること'));
  const list = el('div', 'next-actions-list');
  for (const action of steps.actions) {
    const item = el('button', action.primary ? 'next-action primary' : 'next-action') as HTMLButtonElement;
    item.type = 'button';
    item.dataset.action = action.id;
    item.append(el('strong', 'next-action-label', action.label));
    if (action.detail) item.append(el('span', 'next-action-detail', action.detail));
    item.onclick = () => action.run();
    list.append(item);
  }
  section.append(list);
  if (steps.preview) {
    const preview = el('p', 'next-preview');
    preview.hidden = true;
    section.append(preview);
    void steps.preview
      .then((text) => {
        if (!text) return;
        preview.textContent = text;
        preview.hidden = false;
      })
      .catch(() => undefined);
  }
  return section;
}
