import { writeDebugLog } from '../debug/debugLog';
import { judgeInputAnswer, normalizeAnswerForQuestion } from '../core/answerJudge';
import { buildGeneratedChoiceOptions, type GeneratedChoiceOption } from '../core/choiceGenerator';
import type { Attempt, Question } from '../core/models';
import { createIdleRevealController, type IdleRevealController } from '../core/idleRevealController';
import { resolveQuizAnswerMode } from '../core/quizAnswer';
import { createQuizBookmarkButton } from '../ui/quizBookmark';
import { currentQuestion, isSessionComplete, type QuizSession } from '../core/sessionEngine';
import { buildWrongAnswerFeedback } from '../core/wrongAnswerExplanation';
import { type QuestionImageAssetResolver } from '../packs/packAssetResolver';
import { QuizController, type QuizPhase } from '../core/quizController';
import type { QuizDataStore } from '../storage/storageTypes';
import { button, clear, el, toast } from '../ui/dom';
import { appendIconLabel } from '../ui/icons';
import { appendQuizResult, renderQuestionImage, renderQuizMeta, renderSessionSummary } from '../ui/inlineQuizView';
import { renderQuestionVisualReferences } from '../ui/questionVisualReferences';

export interface InlineQuizCallbacks {
  onSessionChange(session: QuizSession): void;
  onSessionCheckpoint?(session: QuizSession): void;
  onComplete(): void;
}
export interface InlineQuizOptions {
  store: QuizDataStore;
  resolveImageAsset?: QuestionImageAssetResolver;
  isCurrent?: () => boolean;
}

