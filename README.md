# LoopDeck3

HTMLを中心に動くオフライン学習アプリ。Android版は同じHTMLを表示するWebViewホストです。

## ダウンロード

[Releases](https://github.com/stupidsavacan/LoopDeck3/releases/latest)から以下を取得します。このリポジトリとリリースは非公開です。

- `LoopDeck3.html`: 保存してブラウザで開く単体HTML
- `LoopDeck3.apk`: 署名付きAndroidアプリ
- `SHA256SUMS.txt`: 両ファイルの検証用ハッシュ

AndroidアプリIDは `com.loopdeck3.app`。LoopDeck2と別アプリとして共存します。旧アプリの保存領域とバックアップは扱いません。0.2.1では保存形式を新設したため、0.1.xのデータも読み込みません。HTMLの保存領域もブラウザ・ファイルの場所によって異なるため、移動前にバックアップしてください。

## 開発と設計

```sh
npm ci --include=dev
npm run dev:local
npm run verify
npm run qa:chrome
npm run code:map
```

`npm run build:single` が `LoopDeck3.html` を生成します。Androidの `preBuild` はこのファイルだけを `assets/loopdeck/index.html` にコピーします。APKとHTMLで学習ロジックを二重実装しません。

配布・内部API・画面構成は独立して設計します。LoopDeck2の内部API互換性は保証しません。最初の基準版は、LoopDeck2 [PR #115](https://github.com/stupidsavacan/LoopDeck2/pull/115) の `656ed528419a8e6f35294f258b7604fe2bb59d42` から派生しました。0.2.1ではアプリの起動・画面の寿命・ナビゲーション・保存形式を再設計しました。画面は共通コンテキストを受け取り、古い非同期処理が新しい画面を上書きできない構成です。学習・復習・PDFの検証済みアルゴリズムと教材は利用しています。

現在の設計は [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。旧版から引き継いだ他の設計メモやIssue番号は参考資料です。LoopDeck2の未解決問題がすべて解消されたことは意味しません。

## リリース

`package.json` のバージョンを更新して `v<version>` タグをpushします。手動実行もできます。公開前に型・静的検査・単体テスト・ブラウザQA・署名検証・APK内HTMLとの完全一致を確認します。失敗したビルドは公開しません。

署名鍵の扱いは [android/README_SIGNING.md](android/README_SIGNING.md)。Androidの実機でのファイル選択・保存・復帰はブラウザQAとは別に確認が必要です。
