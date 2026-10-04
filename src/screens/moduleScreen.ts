import type { ScreenContext } from '../app/context';
import { encodeStudyCategory } from '../core/studyCategory';
import { buildQuizAnswerSources } from '../core/reviewPersistence';
import type { ModuleInfo, StudySettings } from '../core/models';
import { canAutoReverseQuestion, getModuleStudyQuestionModes, getStudyQuestionModeLabel } from '../core/questionPresentation';
import { buildRangeOptions, createSession, listQuestionCategories, selectSessionQuestions, type QuizSession } from '../core/sessionEngine';
import { getModuleById, getQuestionsForModule } from '../packs/packResolver';

import {
  readStoredSession,
  restoreStoredSession,
  saveStoredSession,
  clearStoredSession,
  sessionStorageScope
} from '../storage/sessionStorage';
import { defaultStudySettings, runtimeSettings } from '../core/studySettings';
import { readStudyPreferences, sanitizeStudyPreferences, writeStudyPreferences } from '../storage/studyPreferences';
import { button, clear, el, toast } from '../ui/dom';
import { appendIconLabel, createUiIcon, iconNameForModule } from '../ui/icons';
import { moduleMeta } from '../ui/modulePresentation';
import { renderInlineQuiz, disposeInlineQuizzes } from './inlineQuiz';
import { renderFlashcardSession, disposeFlashcardSessions } from './flashcardSession';

type ToggleSettingKey = 'shuffle' | 'autoNext' | 'autoRevealAfterIdle' | 'showExample' | 'showNumber' | 'showCategory';

function makeSelect(labelText: string, className = 'study-select'): { wrap: HTMLElement; select: HTMLSelectElement } {
  const wrap = el('label', 'field-label');
  const label = el('span', '', labelText);
  const select = el('select', className) as HTMLSelectElement;
  wrap.append(label, select);
  return { wrap, select };
}

