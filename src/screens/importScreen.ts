import type { ScreenContext } from '../app/context';
import { writeDebugLog } from '../debug/debugLog';
import { validateActivePackIdentities } from '../packs/packValidator';
import { validateImportFileSize } from '../packs/importLimits';
import type { LoopDeckPack } from '../core/models';
import { analyzeImportConflicts, sharedModuleIds } from '../packs/importConflictAnalysis';
import { mergeLoopDeckPacks, mergeLoopDeckPacksIntoExisting, type MergePackReport } from '../packs/packMerger';
import packAuthoringPrompt from '../packs/packAuthoringPrompt.txt?raw';
import { getActiveModules, getActivePacks, getActiveQuestions } from '../packs/packResolver';
import { createLoopDeckZipBlob, makePackFileStem, stringifyLoopDeckJson } from '../packs/zipExporter';
import { saveBlob } from '../platform/fileSave';
import { readImportFile } from '../services/importFileService';
import { collectPackExportAssets } from '../services/packExport';
import type { StudyRepository } from '../storage/studyRepository';
import type { BackupImportMode, StudyBackup } from '../storage/storageTypes';
import { button, clear, el, toast } from '../ui/dom';
import { appendIconLabel, createUiIcon } from '../ui/icons';

async function exportPackJson(pack: LoopDeckPack): Promise<void> {
  try {
    const blob = new Blob([stringifyLoopDeckJson(pack)], { type: 'application/json' });
    await saveBlob(blob, `${makePackFileStem(pack)}.loopdeck.json`);
    toast('JSONを書き出しました。');
  } catch (error) {
    toast(`書き出しに失敗しました：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function exportPackZip(pack: LoopDeckPack, studyStore: StudyRepository): Promise<void> {
  try {
    const blob = await createLoopDeckZipBlob(pack, await collectPackExportAssets(pack, studyStore));
    await saveBlob(blob, `${makePackFileStem(pack)}.loopdeck.zip`);
    toast('ZIPを書き出しました。');
  } catch (error) {
    toast(`書き出しに失敗しました：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function exportBackup(studyStore: StudyRepository): Promise<void> {
  const backup = await studyStore.exportSnapshot();
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  await saveBlob(blob, `loopdeck-backup-${backup.exportedAt.slice(0, 10)}.json`);
  toast('バックアップを書き出しました。');
}

async function exportPackAuthoringPrompt(): Promise<void> {
  const blob = new Blob([packAuthoringPrompt], { type: 'text/plain;charset=utf-8' });
  await saveBlob(blob, 'loopdeck-pack-authoring-prompt.txt');
  toast('AI用のPack作成プロンプトを書き出しました。');
}

function infoList(items: string[]): HTMLUListElement {
  const list = document.createElement('ul');
  list.className = 'info-list';
  for (const text of items) list.append(el('li', '', text));
  return list;
}

function summarizeIds(ids: string[]): string {
  const shown = ids.slice(0, 5).join(', ');
  return ids.length > 5 ? `${shown} ほか${ids.length - 5}件` : shown;
}

function mergeReportItems(report: MergePackReport): string[] {
  return [
    `追加フォルダ: ${report.addedFolders}`,
    `更新フォルダ: ${report.updatedFolders}`,
    `追加教材: ${report.addedModules}`,
    `マージ教材: ${report.mergedModules}`,
    `追加問題: ${report.addedQuestions}`,
    `競合でID変更した問題: ${report.renamedQuestions}`,
    `同一のためスキップした問題: ${report.skippedIdenticalQuestions}`
  ];
}

function appendMergeReport(container: HTMLElement, report: MergePackReport): void {
  const reportBox = el('div', 'merge-report');
  reportBox.append(el('h3', '', 'マージ更新の内容'), infoList(mergeReportItems(report)));
  container.append(reportBox);
}

export async function renderImportScreen(context: ScreenContext): Promise<void> {
  const { store: studyStore, root: root, catalog: packView, isCurrent, refreshCatalog: onImported } = context;
  const { home: navigateHome } = context.navigation;

  if (!isCurrent()) return;
  const importedPacks = await studyStore.getImportedPacks();
  if (!isCurrent()) return;
  const activePacks = getActivePacks(packView);
  const importedIds = new Set(importedPacks.map((pack) => pack.packId));
  const activeModules = getActiveModules(packView);
  const activeQuestions = getActiveQuestions(packView);

  clear(root);
  const screen = el('main', 'screen import-screen');
  const header = el('header', 'topbar');
  const back = button('', 'btn ghost');
  appendIconLabel(back, 'arrowLeft', 'ホーム');
  back.onclick = navigateHome;
  header.append(back);

  const card = el('section', 'hero-card');
  card.append(
    el('p', 'eyebrow', 'LIBRARY & DATA'),
    el('h1', '', '教材とデータ'),
    el('p', '', '教材の追加、バックアップ、書き出しをここで管理します。')
  );

  const authoringCard = el('section', 'card authoring-card');
  authoringCard.append(
    el('h2', '', 'AIで教材Packを作る'),
    el('p', 'hint', 'LoopDeckの現行形式・問題タイプ・画像・安全制限をまとめた作成用プロンプトです。AIへ渡してから教材作成を依頼できます。')
  );
  const downloadPrompt = button('AI用Pack作成プロンプトを保存', 'btn primary');
  downloadPrompt.onclick = () => void exportPackAuthoringPrompt();
  authoringCard.append(downloadPrompt);

  const input = el('input', 'file-input visually-hidden') as HTMLInputElement;
  input.type = 'file';
  input.accept = '.json,.zip,.loopdeck.zip,application/json,application/zip';

  const uploadCard = el('section', 'card upload-card');
  const uploadTitle = el('h2', '', '教材ファイルを読み込む');
  const uploadZone = el('div', 'upload-zone');
  const uploadIcon = el('div', 'upload-icon');
  uploadIcon.append(createUiIcon('tray', 'upload-icon-svg'));
  const uploadText = el('p', '', '教材ファイルをここにドロップ');
  const uploadSub = el('p', 'hint', 'またはボタンから .json / .zip / .loopdeck.zip を選びます。');
  const chooseFile = button('ファイルを選ぶ', 'btn primary');
  const selectedFile = el('p', 'upload-file-name', '選択中のファイル: なし');
  uploadZone.append(uploadIcon, uploadText, uploadSub, chooseFile, selectedFile, input);
  uploadCard.append(uploadTitle, uploadZone);

  const preview = el('section', 'card preview-card');
  preview.append(el('h2', '', '読み込み結果'), el('p', 'empty', 'まだファイルが選ばれていません。'));

  let importing = false;
  function setImporting(value: boolean): void {
    importing = value;
    chooseFile.disabled = value;
    chooseFile.textContent = value ? '読み込み中…' : 'ファイルを選ぶ';
    uploadCard.classList.toggle('loading', value);
  }

  async function importBackupFromUi(
    backup: StudyBackup,
    mode: BackupImportMode,
    replaceButton: HTMLButtonElement,
    mergeButton: HTMLButtonElement
  ): Promise<void> {
    if (
      mode === 'replace' &&
      !window.confirm('現在の回答履歴・ブックマーク・インポート教材・SRS復習データを、このバックアップの内容で置き換えます。続けますか？')
    )
      return;
    replaceButton.disabled = true;
    mergeButton.disabled = true;
    try {
      await studyStore.restoreSnapshot(backup, mode);
      toast(mode === 'replace' ? 'バックアップから置き換え復元しました。' : 'バックアップを現在データへマージしました。');
      await onImported();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      writeDebugLog({
        level: 'error',
        area: 'backupImport',
        code: 'BACKUP-IMPORT-FAILED',
        userMessage: 'バックアップの読み込みに失敗しました。',
        detail,
        stack: error instanceof Error ? error.stack : undefined,
        context: { mode, exportedAt: backup.exportedAt }
      });
      toast(`バックアップの読み込みに失敗しました：${detail}`);
      replaceButton.disabled = false;
      mergeButton.disabled = false;
    }
  }

  function renderBackupImport(backup: StudyBackup): void {
    clear(preview);
    preview.append(
      el('h2', '', 'バックアップを読み込む'),
      el(
        'p',
        'import-summary',
        `書き出し日時: ${backup.exportedAt} / 回答${backup.attempts.length}件 / ブックマーク${backup.bookmarks.length}件 / 教材${backup.importedPacks.length}件`
      ),
      el(
        'p',
        'hint',
        '「置き換え復元」は現在の学習データを消してバックアップの状態に合わせます。「マージ」は現在データを残し、バックアップ内の同じIDだけ上書きします。'
      )
    );
    const replace = button('現在データを置き換えて復元', 'btn ghost danger');
    const merge = button('現在データにマージ', 'btn primary');
    replace.onclick = () => void importBackupFromUi(backup, 'replace', replace, merge);
    merge.onclick = () => void importBackupFromUi(backup, 'merge', replace, merge);
    const actions = el('div', 'data-actions');
    actions.append(replace, merge);
    preview.append(actions);
  }

  async function handleFile(file: File): Promise<void> {
    if (importing) return;
    const sizeIssue = validateImportFileSize(file).find((issue) => issue.level === 'error');
    if (sizeIssue) {
      clear(preview);
      preview.append(el('h2', '', '読み込み結果'), el('p', 'issue error', sizeIssue.message));
      return;
    }
    selectedFile.textContent = `選択中のファイル: ${file.name}`;
    setImporting(true);
    try {
      const imported = await readImportFile(file);
      if (imported.kind === 'backup') {
        renderBackupImport(imported.backup);
        return;
      }
      const result = imported.result;

      clear(preview);
      preview.append(el('h2', '', '読み込み結果'));
      const issueList = el('div', 'issue-list');
      for (const issue of result.issues) {
        const item = el('div', `issue ${issue.level}`);
        item.textContent = `${issue.level.toUpperCase()}: ${issue.message}${issue.path ? ` (${issue.path})` : ''}`;
        issueList.append(item);
      }
      if (!result.issues.length) issueList.append(el('p', 'empty', '問題は見つかりませんでした。'));
      preview.append(issueList);

      if (result.ok && result.pack) {
        const pack = result.pack;
        const assets = result.assets ?? [];
        const directIdentityIssues = validateActivePackIdentities([...activePacks, pack]).filter((issue) => issue.level === 'error');
        const {
          existingImportedPack,
          moduleMergeTarget,
          duplicateImportedPackId,
          duplicateActivePackId,
          duplicateModuleIds,
          duplicateQuestionIds
        } = analyzeImportConflicts(pack, importedPacks, activePacks, activeModules, activeQuestions);
        const summary = el('p', 'import-summary', `${pack.title} / ${pack.modules.length}教材 / ${pack.questions.length}問`);
        preview.append(summary);

        if (existingImportedPack) {
          const previewMerge = mergeLoopDeckPacks(existingImportedPack, pack);
          preview.append(el('p', 'issue warning', '同じIDのパックがすでにあります。上書き更新またはマージ更新を選べます。'));
          appendMergeReport(preview, previewMerge.report);
        } else {
          if (duplicateActivePackId) {
            preview.append(el('p', 'issue warning', '同じIDのパックがあります。取り込み後は新しく取り込んだ教材が優先されます。'));
          }
          if (duplicateModuleIds.length) {
            preview.append(
              el(
                'p',
                'issue warning',
                `同じIDの教材があります: ${summarizeIds(duplicateModuleIds)}。通常取り込みでは上書き扱いになるため、必要なら教材マージ更新を選んでください。`
              )
            );
          }
          if (moduleMergeTarget) {
            const previewMerge = mergeLoopDeckPacksIntoExisting(moduleMergeTarget, pack);
            const sharedIds = sharedModuleIds(moduleMergeTarget, pack);
            preview.append(
              el('p', 'issue warning', `教材マージ更新できます。対象: ${moduleMergeTarget.title} / 教材ID: ${summarizeIds(sharedIds)}`)
            );
            appendMergeReport(preview, previewMerge.report);
          }
          if (duplicateQuestionIds.length) {
            preview.append(
              el(
                'p',
                'issue warning',
                `同じIDの問題があります。マージ時は同一内容ならスキップ、内容違いならID変更して追加します: ${summarizeIds(duplicateQuestionIds)}`
              )
            );
          }
        }

        if (directIdentityIssues.length) {
          preview.append(
            el('p', 'issue error', `別パックとしては取り込めません: ${directIdentityIssues.map((issue) => issue.message).join(' / ')}`)
          );
        }

        const install = button(
          duplicateImportedPackId
            ? '上書き更新する'
            : duplicateModuleIds.length
              ? '別パックとして取り込む（上書き注意）'
              : 'この教材を取り込む',
          duplicateModuleIds.length ? 'btn ghost danger' : 'btn primary'
        );
        install.disabled = directIdentityIssues.length > 0;
        install.onclick = async () => {
          const latestActive = getActivePacks(packView);
          const identityIssues = validateActivePackIdentities([...latestActive, pack]).filter((issue) => issue.level === 'error');
          if (identityIssues.length) {
            toast('問題IDが別パックと衝突しているため取り込めません。マージ更新を使ってください。');
            return;
          }
          await studyStore.saveImportedPackWithAssets(pack, assets, 'replace');
          toast(duplicateImportedPackId ? '教材を上書き更新しました。' : '教材を取り込みました。');
          await onImported();
        };
        preview.append(install);

        if (existingImportedPack) {
          const mergeInstall = button('マージ更新する', 'btn');
          mergeInstall.onclick = async () => {
            const currentExistingPack = (await studyStore.getImportedPacks()).find((importedPack) => importedPack.packId === pack.packId);
            if (!currentExistingPack) {
              await studyStore.saveImportedPackWithAssets(pack, assets, 'replace');
              toast('同じIDのインポート済み教材が見つからなかったため、新規取り込みしました。');
              await onImported();
              return;
            }

            const { pack: mergedPack, report } = mergeLoopDeckPacks(currentExistingPack, pack);
            const identityIssues = validateActivePackIdentities([...activePacks, mergedPack]).filter((issue) => issue.level === 'error');
            if (identityIssues.length) {
              toast('マージ結果の問題IDが別パックと衝突するため保存できません。');
              return;
            }
            await studyStore.saveImportedPackWithAssets(mergedPack, assets, 'upsert');
            toast(
              `教材をマージ更新しました。追加${report.addedQuestions + report.renamedQuestions}問 / ID変更${report.renamedQuestions}問。`
            );
            await onImported();
          };
          preview.append(mergeInstall);
        }

        if (moduleMergeTarget) {
          const moduleMergeInstall = button('教材マージ更新する', 'btn primary');
          moduleMergeInstall.onclick = async () => {
            const currentImportedPacks = await studyStore.getImportedPacks();
            const currentTarget =
              currentImportedPacks.find((importedPack) => importedPack.packId === moduleMergeTarget.packId) ?? moduleMergeTarget;
            const { pack: mergedPack, report } = mergeLoopDeckPacksIntoExisting(currentTarget, pack);
            const identityIssues = validateActivePackIdentities([...activePacks, mergedPack]).filter((issue) => issue.level === 'error');
            if (identityIssues.length) {
              toast('マージ結果の問題IDが別パックと衝突するため保存できません。');
              return;
            }
            await studyStore.saveImportedPackWithAssets(mergedPack, assets, 'upsert');
            toast(
              `教材をマージ更新しました。追加${report.addedQuestions + report.renamedQuestions}問 / ID変更${report.renamedQuestions}問。`
            );
            await onImported();
          };
          preview.append(moduleMergeInstall);
        }
      }
    } catch (error) {
      clear(preview);
      preview.append(
        el('h2', '', '読み込み結果'),
        el('p', 'issue error', `読み込みに失敗しました：${error instanceof Error ? error.message : String(error)}`)
      );
    } finally {
      input.value = '';
      setImporting(false);
    }
  }

  chooseFile.onclick = () => input.click();
  input.onchange = async () => {
    const file = input.files?.[0];
    if (file) await handleFile(file);
  };

  uploadZone.addEventListener('dragover', (event) => {
    event.preventDefault();
    if (!importing) uploadZone.classList.add('drag-over');
  });
  uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('drag-over'));
  uploadZone.addEventListener('drop', (event) => {
    event.preventDefault();
    uploadZone.classList.remove('drag-over');
    const file = event.dataTransfer?.files?.[0];
    if (file) void handleFile(file);
  });

  const packageList = el('section', 'card');
  packageList.append(el('h2', '', '現在の教材パック / 書き出し'));
  const list = el('div', 'weak-list');
  for (const pack of activePacks) {
    const row = el('div', 'weak-row pack-row');
    const meta = el('div', 'pack-meta');
    meta.append(
      el('span', '', pack.title),
      el('small', '', `${pack.questions.length}問${importedIds.has(pack.packId) ? ' / imported' : ' / built-in'}`)
    );

    const actions = el('div', 'pack-actions');
    const json = button('JSON', 'btn');
    json.onclick = () => void exportPackJson(pack);
    const zip = button('ZIP', 'btn primary');
    zip.onclick = () => void exportPackZip(pack, studyStore);
    actions.append(json, zip);
    if (importedIds.has(pack.packId)) {
      const remove = button('削除', 'btn ghost danger');
      remove.onclick = async () => {
        if (!window.confirm(`${pack.title} を削除します。学習履歴は残ります。`)) return;
        await studyStore.deleteImportedPack(pack.packId);
        toast('インポート済みパックを削除しました。');
        await onImported();
      };
      actions.append(remove);
    }

    row.append(meta, actions);
    list.append(row);
  }
  packageList.append(list);

  const dataCard = el('section', 'card data-card');
  dataCard.append(el('h2', '', '学習データ管理'));
  const dataActions = el('div', 'data-actions');
  const backup = button('履歴バックアップを書き出し', 'btn primary');
  backup.onclick = () => void exportBackup(studyStore);
  const clearHistory = button('回答履歴を全削除', 'btn ghost danger');
  clearHistory.onclick = async () => {
    if (!window.confirm('回答履歴をすべて削除します。ブックマークと教材パックは残ります。')) return;
    await studyStore.clearAttempts();
    toast('回答履歴を削除しました。');
  };
  const clearWrong = button('ミス履歴だけ削除', 'btn ghost danger');
  clearWrong.onclick = async () => {
    if (!window.confirm('不正解・答え表示の履歴だけ削除します。')) return;
    await studyStore.clearWrongAttempts();
    toast('ミス履歴を削除しました。');
  };
  const clearBookmarks = button('ブックマーク全削除', 'btn ghost danger');
  clearBookmarks.onclick = async () => {
    if (!window.confirm('ブックマークをすべて削除します。')) return;
    await studyStore.clearBookmarks();
    toast('ブックマークを削除しました。');
  };
  dataActions.append(backup);
  const dangerZone = el('details', 'v2-danger-zone');
  dangerZone.append(el('summary', '', 'データ削除'));
  const dangerActions = el('div', 'v2-danger-actions');
  dangerActions.append(clearHistory, clearWrong, clearBookmarks);
  dangerZone.append(dangerActions);
  dataCard.append(
    dataActions,
    el('p', 'hint', 'JSONバックアップを読み込むと、「現在データを置き換えて復元」または「現在データにマージ」を選べます。'),
    dangerZone
  );

  const note = el('details', 'card safe-note');
  note.append(
    el('summary', '', '対応ファイルと安全制限'),
    infoList([
      'JSON単体、または manifest.json / modules.json / questions.json を含む .loopdeck.zip に対応。',
      'LoopDeckバックアップJSONは、置き換え復元とマージ読み込みを明示的に選べます。',
      'HTML / JavaScript / CSS は教材として実行しません。',
      '.html / .js / .mjs / .cjs / .css / .apk / .dex / .jar / .so / .exe / .bat / .cmd / .sh / .ps1 は拒否します。',
      '../、..\\、絶対パス、空パス、null byte を含む危険なパスは拒否します。'
    ])
  );

  screen.append(header, card, authoringCard, uploadCard, preview, packageList, dataCard, note);
  root.append(screen);
}
