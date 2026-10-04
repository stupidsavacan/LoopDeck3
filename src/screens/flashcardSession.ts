import { resolveFlashcardGesture, restartFlashcardSession } from '../core/flashcard';
import { QuizController } from '../core/quizController';
import { currentQuestion, isSessionComplete, type QuizSession } from '../core/sessionEngine';
import { writeDebugLog } from '../debug/debugLog';
import { button, clear, el, toast } from '../ui/dom';
import { renderFlashcardFace, renderFlashcardHeader, renderFlashcardProgress, renderFlashcardResult } from '../ui/flashcardView';
import type { InlineQuizCallbacks, InlineQuizOptions } from './inlineQuiz';

export type FlashcardSessionCallbacks = InlineQuizCallbacks;
export type FlashcardSessionOptions = InlineQuizOptions;
const cleanupByContainer = new WeakMap<HTMLElement, () => void>();
const tokenByContainer = new WeakMap<HTMLElement, symbol>();

export function disposeFlashcardSessions(root: HTMLElement): void {
  for (const container of [root, ...root.querySelectorAll<HTMLElement>('[data-flashcard-session]')]) cleanupByContainer.get(container)?.();
}

export function renderFlashcardSession(
  container: HTMLElement,
  session: QuizSession,
  callbacks: FlashcardSessionCallbacks,
  options: FlashcardSessionOptions
): void {
  cleanupByContainer.get(container)?.();
  clear(container);
  container.dataset.flashcardSession = 'true';
  const token = Symbol('flashcard-render');
  tokenByContainer.set(container, token);
  const screen = el('section', 'flashcard-session');
  container.append(screen);
  const isCurrent = () => tokenByContainer.get(container) === token && container.contains(screen) && (options.isCurrent?.() ?? true);
  const back = () => {
    if (isCurrent()) callbacks.onComplete();
  };
  screen.append(renderFlashcardHeader(session, back));
  if (isSessionComplete(session)) {
    const restart = (onlyAgain: boolean) => {
      if (!isCurrent()) return;
      const next = restartFlashcardSession(session, onlyAgain);
      if (next.queue.length) callbacks.onSessionChange(next);
    };
    screen.classList.add('flashcard-complete');
    screen.append(
      renderFlashcardResult(
        session,
        () => restart(true),
        () => restart(false),
        back
      )
    );
    cleanupByContainer.set(container, () => {
      if (tokenByContainer.get(container) === token) {
        tokenByContainer.delete(container);
        cleanupByContainer.delete(container);
      }
    });
    return;
  }
  const question = currentQuestion(session);
  if (!question) return;
  screen.append(renderFlashcardProgress(session));
  const stage = el('section', 'flashcard-stage');
  const stack = el('div', 'flashcard-stack');
  const wrap = el('div', 'flashcard-wrap');
  wrap.setAttribute('role', 'button');
  wrap.tabIndex = 0;
  wrap.setAttribute('aria-label', '単語カード。タップで裏返す');
  const inner = el('div', 'flashcard-inner');
  const front = renderFlashcardFace(question, true, session, options.resolveImageAsset ?? (async () => undefined));
  const rear = renderFlashcardFace(question, false, session, options.resolveImageAsset ?? (async () => undefined));
  inner.append(front, rear);
  const knownLabel = el('span', 'flashcard-judge-label known');
  const againLabel = el('span', 'flashcard-judge-label again');
  knownLabel.append(el('span', '', 'SWIPE RIGHT'), el('strong', '', 'KNOWN'));
  againLabel.append(el('span', '', 'SWIPE LEFT'), el('strong', '', 'AGAIN'));
  knownLabel.setAttribute('aria-hidden', 'true');
  againLabel.setAttribute('aria-hidden', 'true');
  wrap.append(inner);
  stack.append(wrap);
  stage.append(stack, againLabel, knownLabel);
  const controls = el('div', 'flashcard-controls');
  const again = button('', 'btn flashcard-again');
  again.append(el('i', 'flashcard-arrow', '←'), document.createTextNode(' 知らない'));
  const flipButton = button('タップで表 / 裏', 'btn ghost flashcard-flip');
  const known = button('', 'btn flashcard-known');
  known.append(document.createTextNode('知ってる '), el('i', 'flashcard-arrow', '→'));
  controls.append(again, flipButton, known);
  const status = el('div', 'flashcard-status');
  status.setAttribute('aria-live', 'polite');
  screen.append(stage, controls, el('p', 'flashcard-key-hint', 'Space = flip · ← / → = judge'), status);

  let flipped = false;
  let locked = false;
  let pointerId: number | null = null;
  let startX = 0,
    startY = 0,
    startTime = 0,
    moved = false;
  let exitFinished = false;
  let exitTimer: ReturnType<typeof setTimeout> | undefined;
  let judgmentKnown = false;
  const frames = new Set<number>();
  const frame = (callback: () => void) => {
    const id = window.requestAnimationFrame(() => {
      frames.delete(id);
      if (isCurrent()) callback();
    });
    frames.add(id);
  };

  const controller = new QuizController({
    session,
    question,
    answerMode: 'flashcard',
    isCurrent,
    persist: (attempt) => options.store.recordAnswer(attempt, session.sourceByQuestionId?.get(attempt.questionId)),
    onAdvance: (next) => {
      cleanup();
      callbacks.onSessionChange(next);
    },
    onCheckpoint: callbacks.onSessionCheckpoint,
    onCheckpointError: (error) => {
      writeDebugLog({
        level: 'warn',
        area: 'flashcard',
        code: 'SESSION-CHECKPOINT-FAILED',
        userMessage: '再開位置を保存できませんでした。',
        detail: String(error)
      });
      toast('回答は保存済みですが、再開位置を保存できませんでした。');
    },
    onPersistenceChange: (phase, error) => {
      if (phase === 'saving') {
        clear(status);
        status.append(el('p', '', '判定を保存しています…'));
        beginExit();
      } else if (phase === 'saved') {
        clear(status);
        if (exitFinished) controller.advance();
      } else {
        if (exitTimer !== undefined) clearTimeout(exitTimer);
        exitTimer = undefined;
        exitFinished = false;
        wrap.style.opacity = '1';
        wrap.style.transform = 'none';
        wrap.style.transition = 'transform 180ms cubic-bezier(.2,.8,.2,1), opacity 180ms ease';
        clear(status);
        status.append(el('p', 'issue error', '判定を保存できませんでした。再試行してください。'));
        const retry = button('保存を再試行', 'btn primary');
        retry.onclick = () => {
          if (isCurrent()) void controller.save();
        };
        status.append(retry);
        writeDebugLog({
          level: 'error',
          area: 'flashcard',
          code: 'ANSWER-PERSIST-FAILED',
          userMessage: '判定の保存に失敗しました。',
          detail: String(error)
        });
      }
    }
  });

  function beginExit(): void {
    if (exitTimer !== undefined) clearTimeout(exitTimer);
    exitFinished = false;
    wrap.style.transition = 'transform 280ms cubic-bezier(.3,.8,.3,1), opacity 240ms ease';
    wrap.style.transform = `translate3d(${judgmentKnown ? 115 : -115}%, 0, 0) rotate(${judgmentKnown ? 10 : -10}deg)`;
    wrap.style.opacity = '0';
    exitTimer = setTimeout(() => {
      exitTimer = undefined;
      if (!isCurrent()) return;
      exitFinished = true;
      if (controller.phase === 'saved') controller.advance();
    }, 270);
  }
  function judge(isKnown: boolean): void {
    if (locked || !isCurrent() || !controller.canAnswer) return;
    if (!controller.gradeFlashcard(isKnown)) return;
    locked = true;
    judgmentKnown = isKnown;
    wrap.setAttribute('aria-disabled', 'true');
    for (const control of [again, flipButton, known]) control.disabled = true;
    void controller.save();
  }
  function flip(): void {
    if (locked || !isCurrent()) return;
    frame(() => {
      if (locked) return;
      flipped = !flipped;
      wrap.classList.toggle('is-flipped', flipped);
      front.setAttribute('aria-hidden', String(flipped));
      rear.setAttribute('aria-hidden', String(!flipped));
      wrap.setAttribute('aria-label', `単語カード。${flipped ? '裏' : '表'}を表示中。タップで裏返す`);
    });
  }
  function releasePointer(): void {
    const id = pointerId;
    pointerId = null;
    if (id !== null && wrap.hasPointerCapture?.(id)) wrap.releasePointerCapture(id);
    wrap.classList.remove('dragging');
  }
  function snapBack(): void {
    wrap.style.transition = 'transform 180ms cubic-bezier(.2,.8,.2,1)';
    wrap.style.transform = 'none';
    knownLabel.style.opacity = againLabel.style.opacity = '0';
    knownLabel.classList.remove('show');
    againLabel.classList.remove('show');
  }
  function pointerDown(event: PointerEvent): void {
    if (locked || !isCurrent() || pointerId !== null || event.button !== 0) return;
    pointerId = event.pointerId;
    wrap.setPointerCapture?.(pointerId);
    startX = event.clientX;
    startY = event.clientY;
    startTime = performance.now();
    moved = false;
    wrap.classList.add('dragging');
    wrap.style.transition = 'none';
  }
  function pointerMove(event: PointerEvent): void {
    if (locked || event.pointerId !== pointerId || !isCurrent()) return;
    const dx = event.clientX - startX,
      dy = event.clientY - startY;
    if (Math.abs(dx) > 9 || Math.abs(dy) > 9) moved = true;
    const bounded = Math.max(-180, Math.min(180, dx));
    wrap.style.transform = `translate3d(${bounded}px, ${Math.abs(bounded) * 0.015}px, 0) rotate(${bounded * 0.025}deg)`;
    const alpha = Math.min(1, Math.abs(bounded) / 95);
    for (const [label, visible] of [
      [knownLabel, bounded > 0],
      [againLabel, bounded < 0]
    ] as const) {
      label.style.opacity = visible ? String(alpha) : '0';
      label.classList.toggle('show', visible && alpha > 0.18);
    }
  }
  function pointerUp(event: PointerEvent): void {
    if (event.pointerId !== pointerId || locked || !isCurrent()) return;
    const action = resolveFlashcardGesture(event.clientX - startX, event.clientY - startY, performance.now() - startTime, moved);
    releasePointer();
    if (action === 'known' || action === 'again') judge(action === 'known');
    else {
      snapBack();
      if (action === 'flip') flip();
    }
  }
  function cancelPointer(event: PointerEvent): void {
    if (event.pointerId !== pointerId) return;
    releasePointer();
    if (!locked) snapBack();
  }
  function keyDown(event: KeyboardEvent): void {
    if (
      event.repeat ||
      locked ||
      !isCurrent() ||
      (event.target instanceof HTMLElement && event.target !== wrap && event.target.closest('button, input, select, textarea'))
    )
      return;
    if (![' ', 'Enter', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    if (event.key === ' ' || event.key === 'Enter') flip();
    else judge(event.key === 'ArrowRight');
  }
  function visibilityChange(): void {
    controller.setHidden(document.hidden);
  }
  function pageHide(): void {
    controller.checkpoint();
  }
  function cleanup(): void {
    try {
      controller.checkpoint();
    } catch (error) {
      toast('再開位置を保存できませんでした。');
    }
    controller.dispose();
    releasePointer();
    if (exitTimer !== undefined) clearTimeout(exitTimer);
    for (const id of frames) window.cancelAnimationFrame(id);
    frames.clear();
    wrap.removeEventListener('pointerdown', pointerDown);
    wrap.removeEventListener('pointermove', pointerMove);
    wrap.removeEventListener('pointerup', pointerUp);
    wrap.removeEventListener('pointercancel', cancelPointer);
    wrap.removeEventListener('lostpointercapture', cancelPointer);
    document.removeEventListener('keydown', keyDown);
    document.removeEventListener('visibilitychange', visibilityChange);
    window.removeEventListener('pagehide', pageHide);
    if (tokenByContainer.get(container) === token) {
      tokenByContainer.delete(container);
      cleanupByContainer.delete(container);
    }
  }
  wrap.addEventListener('pointerdown', pointerDown);
  wrap.addEventListener('pointermove', pointerMove);
  wrap.addEventListener('pointerup', pointerUp);
  wrap.addEventListener('pointercancel', cancelPointer);
  wrap.addEventListener('lostpointercapture', cancelPointer);
  document.addEventListener('keydown', keyDown);
  document.addEventListener('visibilitychange', visibilityChange);
  window.addEventListener('pagehide', pageHide);
  again.onclick = () => judge(false);
  known.onclick = () => judge(true);
  flipButton.onclick = flip;
  cleanupByContainer.set(container, cleanup);
  controller.setHidden(document.hidden);
  wrap.style.transform = 'translate3d(0,12px,0) scale(.985)';
  frame(() =>
    frame(() => {
      if (!locked && pointerId === null) {
        wrap.style.transition = 'transform 250ms ease';
        wrap.style.transform = 'none';
      }
    })
  );
  frame(() => {
    wrap.focus({ preventScroll: true });
    container.scrollIntoView?.({ block: 'start', inline: 'nearest' });
  });
}
