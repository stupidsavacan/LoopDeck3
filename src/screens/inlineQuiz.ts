import { writeDebugLog } from '../debug/debugLog';
import { getCorrectAnswer, judgeInputAnswer, judgeQuestion, normalizeAnswerForQuestion } from '../core/answerJudge';
import { buildGeneratedChoiceOptions, type GeneratedChoiceOption } from '../core/choiceGenerator';
import type { AnswerConfidence, Attempt, Question } from '../core/models';
import { createIdleRevealController, type IdleRevealController } from '../core/idleRevealController';
import { resolveQuizAnswerMode } from '../core/quizAnswer';
import { createQuizBookmarkButton } from '../ui/quizBookmark';
import { currentQuestion, isSessionComplete, type QuizSession } from '../core/sessionEngine';
import { getPresentedStudyPair } from '../core/questionPresentation';
import { buildWrongAnswerFeedback, type WrongAnswerExplanation } from '../core/wrongAnswerExplanation';
import { type QuestionImageAssetResolver } from '../packs/packAssetResolver';
import { QuizController, type QuizPhase } from '../core/quizController';
import { countReadingChars } from '../core/answerTiming';
import type { QuizDataStore, SavedReview } from '../storage/storageTypes';
import { button, clear, el, toast } from '../ui/dom';
import { appendIconLabel, createUiIcon } from '../ui/icons';
import {
  appendQuizResult,
  markChoiceResults,
  renderNextActions,
  renderQuestionImage,
  renderQuizMeta,
  renderReviewSchedule,
  renderSessionSummary,
  type SessionNextSteps
} from '../ui/inlineQuizView';
import { renderQuestionVisualReferences } from '../ui/questionVisualReferences';
import { renderRivalDetour } from '../ui/rivalDetour';
import { speak, stopSpeaking, whenSpeechReady } from '../platform/speech';

export interface InlineQuizCallbacks {
  onSessionChange(session: QuizSession): void;
  onSessionCheckpoint?(session: QuizSession): void;
  onComplete(): void;
  /** Leave mid-session; the checkpoint keeps the session resumable. */
  onExit?(): void;
  /** Offered on the completion card; without it the card only returns to the module. */
  nextSteps?(session: QuizSession): SessionNextSteps;
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
function shuffled<T>(items: readonly T[]): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const target = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[target]] = [copy[target], copy[index]];
  }
  return copy;
}

/** Typing, or a control that handles its own keys, keeps the keyboard; shortcuts apply everywhere else. */
function ownsKeyboard(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON|SUMMARY)$/.test(target.tagName));
}

const CONFIDENCE_OPTIONS: Array<[AnswerConfidence, string]> = [
  ['sure', '自信あり'],
  ['unsure', 'うろ覚え'],
  ['guess', 'わからない']
];

