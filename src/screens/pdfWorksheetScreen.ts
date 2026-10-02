import type { ScreenContext } from '../app/context';
import { reportIssue } from '../debug/reportIssue';
import { writeDebugLog } from '../debug/debugLog';
import type { ModuleInfo, Question } from '../core/models';
import { createJapaneseToEnglishWorksheetPlan, isJapaneseToEnglishWorksheetQuestion } from '../pdf/worksheetPlanner';
import {
  buildWorksheetRangeOptions,
  filterWorksheetQuestionsByRange,
  formatWorksheetModuleLabel,
  shuffleWorksheetQuestions,
  worksheetQuestionOrdinal
} from '../pdf/worksheetSelection';
import { getQuestionsForModule, type ResolvedPackView } from '../packs/packResolver';
import { saveBlob, type SaveProgressReporter } from '../platform/fileSave';
import { button, clear, el, toast } from '../ui/dom';
import { appendIconLabel } from '../ui/icons';

interface WorksheetModuleOption {
  packId: string;
  module: ModuleInfo;
  questions: Question[];
  label: string;
}

function makeOption(value: string, label: string): HTMLOptionElement {
  const option = el('option', '', label) as HTMLOptionElement;
  option.value = value;
  return option;
}

function safeFileStem(value: string): string {
  return (
    value
      .normalize('NFKC')
      .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '-')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 80) || 'worksheet'
  );
}

function exportError(code: string, message: string, cause?: unknown): Error {
  const causeText = cause instanceof Error ? cause.message : cause ? String(cause) : '';
  return new Error(`[${code}] ${message}${causeText ? ` / ${causeText}` : ''}`);
}

function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return /^\[([A-Z0-9-]+)\]/.exec(message)?.[1] ?? 'PDF-E999';
}

function baseErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^\[[A-Z0-9-]+\]\s*/, '');
}

async function savePdf(blob: Blob, filename: string, progress: SaveProgressReporter): Promise<void> {
  if (blob.type !== 'application/pdf') throw exportError('PDF-V002', `PDF BlobのMIME typeが不正です: ${blob.type || '(empty)'}`);
  if (blob.size <= 0) throw exportError('PDF-V001', 'PDF Blobのサイズが0Bです。保存を中止しました。');
  await saveBlob(blob, filename, { idPrefix: 'worksheet', progress });
}

function supportedQuestions(module: ModuleInfo, packView: ResolvedPackView): Question[] {
  return getQuestionsForModule(packView, module)
    .map((question, index) => ({ ...question, number: worksheetQuestionOrdinal(question, index) }))
    .filter(isJapaneseToEnglishWorksheetQuestion);
}

function disambiguateLabels(options: WorksheetModuleOption[]): WorksheetModuleOption[] {
  const labelCounts = new Map<string, number>();
  for (const option of options) labelCounts.set(option.label, (labelCounts.get(option.label) ?? 0) + 1);
  return options.map((option) => {
    if ((labelCounts.get(option.label) ?? 0) <= 1) return option;
    return { ...option, label: `${option.label} / ${option.packId}` };
  });
}

function worksheetModuleOptions(packView: ResolvedPackView): WorksheetModuleOption[] {
  const options: WorksheetModuleOption[] = [];
  for (const module of packView.modules) {
    const packId = packView.modulePackIdById.get(module.id);
    const pack = packId ? packView.packById.get(packId) : undefined;
    if (!packId || !pack) continue;
    const questions = supportedQuestions(module, packView);
    if (!questions.length) continue;
    options.push({ packId, module, questions, label: formatWorksheetModuleLabel(module, questions) });
  }
  return disambiguateLabels(options);
}

