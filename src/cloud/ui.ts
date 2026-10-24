import { el, button } from '../ui/dom';
import { saveBlob } from '../platform/fileSave';
import { CloudApi, type CloudRevision } from './api';
import { CloudStore } from './store';
import { SyncEngine } from './engine';
import type { StudyRepository } from '../storage/studyRepository';
import { nativeCloud } from '../platform/nativeCloud';
const labels = {
  offline: '未接続',
  syncing: '同期中',
  ready: '同期済み',
  waiting: '送信・適用待ち',
  error: '同期エラー',
  authentication: '再ログインが必要'
};
const modeLabels = { enabled: '共有', localOnly: 'この端末のみ', excludedByDeletion: '削除済み・自動取得しない' };
export function mountCloudSync(store: CloudStore, repository: StudyRepository, engine: SyncEngine): () => void {
  const host = el('div', 'cloud-sync-control'),
    open = button('☁', 'cloud-sync-icon'),
    dialog = el('dialog', 'cloud-sync-dialog'),
    content = el('div'),
    close = button('閉じる', 'cloud-sync-close');
  open.setAttribute('aria-label', 'クラウド教材同期の設定');
  dialog.append(content, close);
  host.append(open, dialog);
  document.body.append(host);
  close.onclick = () => dialog.close();
  let active = true;
  const update = () => {
    open.title = labels[engine.status];
    open.dataset.status = engine.status;
    open.setAttribute('aria-label', `クラウド教材同期: ${labels[engine.status]}`);
  };
  const unwatch = engine.subscribe(update);
  update();
  const run = async (work: () => Promise<void>) => {
    try {
      await work();
    } catch (e) {
      if (active) content.append(el('p', 'cloud-error', e instanceof Error ? e.message : '処理に失敗しました。'));
    }
  };
  async function show() {
    const settings = await store.settings();
    if (!active) return;
    content.replaceChildren(
      el('h2', '', 'クラウド教材同期'),
      el('p', '', '教材と画像だけを共有します。回答・復習・ブックマークは送信しません。')
    );
    if (!settings?.token) {
      if (nativeCloud() && !nativeCloud()!.origin()) {
        content.append(
          el(
            'p',
            '',
            'このAPKは本番API未設定の検証ビルドです。公開URL確定後、接続先を固定して再ビルドします。オフライン学習は利用できます。'
          )
        );
        return;
      }
      content.append(el('p', '', '合言葉でログインすると、選んだ教材をほかの端末と共有できます。共有する教材はログイン後に選べます。'));
      const url = el('input'),
        name = el('input'),
        phrase = el('input');
      url.type = 'url';
      url.placeholder = 'https://…chatgpt.site';
      url.value = settings?.apiUrl ?? nativeCloud()?.origin() ?? 'https://loopdeck3-sync-20261022.salmon1124.chatgpt.site';
      url.disabled = !!settings?.setupComplete || !!nativeCloud();
      url.setAttribute('aria-label', 'API URL');
      name.placeholder = 'この端末の名前';
      name.value = settings?.deviceName ?? '';
      name.setAttribute('aria-label', '端末名');
      phrase.type = 'password';
      phrase.autocomplete = 'current-password';
      phrase.placeholder = '合言葉';
      phrase.setAttribute('aria-label', '合言葉');
      const login = button('ログイン', 'cloud-sync-primary');
      login.onclick = () =>
        void run(async () => {
          login.disabled = true;
          try {
            const api = new CloudApi(url.value.trim());
            const token = await api.login(phrase.value, name.value.trim() || 'LoopDeck3');
            phrase.value = '';
            await store.configure({
              key: 'settings',
              apiUrl: api.base,
              token,
              deviceName: name.value.trim() || 'LoopDeck3',
              setupComplete: settings?.setupComplete ?? false
            });
            await show();
            void engine.tick();
          } finally {
            login.disabled = false;
          }
        });
      // The endpoint is fixed for almost everyone, so it stays folded away instead of leading the form.
      const endpoint = el('details', 'cloud-sync-endpoint');
      endpoint.append(el('summary', '', '接続先を変更'), url);
      content.append(name, phrase, login, endpoint);
      return;
    }
    const api = new CloudApi(settings.apiUrl, settings.token);
    if (!settings.setupComplete) {
      content.append(
        el(
          'p',
          '',
          '初回設定：既存教材は選んだものだけ共有します。同じ教材がクラウドにある場合はクラウド最新版を優先します。選ばない教材は、今後編集してもローカル専用です。設定後の新規インポートは自動共有されます。変更された設問の復習状態は従来どおり整理されます。'
        )
      );
      const backup = button('設定前のバックアップを保存');
      backup.onclick = () =>
        void run(async () => {
          const snapshot = await repository.exportSnapshot();
          await saveBlob(new Blob([JSON.stringify(snapshot)], { type: 'application/json' }), 'loopdeck-before-cloud.json');
        });
      content.append(backup);
      const heads = await api.heads(),
        packs = await repository.getImportedPacks(),
        selected = new Map<string, HTMLInputElement>(),
        excluded = new Map<string, HTMLInputElement>();
      for (const pack of packs) {
        const label = el('label'),
          check = el('input');
        check.type = 'checkbox';
        label.append(check, document.createTextNode(`共有する: ${pack.title} (${pack.packId})`));
        content.append(label);
        selected.set(pack.packId, check);
      }
      const local = new Set(packs.map((p) => p.packId));
      for (const head of heads)
        if (!local.has(head.packId)) {
          const label = el('label'),
            check = el('input');
          check.type = 'checkbox';
          label.append(check, document.createTextNode(`この端末への取り込みを除外: ${head.title}`));
          content.append(label);
          excluded.set(head.packId, check);
        }
      const finish = button('この設定で自動同期を開始');
      finish.onclick = () =>
        void run(async () => {
          finish.disabled = true;
          try {
            await store.setup(
              [...selected].filter(([, c]) => c.checked).map(([id]) => id),
              [...excluded].filter(([, c]) => c.checked).map(([id]) => id),
              await api.heads()
            );
            await engine.tick();
            await show();
          } finally {
            finish.disabled = false;
          }
        });
      content.append(finish);
      return;
    }
    content.append(
      el('p', '', `${labels[engine.status]}${engine.error ? ' — ' + engine.error : ''}`),
      el(
        'p',
        '',
        settings.lastSuccess ? `最終同期成功: ${new Date(settings.lastSuccess).toLocaleString()}` : '完全な同期はまだ成功していません。'
      )
    );
    const retry = button('今すぐ再試行');
    retry.onclick = () =>
      void run(async () => {
        await store.retry();
        await engine.tick();
        await show();
      });
    content.append(retry);
    const heads = await api.heads(),
      packs = await repository.getImportedPacks(),
      ids = new Set([...packs.map((p) => p.packId), ...heads.map((h) => h.packId)]);
    for (const id of ids) {
      const head = heads.find((h) => h.packId === id),
        pack = packs.find((p) => p.packId === id),
        state = await store.state(id),
        row = el('section');
      row.append(
        el('h3', '', pack?.title ?? head?.title ?? id),
        el('p', '', `同期: ${modeLabels[state?.mode ?? 'enabled']}${state?.dirty ? ' / 送信待ち' : ''}`)
      );
      const enabled = !state || state.mode === 'enabled',
        toggle = button(enabled ? 'この端末で同期OFF' : 'この端末で同期ON');
      toggle.onclick = () =>
        void run(async () => {
          await store.setEnabled(
            id,
            !enabled,
            (await api.heads()).some((h) => h.packId === id)
          );
          await engine.tick();
          await show();
        });
      row.append(toggle);
      if (head) {
        const history = button('クラウド履歴');
        history.onclick = () =>
          void run(async () => {
            const area = el('div');
            for (const revision of await api.history(id)) area.append(revisionRow(api, revision));
            row.append(area);
            history.disabled = true;
          });
        row.append(history);
      }
      content.append(row);
    }
    const logout = button('この端末をログアウト'),
      all = button('全端末をログアウト');
    logout.onclick = () =>
      void run(async () => {
        await api.request('/auth/logout', { method: 'POST' });
        await store.clearToken();
        await show();
      });
    all.onclick = () =>
      void run(async () => {
        if (!confirm('全端末のセッションを無効化します。教材と未送信キューは残ります。')) return;
        await api.request('/auth/logout-all', { method: 'POST' });
        await store.clearToken();
        await show();
      });
    content.append(logout, all);
  }
  function revisionRow(api: CloudApi, revision: CloudRevision): HTMLElement {
    const row = el('p'),
      restore = button('この版を新しい最新版として復元');
    row.append(document.createTextNode(`版${revision.revision} · ${revision.committedAt} `), restore);
    restore.onclick = () =>
      void run(async () => {
        restore.disabled = true;
        try {
          await store.restore(api, revision.packId, revision.revision);
          await store.setEnabled(revision.packId, true);
          await engine.tick();
          await show();
        } finally {
          restore.disabled = false;
        }
      });
    return row;
  }
  open.onclick = () => {
    if (!dialog.open) dialog.showModal();
    void run(show);
  };
  return () => {
    active = false;
    unwatch();
    host.remove();
  };
}