/** Asked before answering; うろ覚え is preselected so it never blocks the answer. */
function createConfidencePicker(onChange: () => void): { element: HTMLElement; value(): AnswerConfidence; lock(): void } {
  let selected: AnswerConfidence = 'unsure';
  const element = el('div', 'confidence-picker');
  element.setAttribute('role', 'group');
  element.setAttribute('aria-label', '答える前に、どれくらい自信がありますか');
  element.append(el('span', 'confidence-label', 'どれくらい自信がある？'));
  const options = el('div', 'confidence-options');
  const buttons = CONFIDENCE_OPTIONS.map(([value, label]) => {
    const option = button(label, 'confidence-option');
    option.onclick = () => {
      selected = value;
      sync();
      onChange();
    };
    return [value, option] as const;
  });
  const sync = () => {
    for (const [value, option] of buttons) option.setAttribute('aria-pressed', String(value === selected));
  };
  sync();
  options.append(...buttons.map(([, option]) => option));
  element.append(options);
  return {
    element,
    value: () => selected,
    lock: () => {
      for (const [, option] of buttons) option.disabled = true;
    }
  };
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
      el('h3', '', `${session.queue.length}問おわりました`),
      renderSessionSummary(session)
    );
    const steps = callbacks.nextSteps?.(session);
    if (steps?.actions.length) {
      done.append(renderNextActions(steps));
    } else {
      const back = button('教材詳細に戻る', 'btn primary');
      back.onclick = callbacks.onComplete;
      done.append(back);
    }
    container.append(done);
    return;
  }

  const question = currentQuestion(session);
  if (!question) return;
  const activeQuestion: Question = question;
  const requestedAnswerFormat = session.settings.answerFormat ?? 'auto';
  const preferredAnswerFormat = session.preferredFormatByModuleId?.get(question.moduleId) ?? session.module.preferredAnswerFormat;
  const shouldGenerateChoices =
    question.type === 'input' &&
    (requestedAnswerFormat === 'choice' || (requestedAnswerFormat === 'auto' && preferredAnswerFormat === 'choice'));
  const generatedChoices =
    question.type === 'input' && shouldGenerateChoices
      ? buildGeneratedChoiceOptions(question, session.choicePool, 4, Math.random, session.choiceCandidateIndex)
      : undefined;
  const seenNativeChoices = new Set<string>();
  // The answer is listed first in the data, so the order is shuffled or the first option would always be right.
  const nativeChoices =
    question.type === 'choice'
      ? shuffled(
          [question.answer, ...question.choices].filter((choice) => {
            const key = normalizeAnswerForQuestion(question, choice);
            if (!key || seenNativeChoices.has(key) || (choice !== question.answer && judgeInputAnswer(question, choice))) return false;
            seenNativeChoices.add(key);
            return true;
          })
        )
      : [];
  const answerMode = resolveQuizAnswerMode(question, requestedAnswerFormat, generatedChoices, nativeChoices.length);
  const card = el('section', 'quiz-card');
  if (question.imageAsset) card.classList.add('with-question-image');
  const answerArea = el('div', 'answer-area');
  const controls = el('div', 'quiz-controls');
  const resultArea = el('div', 'result-area');
  let selectedAnswer: string | string[] = '';
  const choiceButtons = new Map<HTMLButtonElement, string>();
  let answerAttempt: Attempt | undefined;
  let nextButton: HTMLButtonElement | undefined;
  let composing = false;
  let idleController: IdleRevealController | undefined;
  let hintUsed = false;
  let stopWaitingForSpeech: () => void = () => undefined;
  let savedReview: SavedReview | undefined;
  const readingChars = countReadingChars(question.prompt, [
    ...nativeChoices,
    ...(generatedChoices ?? []).map((choice) => choice.text),
    ...(question.type === 'multi_select' ? question.choices : [])
  ]);

  function isCurrentRender(): boolean {
    return renderTokenByContainer.get(container) === renderToken && container.contains(card) && (options.isCurrent?.() ?? true);
  }

  const controller = new QuizController({
    session,
    question: activeQuestion,
    answerMode,
    isCurrent: isCurrentRender,
    persist: async (attempt) => {
      savedReview = (await studyStore.recordAnswer(attempt, session.sourceByQuestionId?.get(attempt.questionId))) ?? undefined;
    },
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
    onPersistenceChange: handlePersistenceChange,
    onAutoAdvanceScheduled: (delayMs) => {
      if (!nextButton) return;
      nextButton.style.setProperty('--auto-advance-ms', `${delayMs}ms`);
      nextButton.classList.add('is-auto-advancing');
    }
  });

  /** Any touch on the answered card means the learner is reading; the next question waits for their tap. */
  function holdAutoAdvance(event?: Event): void {
    if (event?.target instanceof Node && nextButton?.contains(event.target)) return;
    if (controller.holdAutoAdvance()) nextButton?.classList.remove('is-auto-advancing');
  }

  function stopObserving(): void {
    stopWaitingForSpeech();
    idleController?.dispose();
    idleController = undefined;
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    document.removeEventListener('keydown', handleShortcut);
    window.removeEventListener('pagehide', handlePageHide);
    window.removeEventListener('wheel', holdAutoAdvance);
    window.removeEventListener('touchmove', holdAutoAdvance);
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
    stopSpeaking();
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
  /** Number keys pick an option and Enter or Space moves on, so a keyboard never needs the mouse. */
  function handleShortcut(event: KeyboardEvent): void {
    if (!isCurrentRender() || event.altKey || event.ctrlKey || event.metaKey || ownsKeyboard(event.target)) return;
    if (controller.canAnswer && /^[1-9]$/.test(event.key)) {
      const option = [...choiceButtons.keys()][Number(event.key) - 1];
      if (!option || option.disabled) return;
      event.preventDefault();
      option.click();
      return;
    }
    if ((event.key === 'Enter' || event.key === ' ') && nextButton && !nextButton.hidden && !nextButton.disabled) {
      event.preventDefault();
      nextQuestion();
    }
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
      card.classList.add('is-answered');
      showReviewSchedule();
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
    if (!controller.canAnswer) return;
    // Looked up before grading so a confusion with another question is saved with the attempt.
    const feedback =
      !revealed && typeof answer === 'string' && !judgeQuestion(activeQuestion, answer)
        ? buildWrongAnswerFeedback(
            answerMode === 'input' ? 'input' : 'choice',
            answer,
            activeQuestion,
            session.choicePool.length ? session.choicePool : session.queue,
            session.wrongAnswerLookupIndex,
            generatedChoice?.origin
          )
        : undefined;
    const confusedWith =
      feedback?.matchKind === 'lookup' || feedback?.matchKind === 'exact_origin' ? feedback.matchedQuestionId : undefined;
    const attempt = controller.answer(answer, revealed, {
      confusedWithQuestionId: confusedWith,
      confidence: confidencePicker?.value(),
      readingChars,
      hintUsed
    });
    if (!attempt) return;
    answerAttempt = attempt;
    idleController?.dispose();
    idleController = undefined;
    lockAnswerControls();
    confidencePicker?.lock();
    // The hint and the answer are spent once the question is answered.
    hint.disabled = true;
    reveal.disabled = true;
    markChoiceResults(choiceButtons, activeQuestion, answer, revealed);
    const { result, nearMiss = false } = attempt;
    const wrongExplanation = result === 'wrong' ? feedback : undefined;
    appendQuizResult(resultArea, activeQuestion, result, nearMiss, wrongExplanation, wrongExplanation ? openDetour : undefined);
    void controller.save();
  }

  /** Where the answer put the card, with a one-tap correction for a correct answer the timing misjudged. */
  function showReviewSchedule(): void {
    const review = savedReview;
    const attempt = answerAttempt;
    if (!review || !attempt) return;
    const revise = studyStore.reviseAnswerRating?.bind(studyStore);
    const schedule = renderReviewSchedule(
      review,
      attempt.result === 'correct' && revise
        ? async (rating) => {
            holdAutoAdvance();
            if (!isCurrentRender()) return undefined;
            try {
              const revised = await revise(attempt.attemptId, rating);
              savedReview = revised;
              return revised;
            } catch (error) {
              writeDebugLog({
                level: 'warn',
                area: 'quizPersistence',
                code: 'RATING-REVISE-FAILED',
                userMessage: '判定を変更できませんでした。',
                detail: String(error)
              });
              toast('判定を変更できませんでした。');
              return undefined;
            }
          }
        : undefined
    );
    resultArea.querySelector('.review-schedule')?.remove();
    // One box says what happened and when it comes back, instead of two stacked boxes.
    const resultBox = resultArea.querySelector('.result');
    if (resultBox) resultBox.append(schedule);
    else resultArea.prepend(schedule);
  }

  /** Practice the confused pair without leaving this question; the answered card comes back as it was. */
  function openDetour(feedback: WrongAnswerExplanation): void {
    if (!isCurrentRender() || !feedback.pair) return;
    card.hidden = true;
    const presented = getPresentedStudyPair(activeQuestion);
    const answeredFront = feedback.matchRole === 'front' || feedback.matchRole === 'front_alias';
    const rival = answeredFront
      ? { prompt: feedback.pair.back.text, answer: feedback.pair.front.text }
      : { prompt: feedback.pair.front.text, answer: feedback.pair.back.text };
    const detour = renderRivalDetour({ prompt: presented.front.text, answer: presented.back.text }, rival, () => {
      detour.remove();
      card.hidden = false;
      card.scrollIntoView?.({ block: 'start' });
    });
    container.append(detour);
    detour.scrollIntoView?.({ block: 'start' });
  }

  const bookmark = createQuizBookmarkButton(question.id, isCurrentRender, studyStore);
  const confidencePicker = session.settings.askConfidence ? createConfidencePicker(resetIdleReveal) : undefined;

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
        choiceButtons.set(choiceButton, choice);
        list.append(choiceButton);
      }
    } else {
      for (const choice of generatedChoices ?? []) {
        const choiceButton = button(choice.text, 'choice-btn');
        choiceButton.onclick = () => {
          selectedAnswer = choice.text;
          record(choice.text, false, choice);
        };
        choiceButtons.set(choiceButton, choice.text);
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
      choiceButtons.set(choiceButton, choice);
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
    hintUsed = true;
    resetIdleReveal();
  };
  const reveal = button('', 'btn ghost');
  appendIconLabel(reveal, 'eye', '答えを見る');
  reveal.setAttribute('aria-label', '答えを見る');
  reveal.onclick = () => record(selectedAnswer, true);

  // Hidden until the browser reports a voice, so devices without one never see a dead button.
  const readAloud = button('', 'btn ghost speak-button');
  appendIconLabel(readAloud, 'speaker', '読み上げ');
  readAloud.setAttribute('aria-label', '読み上げ');
  readAloud.hidden = true;
  readAloud.onclick = () => {
    if (!isCurrentRender()) return;
    const correct = getCorrectAnswer(activeQuestion);
    speak(answerAttempt ? (Array.isArray(correct) ? correct.join('、') : correct) : activeQuestion.prompt);
  };

  const tools = el('div', 'v2-quiz-tools');
  tools.append(bookmark, hint, reveal, readAloud);

  const next = button('', 'btn prototype-next-ready');
  appendIconLabel(next, 'arrowRight', '次へ', 'end');
  next.disabled = true;
  next.hidden = true;
  next.onclick = nextQuestion;
  nextButton = next;
  controls.classList.add('quiz-next-controls');
  controls.append(next);

  const head = el('div', 'quiz-head');
  if (callbacks.onExit) {
    const exit = button('', 'btn ghost quiz-exit');
    exit.append(createUiIcon('close', 'quiz-exit-svg'));
    exit.setAttribute('aria-label', '学習を中断');
    exit.title = '学習を中断（続きから再開できます）';
    exit.onclick = () => {
      if (isCurrentRender()) callbacks.onExit?.();
    };
    head.append(exit);
  }
  head.append(renderQuizMeta(session, question));
  card.append(head, tools, el('h3', 'question-prompt', question.prompt));
  if (requestedAnswerFormat === 'choice' && answerMode === 'input') {
    card.append(el('p', 'notice', '安全な選択肢が不足しているため、この問題は入力で回答してください。'));
  }
  const image = renderQuestionImage(question, options.resolveImageAsset ?? (async () => undefined));
  if (image) card.append(image);
  const visualReferences = renderQuestionVisualReferences(question);
  if (visualReferences) card.append(visualReferences);
  if (confidencePicker) card.append(confidencePicker.element);
  card.append(answerArea, controls, resultArea);
  container.append(card);
  stopWaitingForSpeech = whenSpeechReady(() => {
    if (isCurrentRender()) readAloud.hidden = false;
  });
  window.requestAnimationFrame(() => {
    if (!isCurrentRender()) return;
    container.scrollIntoView?.({ block: 'start', inline: 'nearest', behavior: 'auto' });
  });
  document.addEventListener('visibilitychange', handleVisibilityChange);
  document.addEventListener('keydown', handleShortcut);
  window.addEventListener('pagehide', handlePageHide);
  card.addEventListener('pointerdown', holdAutoAdvance);
  card.addEventListener('focusin', holdAutoAdvance);
  window.addEventListener('wheel', holdAutoAdvance, { passive: true });
  window.addEventListener('touchmove', holdAutoAdvance, { passive: true });
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
