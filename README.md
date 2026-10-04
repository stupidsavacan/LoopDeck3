# LoopDeck3

HTMLを中心に動くオフライン学習アプリ。Android版は同じHTMLを表示するWebViewホストです。

## ダウンロード

[Releases](https://github.com/stupidsavacan/LoopDeck3/releases/latest)から以下を取得します。このリポジトリとリリースは非公開です。

- `LoopDeck3-single-<run>-<attempt>.html`: 保存してブラウザで開く単体HTML
- `LoopDeck3-signed-release-<run>-<attempt>.apk`: 署名付きAndroidアプリ
- `SHA256SUMS.txt`: 両ファイルの検証用ハッシュ

AndroidアプリIDは `com.loopdeck3.app`。LoopDeck2と別アプリとして共存します。旧アプリの保存領域とバックアップは扱いません。0.2.1では保存形式を新設したため、0.1.xのデータも読み込みません。HTMLの保存領域もブラウザ・ファイルの場所によって異なるため、移動前にバックアップしてください。

## 開発と設計

教材の学習カスタマイズで「回答形式 → カード」を選ぶと、タップで表裏を切り替え、右スワイプで「知ってる」、左スワイプで「知らない」を記録できます。キーボードはSpace/Enterで反転、左右矢印で判定します。出題方向は開始前の設定を使い、途中再開と再挑戦でも維持します。終了後はAGAINだけ、または全カードをもう一度学習できます。カードでは自動送り・無操作での答え表示を適用せず、それぞれの設定値は保持します。

```sh
npm ci --include=dev
npm run dev:local
npm run verify
npm run qa:chrome
npm run code:map
```

`npm run build:single` が `LoopDeck3.html` を生成します。Androidの `preBuild` はこのファイルだけを `assets/loopdeck/index.html` にコピーします。APKとHTMLで学習ロジックを二重実装しません。

配布・内部API・画面構成は独立して設計します。LoopDeck2の内部API互換性は保証しません。最初の基準版は、LoopDeck2 [PR #115](https://github.com/stupidsavacan/LoopDeck2/pull/115) の `656ed528419a8e6f35294f258b7604fe2bb59d42` から派生しました。0.2.1ではアプリの起動・画面の寿命・ナビゲーション・保存形式を再設計しました。画面は共通コンテキストを受け取り、古い非同期処理が新しい画面を上書きできない構成です。0.3.0では学習中の状態管理と回答保存を再設計し、画面から保存先の暗黙の参照を取り除きました。学習・復習・PDFの検証済みアルゴリズムと教材は利用しています。

現在の設計は [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。旧版から引き継いだ他の設計メモやIssue番号は参考資料です。LoopDeck2の未解決問題がすべて解消されたことは意味しません。

## リリース

mainへのマージ・pushで、署名付きAPKと単体HTMLを自動生成し、ReleaseのLatestに掲載します。L2と同じ `signed-apk-<run>-<attempt>` タグとビルド番号の方式を使います。タグの手動pushや `package.json` のバージョン更新は不要です。手動実行も同じ方式で新しいReleaseを作成します。公開前に型・静的検査・単体テスト・ブラウザQA・署名検証・APK内HTMLとの完全一致を確認します。失敗したビルドは公開しません。

Actionsの `Build Android Debug APK` もHTMLとデバッグAPKを生成し、`LoopDeck3-debug-apk` 成果物としてまとめて保存します。普段のダウンロードにはReleaseの署名付きAPK・HTMLを使用します。

署名鍵の扱いは [android/README_SIGNING.md](android/README_SIGNING.md)。Androidの実機でのファイル選択・保存・復帰はブラウザQAとは別に確認が必要です。
