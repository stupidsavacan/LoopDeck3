import type { Question } from '../core/models';
import { getPresentedStudyPair, getStudyQuestionModeLabel } from '../core/questionPresentation';
import type { QuizSession } from '../core/sessionEngine';
import type { QuestionImageAssetResolver } from '../packs/packAssetResolver';
import { button, el } from './dom';
import { renderQuestionImage } from './inlineQuizView';
import { renderQuestionVisualReferences } from './questionVisualReferences';

export function renderFlashcardHeader(session: QuizSession, onComplete: () => void): HTMLElement {
  const header = el('header', 'flashcard-header');
  const back = button('', 'btn ghost flashcard-back-button');
  back.setAttribute('aria-label', '教材へ戻る');
  back.append(el('b', '', '←'), el('span', '', '教材へ'));
  back.onclick = onComplete;
  const sample = session.choicePool.find((question) => question.id === session.queue[0]?.id) ?? session.queue[0];
  header.append(
    back,
    el('span', 'flashcard-brand', 'LOOPDECK · FLASHCARDS'),
    el('span', 'flashcard-direction', getStudyQuestionModeLabel(session.settings.questionMode ?? 'as_stored', sample))
  );
  return header;
}

export function renderFlashcardProgress(session: QuizSession): HTMLElement {
  const section = el('div', 'flashcard-progress-section');
  const row = el('div', 'flashcard-progress-row');
  const known = session.attempts.filter((attempt) => attempt.result === 'correct').length;
  const again = session.attempts.filter((attempt) => attempt.result === 'wrong').length;
  const position = el('div', 'flashcard-progress-heading');
  position.append(
    el('p', 'eyebrow', 'FLASHCARD SESSION'),
    el('strong', 'flashcard-position', `${Math.min(session.index + 1, session.queue.length)} / ${session.queue.length}`)
  );
  row.append(position, el('span', 'flashcard-counts', `KNOWN ${known} · AGAIN ${again}`));
  const progress = el('div', 'flashcard-progress');
  progress.setAttribute('role', 'progressbar');
  progress.setAttribute('aria-label', 'カード学習進捗');
  progress.setAttribute('aria-valuemin', '0');
  progress.setAttribute('aria-valuemax', String(session.queue.length));
  progress.setAttribute('aria-valuenow', String(session.index));
  const fill = el('span');
  fill.style.width = `${session.queue.length ? (session.index / session.queue.length) * 100 : 0}%`;
  progress.append(fill);
  section.append(row, progress);
  const question = session.queue[session.index];
  const meta = el('div', 'flashcard-meta');
  if (session.settings.showNumber && question?.number) meta.append(el('span', '', `No.${question.number}`));
  if (session.settings.showCategory && question?.category) meta.append(el('span', '', question.category));
  if (meta.childElementCount) section.append(meta);
  return section;
}

export function renderFlashcardFace(
  question: Question,
  front: boolean,
  session: QuizSession,
  resolveImage: QuestionImageAssetResolver
): HTMLElement {
  const pair = getPresentedStudyPair(question);
  const side = front ? pair.front : pair.back;
  const face = el('article', `flashcard-face ${front ? 'flashcard-front' : 'flashcard-back'}`);
  face.setAttribute('aria-hidden', String(!front));
  face.append(el('span', 'flashcard-side-label', side.label));
  const content = el('div', 'flashcard-content');
  const text = el('p', 'flashcard-term', side.text);
  if (/[\u3040-\u30ff\u3400-\u9fff]/.test(side.text) || side.text.length > 45) text.classList.add('jp');
  if (side.text.length > 90 || (front && question.imageAsset)) text.classList.add('long');
  if (front) {
    const image = renderQuestionImage(question, resolveImage);
    if (image) {
      face.classList.add('has-image');
      content.append(image);
    }
  }
  content.append(text);
  if (front) {
    const references = renderQuestionVisualReferences(question);
    if (references) content.append(references);
  } else {
    if (question.explanation) content.append(el('p', 'flashcard-explanation', question.explanation));
    if (session.settings.showExample && question.example) content.append(el('p', 'flashcard-example', question.example));
  }
  const hint = el('span', 'flashcard-flip-hint');
  hint.append(el('i', 'flashcard-tap-dot'), document.createTextNode('TAP TO FLIP'));
  face.append(content, hint);
  return face;
}

export function renderFlashcardResult(session: QuizSession, onAgain: () => void, onAll: () => void, onComplete: () => void): HTMLElement {
  const result = el('section', 'flashcard-result');
  const known = session.attempts.filter((attempt) => attempt.result === 'correct').length;
  const missed = session.attempts.filter((attempt) => attempt.result === 'wrong');
  const total = session.queue.length;
  const percentage = total ? Math.round((known / total) * 100) : 0;
  result.append(
    el('p', 'eyebrow', 'SESSION COMPLETE'),
    el('h1', '', 'おつかれさま。'),
    el('p', 'flashcard-result-description', `${total}枚を最後まで確認しました。知らなかったカードだけ、そのままもう一周できます。`)
  );
  const grid = el('div', 'flashcard-result-grid');
  const donutCard = el('div', 'flashcard-donut-card');
  const donut = el('div', 'flashcard-donut');
  donut.style.setProperty('--known', String(percentage));
  donut.setAttribute('role', 'img');
  donut.setAttribute('aria-label', `KNOWN ${known}枚、AGAIN ${missed.length}枚、知ってる割合 ${percentage}%`);
  const center = el('div', 'flashcard-donut-center');
  center.append(el('strong', '', `${percentage}%`), el('span', '', 'KNOWN'));
  donut.append(center);
  donutCard.append(donut);
  const stats = el('div', 'flashcard-result-stats');
  for (const [type, count, label] of [
    ['KNOWN', known, '知ってる'],
    ['AGAIN', missed.length, 'まだ知らない']
  ] as const) {
    const stat = el('div', `flashcard-stat ${type.toLowerCase()}`);
    stat.append(el('span', '', type), el('strong', '', String(count)), el('span', '', label));
    stats.append(stat);
  }
  const panel = el('section', 'flashcard-result-panel');
  panel.append(stats);
  grid.append(donutCard, panel);
  const missedSection = el('section', 'flashcard-missed');
  missedSection.append(el('h2', '', 'もう一度見るカード'));
  const chips = el('div', 'flashcard-missed-chips');
  for (const attempt of missed) {
    const question = session.queue.find(
      (question) =>
        question.id === attempt.questionId && (question.activeStudyMode ?? 'as_stored') === (attempt.questionMode ?? 'as_stored')
    );
    if (question) chips.append(el('span', 'flashcard-missed-chip', getPresentedStudyPair(question).front.text));
  }
  if (!missed.length) chips.append(el('p', '', 'なし'));
  missedSection.append(chips);
  const actions = el('div', 'flashcard-result-actions');
  const again = button('AGAINだけもう一度', 'btn primary');
  again.disabled = missed.length === 0;
  again.onclick = onAgain;
  const all = button('全部やり直す', 'btn');
  all.onclick = onAll;
  const back = button('教材へ戻る', 'btn ghost');
  back.onclick = onComplete;
  actions.append(again, all, back);
  panel.append(missedSection, actions);
  result.append(grid);
  return result;
}