const AUTO_REVEAL_IDLE_MS = 10_000;
const renderCleanupByContainer = new WeakMap<HTMLElement, () => void>();
const renderTokenByContainer = new WeakMap<HTMLElement, symbol>();
export function disposeInlineQuizzes(root: HTMLElement): void {
  for (const container of [root, ...root.querySelectorAll<HTMLElement>('[data-inline-quiz]')]) {
    renderCleanupByContainer.get(container)?.();
  }
}
export function renderInlineQuiz(
  container: HTMLElement,
  session: QuizSession,
  callbacks: InlineQuizCallbacks,
  options: InlineQuizOptions
): void {
  const { store: studyStore } = options;
  renderCleanupByContainer.get(container)?.();
  renderCleanupByContainer.delete(container);
  const renderToken = Symbol('inline-quiz-render');
  renderTokenByContainer.set(container, renderToken);
  container.dataset.inlineQuiz = 'true';
  clear(container);
  if (isSessionComplete(session)) {
    const done = el('div', 'quiz-card done');
    done.append(
      el('h3', '', 'セッション完了'),
      el('p', '', `${session.queue.length}問の学習が終わりました。`),
      renderSessionSummary(session)
    );
    const back = button('教材詳細に戻る', 'btn primary');
    back.onclick = callbacks.onComplete;
    done.append(back);
    container.append(done);
    return;
  }

  const question = currentQuestion(session);
  if (!question) return;
  const activeQuestion: Question = question;
  const requestedAnswerFormat = session.settings.answerFormat ?? 'auto';
  const shouldGenerateChoices =
    question.type === 'input' &&
    (requestedAnswerFormat === 'choice' || (requestedAnswerFormat === 'auto' && session.module.preferredAnswerFormat === 'choice'));
  const generatedChoices =
    question.type === 'input' && shouldGenerateChoices
      ? buildGeneratedChoiceOptions(question, session.choicePool, 4, Math.random, session.choiceCandidateIndex)
      : undefined;
  const seenNativeChoices = new Set<string>();
  const nativeChoices =
    question.type === 'choice'
      ? [question.answer, ...question.choices].filter((choice) => {
          const key = normalizeAnswerForQuestion(question, choice);
          if (!key || seenNativeChoices.has(key) || (choice !== question.answer && judgeInputAnswer(question, choice))) return false;
          seenNativeChoices.add(key);
          return true;
        })
      : [];
  const answerMode = resolveQuizAnswerMode(question, requestedAnswerFormat, generatedChoices, nativeChoices.length);
  const card = el('section', 'quiz-card');
  const answerArea = el('div', 'answer-area');
  const controls = el('div', 'quiz-controls');
  const resultArea = el('div', 'result-area');
  let selectedAnswer: string | string[] = '';
  let answerAttempt: Attempt | undefined;
  let nextButton: HTMLButtonElement | undefined;
  let composing = false;
  let idleController: IdleRevealController | undefined;

  function isCurrentRender(): boolean {
    return renderTokenByContainer.get(container) === renderToken && container.contains(card) && (options.isCurrent?.() ?? true);
  }

  const controller = new QuizController({
    session,
    question: activeQuestion,
    answerMode,
    isCurrent: isCurrentRender,
    persist: (attempt) => studyStore.recordAnswer(attempt, session.sourceByQuestionId?.get(attempt.questionId)),
    onAdvance: (next) => {
      cleanup();
      callbacks.onSessionChange(next);
    },
    onCheckpoint: callbacks.onSessionCheckpoint,
    onCheckpointError: (error) => {
      writeDebugLog({
        level: 'warn',
        area: 'quizPersistence',
        code: 'SESSION-CHECKPOINT-FAILED',
        userMessage: '再開位置を保存できませんでした。',
        detail: String(error)
      });
      toast('回答は保存済みですが、再開位置を保存できませんでした。');
    },
    onPersistenceChange: handlePersistenceChange
  });

  function stopObserving(): void {
    idleController?.dispose();
    idleController = undefined;
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    window.removeEventListener('pagehide', handlePageHide);
  }

  function cleanup(): void {
    try {
      controller.checkpoint();
    } catch (error) {
      writeDebugLog({
        level: 'warn',
        area: 'quizPersistence',
        code: 'SESSION-CHECKPOINT-FAILED',
        userMessage: '再開位置を保存できませんでした。',
        detail: String(error)
      });
    }
    stopObserving();
    controller.dispose();
    if (renderTokenByContainer.get(container) === renderToken) {
      renderTokenByContainer.delete(container);
      renderCleanupByContainer.delete(container);
    }
  }

  function resetIdleReveal(): void {
    idleController?.reset();
  }

  function handleVisibilityChange(): void {
    controller.setHidden(document.hidden);
    idleController?.setVisible(!document.hidden);
  }
  function handlePageHide(): void {
    controller.checkpoint();
  }

  function lockAnswerControls(): void {
    answerArea.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button').forEach((control) => {
      if (control instanceof HTMLInputElement) control.readOnly = true;
      control.disabled = true;
    });
  }

  function nextQuestion(): void {
    controller.advance();
  }
  function handlePersistenceChange(phase: Extract<QuizPhase, 'saving' | 'saved' | 'failed'>, error?: unknown): void {
    if (phase === 'saving') {
      resultArea.querySelector('.persistence-error')?.remove();
      return;
    }
    if (phase === 'saved') {
      if (nextButton) {
        nextButton.disabled = false;
        nextButton.hidden = false;
      }
      return;
    }
    console.error('Failed to persist answer/SRS state', error);
    const attempt = answerAttempt;
    writeDebugLog({
      level: 'error',
      area: 'quizPersistence',
      code: 'ANSWER-PERSIST-FAILED',
      userMessage: '回答の保存に失敗しました。',
      detail: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      context: attempt
        ? { attemptId: attempt.attemptId, questionId: attempt.questionId, moduleId: attempt.moduleId, result: attempt.result }
        : undefined
    });
    toast('回答の保存に失敗しました。再試行してください。');
    const errorBox = el('div', 'issue error persistence-error');
    errorBox.append(el('p', '', '回答を保存できませんでした。次へ進む前に再試行してください。'));
    const retry = button('保存を再試行', 'btn primary');
    retry.onclick = () => void controller.save();
    errorBox.append(retry);
    resultArea.append(errorBox);
  }

  function record(answer: string | string[], revealed = false, generatedChoice?: GeneratedChoiceOption): void {
    const attempt = controller.answer(answer, revealed);
    if (!attempt) return;
    answerAttempt = attempt;
    idleController?.dispose();
    idleController = undefined;
    lockAnswerControls();
    const { result, elapsedMs, nearMiss = false } = attempt;

    const wrongExplanation =
      !revealed && result === 'wrong' && typeof answer === 'string'
        ? buildWrongAnswerFeedback(
            answerMode === 'input' ? 'input' : 'choice',
            answer,
            activeQuestion,
            session.choicePool.length ? session.choicePool : session.queue,
            session.wrongAnswerLookupIndex,
            generatedChoice?.origin
          )
        : undefined;
    appendQuizResult(resultArea, activeQuestion, result, elapsedMs, nearMiss, wrongExplanation);
    void controller.save();
  }

  const bookmark = createQuizBookmarkButton(question.id, isCurrentRender, studyStore);

  if (session.settings.showExample && question.example) answerArea.append(el('p', 'example-line', question.example));
  if (answerMode === 'input') {
    const input = el('input', 'text-input') as HTMLInputElement;
    input.placeholder = '答えを入力';
    let lastInputValue = input.value;
    input.addEventListener('input', () => {
      if (composing || input.value === lastInputValue) return;
      lastInputValue = input.value;
      resetIdleReveal();
    });
    input.addEventListener('paste', resetIdleReveal);
    input.addEventListener('compositionstart', () => {
      composing = true;
      idleController?.setComposing(true);
    });
    input.addEventListener('compositionend', () => {
      composing = false;
      lastInputValue = input.value;
      idleController?.setComposing(false);
    });
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      if (composing || event.isComposing) return;
      event.preventDefault();
      record(input.value);
    });
    const submit = button('回答する', 'btn primary');
    submit.onclick = () => record(input.value);
    answerArea.append(input, submit);
    window.setTimeout(() => {
      if (isCurrentRender()) input.focus();
    }, 0);
  } else if (question.type === 'choice' || generatedChoices) {
    const list = el('div', 'choice-list');
    if (question.type === 'choice') {
      for (const choice of nativeChoices) {
        const choiceButton = button(choice, 'choice-btn');
        choiceButton.onclick = () => {
          selectedAnswer = choice;
          record(choice);
        };
        list.append(choiceButton);
      }
    } else {
      for (const choice of generatedChoices ?? []) {
        const choiceButton = button(choice.text, 'choice-btn');
        choiceButton.onclick = () => {
          selectedAnswer = choice.text;
          record(choice.text, false, choice);
        };
        list.append(choiceButton);
      }
    }
    answerArea.append(list);
  } else if (question.type === 'multi_select') {
    const selected = new Set<string>();
    const list = el('div', 'choice-list');
    for (const choice of question.choices) {
      const choiceButton = button(choice, 'choice-btn');
      choiceButton.setAttribute('aria-pressed', 'false');
      choiceButton.onclick = () => {
        if (selected.has(choice)) selected.delete(choice);
        else selected.add(choice);
        const selectedNow = selected.has(choice);
        choiceButton.classList.toggle('selected', selectedNow);
        choiceButton.setAttribute('aria-pressed', selectedNow ? 'true' : 'false');
        selectedAnswer = [...selected];
        resetIdleReveal();
      };
      list.append(choiceButton);
    }
    const submit = button('選択を確定', 'btn primary');
    submit.onclick = () => record([...selected]);
    answerArea.append(list, submit);
  }

  const hintText = session.settings.showExample ? undefined : question.example;
  const hint = button('', 'btn ghost');
  appendIconLabel(hint, 'hint', 'ヒント');
  hint.setAttribute('aria-label', 'ヒント');
  hint.disabled = !hintText;
  hint.onclick = () => {
    if (!isCurrentRender() || !hintText || resultArea.querySelector('.hint-panel')) return;
    resultArea.prepend(el('p', 'hint-panel', hintText));
    resetIdleReveal();
  };
  const reveal = button('', 'btn ghost');
  appendIconLabel(reveal, 'eye', '答えを見る');
  reveal.setAttribute('aria-label', '答えを見る');
  reveal.onclick = () => record(selectedAnswer, true);

  const tools = el('div', 'v2-quiz-tools');
  tools.append(bookmark, hint, reveal);

  const next = button('', 'btn prototype-next-ready');
  appendIconLabel(next, 'arrowRight', '次へ', 'end');
  next.disabled = true;
  next.hidden = true;
  next.onclick = nextQuestion;
  nextButton = next;
  controls.classList.add('quiz-next-controls');
  controls.append(next);

  card.append(renderQuizMeta(session, question), tools, el('h3', 'question-prompt', question.prompt));
  if (requestedAnswerFormat === 'choice' && answerMode === 'input') {
    card.append(el('p', 'notice', '安全な選択肢が不足しているため、この問題は入力で回答してください。'));
  }
  const image = renderQuestionImage(question, options.resolveImageAsset ?? (async () => undefined));
  if (image) card.append(image);
  const visualReferences = renderQuestionVisualReferences(question);
  if (visualReferences) card.append(visualReferences);
  card.append(answerArea, controls, resultArea);
  container.append(card);
  window.requestAnimationFrame(() => {
    if (!isCurrentRender()) return;
    container.scrollIntoView?.({ block: 'start', inline: 'nearest', behavior: 'auto' });
  });
  document.addEventListener('visibilitychange', handleVisibilityChange);
  window.addEventListener('pagehide', handlePageHide);
  renderCleanupByContainer.set(container, cleanup);
  if (session.settings.autoRevealAfterIdle) {
    idleController = createIdleRevealController({
      timeoutMs: AUTO_REVEAL_IDLE_MS,
      isEligible: () => controller.canAnswer && card.isConnected,
      onSuspend: (elapsed) => {
        controller.excludeSuspension(elapsed);
      },
      onReveal: () => record(selectedAnswer, true)
    });
    idleController.setVisible(!document.hidden);

    idleController.start();
  }
}