export async function renderModuleScreen(context: ScreenContext & { moduleId: string }): Promise<void> {
  const { store: studyStore, root: root, catalog: packView, resolveImage, isCurrent, moduleId } = context;
  const { home: navigateHome, review: navigateReview } = context.navigation;

  if (!isCurrent()) return;
  const foundModule = getModuleById(packView, moduleId);
  if (!foundModule) {
    clear(root);
    root.append(el('p', 'empty', '教材が見つかりません。'));
    return;
  }
  const module: ModuleInfo = foundModule;

  const questions = getQuestionsForModule(packView, module);
  const modulePackId = packView.modulePackIdById.get(module.id);
  const sessionQuestionPool = modulePackId
    ? packView.questions.filter((question) => packView.questionPackIdById.get(question.id) === modulePackId)
    : questions;
  const questionsById = new Map(questions.map((question) => [question.id, question]));
  const attempts = await studyStore.getAttempts();
  const bookmarks = await studyStore.getBookmarks();
  const revisions = await studyStore.getImportedPackRevisions();
  const sources = buildQuizAnswerSources(
    packView.questions,
    packView.modulePackIdById,
    await studyStore.getImportedPackAssets(),
    revisions
  );
  const storageScope = await sessionStorageScope(modulePackId ?? '', module, sessionQuestionPool);
  storageScope.packRevision = revisions.get(modulePackId ?? '') ?? 'builtin';
  storageScope.resetEpoch = revisions.get('') ?? '0';
  if (!isCurrent()) return;
  const wrongIds = new Set(attempts.filter((attempt) => attempt.result !== 'correct').map((attempt) => attempt.questionId));
  const bookmarkIds = new Set(bookmarks);
  const wrongQuestions = questions.filter((question) => wrongIds.has(question.id));
  const bookmarkedQuestions = questions.filter((question) => bookmarkIds.has(question.id));
  const categories = listQuestionCategories(questions);
  const rangeOptions = buildRangeOptions(questions);
  const questionModes = getModuleStudyQuestionModes(questions);
  const storedSession = readStoredSession(module.id, questionsById, storageScope);
  const defaults = defaultStudySettings(module);
  const storedPreferences = modulePackId
    ? readStudyPreferences(modulePackId, module.id, undefined, storageScope.contentIdentity)
    : undefined;
  const settings = sanitizeStudyPreferences(defaults, storedPreferences, {
    validRanges: rangeOptions.map((option) => option.value),
    categories,
    questionModes
  });
  const persistStudyPreferences = () => {
    if (modulePackId && !writeStudyPreferences(modulePackId, module.id, settings, undefined, storageScope.contentIdentity))
      toast('学習設定を保存できませんでした。');
  };
  const persistSession = (session: QuizSession) => {
    if (!saveStoredSession(module.id, session, storageScope)) toast('再開位置を保存できませんでした。');
  };
  const clearSession = () => {
    if (!clearStoredSession(module.id, storageScope)) toast('再開位置を削除できませんでした。');
  };

  clear(root);
  const screen = el('main', 'screen module-screen');
  const header = el('header', 'topbar module-topbar');
  const back = button('', 'btn ghost');
  appendIconLabel(back, 'arrowLeft', 'ホーム');
  back.onclick = navigateHome;
  const review = button('', 'btn ghost');
  appendIconLabel(review, 'review', '復習');
  review.onclick = navigateReview;
  header.append(back, review);

  const info = el('section', 'hero-card module-cover');
  if (module.title.length > 24) info.classList.add('long-title');
  if (module.title.length > 42) info.classList.add('very-long-title');
  const meta = moduleMeta(module);
  info.style.setProperty('--module-accent', meta.accent);
  info.dataset.coverGlyph = module.title.trim().slice(0, 1);
  const coverIcon = el('div', 'module-cover-icon');
  coverIcon.append(createUiIcon(iconNameForModule(module), 'module-cover-svg'));
  info.append(
    coverIcon,
    el('p', 'eyebrow', module.subject),
    el('h1', '', module.title),
    el('p', '', module.description ?? 'インライン学習でテンポよく進めます。')
  );
  if (module.tags?.length) {
    const tags = el('div', 'tag-row');
    for (const tag of module.tags.slice(0, 4)) tags.append(el('span', 'tag', tag));
    info.append(tags);
  }
  const stats = el('div', 'stats-row');
  stats.append(
    el('span', '', `${questions.length}問`),
    el('span', '', `ミス ${wrongQuestions.length}問`),
    el('span', '', `ブックマーク ${bookmarkedQuestions.length}問`)
  );
  info.append(stats);

  const settingsCard = el('section', 'card setup-card');
  settingsCard.append(el('h2', '', 'テスト前設定'));
  const settingsGrid = el('div', 'settings-grid');

  const countField = makeSelect('問題数');
  for (const [value, label] of [
    ['10', '10問'],
    ['20', '20問'],
    ['50', '50問'],
    ['all', '全部']
  ] as const) {
    const option = el('option', '', label) as HTMLOptionElement;
    option.value = value;
    countField.select.append(option);
  }
  countField.select.value = String(settings.questionLimit);
  countField.select.onchange = () => {
    settings.questionLimit = countField.select.value === 'all' ? 'all' : Number(countField.select.value);
    persistStudyPreferences();
  };

  const rangeField = makeSelect('範囲');
  for (const optionInfo of rangeOptions) {
    const option = el('option', '', optionInfo.label) as HTMLOptionElement;
    option.value = optionInfo.value;
    rangeField.select.append(option);
  }
  const wrongOption = el('option', '', `間違いだけ (${wrongQuestions.length}問)`) as HTMLOptionElement;
  wrongOption.value = 'wrong';
  rangeField.select.append(wrongOption);
  const bookmarkOption = el('option', '', `ブックマーク (${bookmarkedQuestions.length}問)`) as HTMLOptionElement;
  bookmarkOption.value = 'bookmarked';
  rangeField.select.append(bookmarkOption);
  rangeField.select.value = settings.selectedRange ?? 'all';
  rangeField.select.onchange = () => {
    settings.selectedRange = rangeField.select.value;
    persistStudyPreferences();
  };

  const categoryField = makeSelect('カテゴリ');
  const allCategory = el('option', '', '全部') as HTMLOptionElement;
  allCategory.value = 'all';
  categoryField.select.append(allCategory);
  for (const category of categories) {
    const option = el('option', '', category) as HTMLOptionElement;
    option.value = encodeStudyCategory(category);
    categoryField.select.append(option);
  }
  categoryField.select.value = settings.selectedCategory ?? 'all';
  categoryField.select.disabled = categories.length === 0;
  categoryField.select.onchange = () => {
    settings.selectedCategory = categoryField.select.value;
    persistStudyPreferences();
  };

  const answerField = makeSelect('回答形式');
  for (const [value, label] of [
    ['auto', '自動'],
    ['choice', '4択'],
    ['input', '入力'],
    ['flashcard', 'カード']
  ] as const) {
    const option = el('option', '', label) as HTMLOptionElement;
    option.value = value;
    answerField.select.append(option);
  }
  answerField.select.value = settings.answerFormat ?? 'auto';
  answerField.select.onchange = () => {
    settings.answerFormat = answerField.select.value as StudySettings['answerFormat'];
    updateFlashcardToggles();
    persistStudyPreferences();
  };

  const questionModeField = makeSelect('出題形式');
  const sampleQuestion = questions.find((question) => question.sides) ?? questions.find(canAutoReverseQuestion) ?? questions[0];
  for (const mode of questionModes) {
    const option = el('option', '', getStudyQuestionModeLabel(mode, sampleQuestion)) as HTMLOptionElement;
    option.value = mode;
    questionModeField.select.append(option);
  }
  questionModeField.select.value = settings.questionMode ?? 'as_stored';
  questionModeField.select.disabled = questionModes.length <= 1;
  questionModeField.select.onchange = () => {
    settings.questionMode = questionModeField.select.value as StudySettings['questionMode'];
    persistStudyPreferences();
  };

  settingsGrid.append(countField.wrap, rangeField.wrap, categoryField.wrap, answerField.wrap, questionModeField.wrap);
  settingsCard.append(settingsGrid);

  const settingRow = el('div', 'setting-row');
  const toggles: Array<[ToggleSettingKey, string]> = [
    ['shuffle', 'シャッフル'],
    ['autoNext', '正解時に自動で次へ'],
    ['autoRevealAfterIdle', '10秒無操作で答えを表示'],
    ['showExample', '例文表示'],
    ['showNumber', '番号表示'],
    ['showCategory', 'カテゴリ表示']
  ];
  const autoToggles: HTMLInputElement[] = [];
  for (const [key, label] of toggles) {
    const wrap = el('label', 'check-label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = Boolean(settings[key]);
    if (key === 'autoNext' || key === 'autoRevealAfterIdle') autoToggles.push(input);
    input.onchange = () => {
      settings[key] = input.checked;
      persistStudyPreferences();
    };
    wrap.append(input, document.createTextNode(` ${label}`));
    settingRow.append(wrap);
  }
  const flashcardNotice = el(
    'p',
    'flashcard-toggle-notice',
    'カード：タップで表裏を切り替え、左へスワイプで「知らない」、右へスワイプで「知ってる」。カードの向きは「出題形式」を使います。自動で次へ・無操作で答えを表示は適用されません。'
  );
  const customStart = button('この設定で学習を始める →', 'flashcard-custom-start');
  function updateFlashcardToggles(): void {
    const flashcard = settings.answerFormat === 'flashcard';
    for (const input of autoToggles) input.disabled = flashcard;
    flashcardNotice.hidden = !flashcard;
    customStart.hidden = !flashcard;
  }
  updateFlashcardToggles();
  settingsCard.append(flashcardNotice);
  settingsCard.append(settingRow, el('p', 'hint', '通常はシャッフルONで使います。必要なら問題数や範囲を絞れます。'));

  const actions = el('section', 'card action-card module-secondary-actions');
  const start = button('', 'v2-start');
  appendIconLabel(start, 'arrowRight', '学習を始める', 'end');
  const quizMount = el('div', 'quiz-mount');

  function rerender(): void {
    void renderModuleScreen(context);
  }

  function mountSession(session: QuizSession): void {
    disposeInlineQuizzes(quizMount);
    disposeFlashcardSessions(quizMount);
    session.sourceByQuestionId ??= sources;
    persistSession(session);
    const update = (next: QuizSession) => {
      mountSession(next);
    };
    const renderSession = session.settings.answerFormat === 'flashcard' ? renderFlashcardSession : renderInlineQuiz;
    renderSession(
      quizMount,
      session,
      {
        onSessionChange: update,
        onSessionCheckpoint: persistSession,
        onComplete: () => {
          clearSession();
          rerender();
        }
      },
      { store: studyStore, isCurrent, resolveImageAsset: resolveImage }
    );
  }

  function startSession(baseSettings: StudySettings, mode: 'normal' | 'review'): void {
    const selected = selectSessionQuestions(questions, baseSettings, { wrongQuestionIds: wrongIds, bookmarkedQuestionIds: bookmarkIds });
    if (!selected.length) {
      toast('出題できる問題がありません。');
      return;
    }
    const session = createSession(module, selected, runtimeSettings(baseSettings), mode, sessionQuestionPool);
    mountSession(session);
  }

  start.onclick = () => startSession(settings, 'normal');
  customStart.onclick = () => startSession(settings, 'normal');

  if (storedSession) {
    const resumeLabel =
      storedSession.index >= storedSession.questions.length
        ? '結果を再開'
        : `再開 (${storedSession.index + 1}/${storedSession.questions.length})`;
    const resume = button(resumeLabel, 'btn');
    resume.onclick = () => {
      const session = restoreStoredSession(module, storedSession, questionsById, sessionQuestionPool);
      if (!session) {
        clearSession();
        toast('保存された学習状態を復元できませんでした。');
        return;
      }
      mountSession(session);
    };
    actions.append(resume);
  }

  if (wrongQuestions.length) {
    const mistakes = button(`間違いだけ ${wrongQuestions.length}問`, 'btn');
    mistakes.onclick = () => startSession({ ...settings, selectedRange: 'all', filter: 'wrong' }, 'review');
    actions.append(mistakes);
  }

  if (bookmarkedQuestions.length) {
    const bookmark = button(`ブックマーク ${bookmarkedQuestions.length}問`, 'btn');
    bookmark.onclick = () => startSession({ ...settings, selectedRange: 'all', filter: 'bookmarked' }, 'review');
    actions.append(bookmark);
  }

  const quick = el('section', 'v2-quick-start');
  const quickLabel = el('div', 'v2-quick-label');
  quickLabel.append(el('strong', '', 'Quick Start'), el('span', '', '問題数だけ選んですぐ開始'));
  const lengths = el('div', 'v2-lengths');
  const quickValues: Array<[string, string]> = [
    ['10', '10問'],
    ['20', '20問'],
    ['50', '50問'],
    ['all', '全部']
  ];
  const quickButtons: HTMLButtonElement[] = [];
  const updateQuickSelection = () => {
    for (const item of quickButtons) item.classList.toggle('active', item.dataset.value === countField.select.value);
  };
  for (const [value, label] of quickValues) {
    const quickButton = button(label, 'v2-length');
    quickButton.dataset.value = value;
    quickButton.onclick = () => {
      countField.select.value = value;
      countField.select.dispatchEvent(new Event('change', { bubbles: true }));
      updateQuickSelection();
    };
    quickButtons.push(quickButton);
    lengths.append(quickButton);
  }
  countField.select.addEventListener('change', updateQuickSelection);
  updateQuickSelection();
  quick.append(quickLabel, lengths, start);

  const customize = el('details', 'v2-customize');
  const customizeSummary = el('summary');
  const customizeTitle = el('span', 'v2-customize-title');
  customizeTitle.append(createUiIcon('sliders', 'v2-customize-icon'), document.createTextNode('学習条件をカスタマイズ'));
  customizeSummary.append(customizeTitle);
  customize.append(customizeSummary, settingsCard);

  screen.append(header, info, quick, customize, customStart);
  if (actions.childElementCount) screen.append(actions);
  screen.append(quizMount);
  root.append(screen);
}