export async function renderPdfWorksheetScreen(context: ScreenContext): Promise<void> {
  const { root: root, catalog: packView } = context;
  const { home: navigateHome } = context.navigation;

  const modules = worksheetModuleOptions(packView);
  clear(root);
  const screen = el('main', 'screen pdf-worksheet-screen');
  const header = el('header', 'topbar');
  const back = button('', 'btn ghost');
  appendIconLabel(back, 'arrowLeft', 'ホーム');
  back.onclick = navigateHome;
  header.append(back);

  const intro = el('section', 'hero-card worksheet-hero');
  intro.append(
    el('p', 'eyebrow', 'WORKSHEET / A4'),
    el('h1', '', 'PDFプリント'),
    el('p', '', '日本語の意味から英語を書く、テスト対策用のA4プリントを作成します。')
  );

  const setup = el('section', 'card setup-card worksheet-setup');
  setup.append(el('p', 'eyebrow', 'SETUP'), el('h2', '', '出力設定'));
  if (!modules.length) {
    setup.append(el('p', 'empty', '出力できる入力式の教材がありません。'));
    screen.append(header, intro, setup);
    root.append(screen);
    return;
  }

  const grid = el('div', 'settings-grid');
  const moduleLabel = el('label', 'field-label');
  const moduleSelect = el('select', 'study-select') as HTMLSelectElement;
  modules.forEach((option, index) => moduleSelect.append(makeOption(String(index), option.label)));
  moduleLabel.append(el('span', '', '教材'), moduleSelect);

  const rangeLabel = el('label', 'field-label');
  const rangeSelect = el('select', 'study-select') as HTMLSelectElement;
  rangeLabel.append(el('span', '', '範囲'), rangeSelect);

  const shuffleLabel = el('label', 'check-label');
  const shuffleQuestions = document.createElement('input');
  shuffleQuestions.type = 'checkbox';
  shuffleQuestions.checked = false;
  shuffleLabel.append(shuffleQuestions, document.createTextNode(' 問題順をシャッフル'));

  const answerLabel = el('label', 'check-label');
  const includeAnswers = document.createElement('input');
  includeAnswers.type = 'checkbox';
  includeAnswers.checked = true;
  answerLabel.append(includeAnswers, document.createTextNode(' 解答ページを付ける'));

  const summary = el('p', 'hint');
  let selectedQuestions: Question[] = [];

  function selectedModuleOption(): WorksheetModuleOption {
    return modules[Number(moduleSelect.value)] ?? modules[0];
  }

  function refreshRangeOptions(): void {
    const selected = selectedModuleOption();
    rangeSelect.replaceChildren(...buildWorksheetRangeOptions(selected.questions).map((option) => makeOption(option.value, option.label)));
    selectedQuestions = selected.questions;
    refreshSummary();
  }

  function refreshSummary(): void {
    const selected = selectedModuleOption();
    selectedQuestions = filterWorksheetQuestionsByRange(selected.questions, rangeSelect.value || 'all');
    const questionPages = Math.ceil(selectedQuestions.length / 25);
    const totalPages = questionPages * (includeAnswers.checked ? 2 : 1);
    const planPreview = createJapaneseToEnglishWorksheetPlan(selected.module, selectedQuestions, includeAnswers.checked);
    summary.textContent = `${selectedQuestions.length}問 / ${totalPages}ページ。問題ページを先に、解答は後ろに出力します。${planPreview.warnings.length ? ` 注意: ${planPreview.warnings.join(' ')}` : ''}`;
  }

  moduleSelect.onchange = refreshRangeOptions;
  rangeSelect.onchange = refreshSummary;
  includeAnswers.onchange = refreshSummary;
  refreshRangeOptions();

  grid.append(moduleLabel, rangeLabel);
  setup.append(grid, shuffleLabel, answerLabel, summary);

  const actions = el('section', 'worksheet-export-panel');
  const exportButton = button('', 'btn primary worksheet-export-button');
  appendIconLabel(exportButton, 'filePdf', 'PDFを書き出す');
  actions.append(exportButton);

  const statusCard = el('details', 'card export-status-card');
  const statusSummary = el('summary', '', '書き出し状況');
  const statusBody = el('div', 'export-status-body');
  const statusMessage = el('p', 'export-status-message', '待機中');
  const statusDetail = el(
    'p',
    'hint export-status-detail',
    'PDFを書き出すと、ここに進行状況が表示されます。内部コードはデバッグログに保存します。'
  );
  const statusLog = el('ol', 'export-status-log');
  statusBody.append(statusMessage, statusDetail, statusLog);
  statusCard.append(statusSummary, statusBody);

  function reportProgress(code: string, message: string, detail = ''): void {
    statusCard.open = true;
    statusMessage.textContent = message;
    statusDetail.textContent = detail || '詳細なし';
    const item = el('li', '', `${message}${detail ? ` — ${detail}` : ''}`);
    statusLog.append(item);
    writeDebugLog({ level: 'info', area: 'pdfWorksheet', code, userMessage: message, detail });
    while (statusLog.childElementCount > 24) statusLog.firstElementChild?.remove();
  }

  exportButton.onclick = async () => {
    const selected = selectedModuleOption();
    if (!selectedQuestions.length) {
      reportProgress('PDF-S000', '出力できる問題がありません', selected.label);
      reportIssue({
        level: 'warn',
        area: 'pdfWorksheet',
        code: 'PDF-S000',
        userMessage: '出力できる問題がありません。',
        detail: selected.label,
        context: { selectedQuestionCount: selectedQuestions.length }
      });
      return;
    }
    exportButton.disabled = true;
    appendIconLabel(exportButton, 'filePdf', 'PDFを作成中…');
    statusLog.replaceChildren();
    try {
      reportProgress(
        'PDF-S010',
        '出力設定を読み込みました',
        `${selected.label} / ${selectedQuestions.length}問 / シャッフル${shuffleQuestions.checked ? 'ON' : 'OFF'}`
      );
      const outputQuestions = shuffleQuestions.checked ? shuffleWorksheetQuestions(selectedQuestions) : [...selectedQuestions];
      const plan = createJapaneseToEnglishWorksheetPlan(selected.module, outputQuestions, includeAnswers.checked);
      if (!plan.pages.length) throw exportError('PDF-P001', 'PDFに出力できるページがありません。');
      reportProgress('PDF-P010', 'PDFページ構成を作成しました', `${plan.pages.length}ページ / ${plan.rows.length}問`);
      for (const warning of plan.warnings) {
        reportProgress('PDF-W010', 'PDF見出しを短縮します', warning);
        reportIssue({ level: 'warn', area: 'pdfWorksheet', code: 'PDF-W010', userMessage: 'PDF見出しを短縮します。', detail: warning });
      }

      reportProgress('PDF-M010', 'PDF生成モジュールを読み込み中', '../pdf/worksheetPdf');
      const { generateWorksheetPdfBlob } = await import('../pdf/worksheetPdf');

      reportProgress('PDF-G010', 'PDF本体を生成中', '日本語フォントを埋め込みます。');
      const pdf = await generateWorksheetPdfBlob(plan);
      reportProgress('PDF-G020', 'PDF Blobを生成しました', `${pdf.size.toLocaleString()} bytes / ${pdf.type || '(no type)'}`);
      if (pdf.size <= 0) throw exportError('PDF-G021', 'PDF Blobが0Bです。');

      const filename = `${safeFileStem(selected.label)}-${safeFileStem(plan.rangeLabel)}.pdf`;
      reportProgress('PDF-S020', '保存処理を開始します', filename);
      await savePdf(pdf, filename, reportProgress);
      writeDebugLog({
        level: 'info',
        area: 'pdfWorksheet',
        code: 'PDF-OK',
        userMessage: 'PDFプリントを書き出しました。',
        detail: filename,
        context: { bytes: pdf.size }
      });
      toast('PDFプリントを書き出しました。');
    } catch (error) {
      const code = errorCode(error);
      const message = baseErrorMessage(error);
      reportProgress(code, 'PDF作成/保存に失敗しました', message);
      reportIssue({
        level: 'error',
        area: 'pdfWorksheet',
        code,
        userMessage: 'PDFの作成に失敗しました。もう一度試してください。',
        detail: message,
        error,
        context: { selectedLabel: selected.label, selectedQuestionCount: selectedQuestions.length }
      });
    } finally {
      exportButton.disabled = false;
      appendIconLabel(exportButton, 'filePdf', 'PDFを書き出す');
    }
  };

  const note = el('details', 'card worksheet-note');
  note.append(
    el('summary', '', '対応範囲'),
    el('p', 'hint', 'A4縦・1ページ25問・日本語から英語の入力式問題に対応しています。選択問題・画像問題・逆方向は出力しません。')
  );

  screen.append(header, intro, setup, actions, statusCard, note);
  root.append(screen);
}
