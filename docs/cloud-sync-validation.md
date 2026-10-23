# クラウド教材同期の検証記録

2026-10-22〜23。GitHub main `dbf9d58` を基にした `feat/pack-cloud-sync` の実験。
実験API: https://loopdeck3-sync-20261022.salmon1124.chatgpt.site 。承認されたダミー教材と公開内蔵教材だけを送信した。
使用者は2026-10-23にPR作成・mainへのマージを承認。本番Siteへの移行を意味しない。

## 実測結果

| 対象 | 結果・確認範囲 |
| --- | --- |
| PC Chrome `file://` | 使用者が自動送受信・「同期済み」・内蔵教材1112問/importedを確認。Androidと同じ教材を共有できた |
| 公開API | 認証なし401、許可したnull/appassetsのOPTIONS 204、他Origin 403。1/5/16/32 MiB往復・SHA一致、32 MiB+1は413。再デプロイ後もセッション・ZIP保持 |
| Android debug・moto g13/Android 14 | 自動送受信・既存インポーター・32 MiB・ダミー学習記録/他教材の不変を確認 |
| Android背景実行 | 実際にWebViewを破棄して5 MiBは携帯回線で送受信、5 MiB+1はWi-Fi待ち。Wi-Fi復帰で自然再試行。32 MiB送受信中のWi-Fi切断で部分データを廃棄し再試行後SHA一致 |
| 再起動・制限 | 実再起動後、アプリを開かず自然送信。強制deep Doze・標準AppOps制限中は未送信保持、解除後に自然送信 |
| WebView境界 | health 200。不正API/メソッド/クエリ、外部リソース・ドキュメント遷移を拒否。既存22教材・学習状態不変 |
| 署名済みrelease | 別ID、DEBUG=false、既存LoopDeck3鍵のv1/v2署名。実機の通常UIでログインPOST 200、内蔵教材1112問/画像4件受信、通常インポートから自動POST 201、次回起動で別クライアント更新を自動適用。実機のCDP接続口なし |
| OSバックアップ | 専用API 35エミュレーターのLocalTransportで教材・未送信意図を復元。認証/Native ZIPは除外され再ログイン可能。実機データの初期化なし |

署名済みrelease UI試験は、同じ鍵で署名した別androidTest APKが通常のWebView UIハンドラーを操作した。アプリDBへの直接書き込みはしない。ヘルパーは試験後に削除した。送信revision 46は独立したHTTP GETとSHA/既存インポーターで検証。別クライアントPOST 201のrevision 47は次回起動で内容・ローカルrevision・同期済み表示を確認した。受信時のHTTP計測フックは取得開始に間に合わなかったため、後者のGETステータスを実測成功とは記載しない。

ローカル回帰試験: `npm run verify`（861件/96ファイル）、`npm run test:cloud-server`（workerd/D1/R2のHTTP15件と2クライアント13件）、`npm run test:cloud-policy`（Java34件）、loopback Chrome 6件が成功した。公開・実機試験のJSON/ログは配布物の `evidence/public` に保存し、資格情報・鍵は含めない。

## 再現手順

1. ルートで `npm ci`、server内でも `npm ci`（serverはNode 22.13以上）。`npm run verify`、`npm run test:cloud-server`、JDKを用意して `npm run test:cloud-policy`。これらは公開サービス・端末を変更しない。新しいHTTP/ポリシー試験はCIにも登録。
2. 承認されたSiteとSecretを用意し、[API仕様](cloud-sync-api.md) と [サーバー手順](../server/README.md) に従う。Secretをソース・引数・ログに残さない。CORSのnull許可はfile HTML用の例外で、他のnull Originも区別できない。認証は必須。
3. `npm run build:single` でHTMLを生成し、Chromeでダブルクリックして開く。☁からログイン、初回の共有/除外を選択する。許可済みダミーを通常インポートして同期済みを確認。
4. `android` で `gradle assembleDebug -PsyncPreview=true -PsyncApiOrigin=https://承認済みSite`。APKは別ID。署名済みreleaseは [設計](cloud-sync-implementation.md) の環境変数かローカルのkeystore.propertiesを用い、`assembleRelease -PsyncPreview=true -PsyncApiOrigin=...`。既存の本番APKを置き換えない。
5. 同じSiteへログインし、PCの教材を受信、Androidで別ダミーを通常インポートしてPCへの自動受信を確認。ZIPのバイナリSHAと意味的fingerprintを分けて比較する。学習記録・他教材の前後一致も確認する。
6. 背景/再起動/回線切替はUSB接続の専用端末と明示的な操作許可を用意する。`qa/*.mjs` の実機スクリプトは当日の端末ID・実験URL・状態に依存する記録用で、一括自動実行しない。再起動、回線変更、fixture修復を行うものがある。`qa/android-backup.mjs` は専用エミュレーターのデータを消すため、ガードを外して実機へ実行しない。`qa/release-ui.mjs` は初回設定前の専用release QA IDが前提であり、再実行目的で通常アプリを消去しない。

## 限界と結論

PC単体HTMLとAndroidから同じSites/D1/R2教材を送受信できることは実測できた。教材の自動同期は実装・範囲内で検証済み。WorkManagerはOS都合による遅延を含み、常時・即時の完全自動同期は保証しない。

署名済み実機releaseの背景実行一式、自然な長時間Doze/保守窓、メーカー独自電池制限、Google/OEMクラウド復元・機種移行、実利用者の既存DB移行、PC file自身の32 MiB境界は未検証。本番Site・Secret・実データへの切替は別途受入が必要。通常APKビルドはAPI未設定でクラウド通信を無効化し、HTMLの初期URLは実験Siteを示す。

補助的な `npm run check:architecture` は既存の循環2件（flashcardSession→inlineQuiz、moduleScreen→flashcardSession）で失敗し、この変更で解消したとは扱わない。
