# Pack同期API v1

公開検証先: https://loopdeck3-sync-20261022.salmon1124.chatgpt.site 。2026-10-22に専用D1/R2とSecretを用意して公開。教材操作はBearer認証必須。

Phase 1/2実験サイトの `/api/*` とは別プロトコル・別データで運用する。

| メソッド・パス                                     | 入力                                       | 成功                                          |
| -------------------------------------------------- | ------------------------------------------ | --------------------------------------------- |
| GET /api/v1/health                                 | 認証不要                                   | `{ok, protocol:1, maxZipBytes:33554432}`      |
| POST /api/v1/auth/login                            | JSON `{passphrase, deviceName}`            | `{token, expiresAt:null}`                     |
| GET /api/v1/auth/me                                | Bearer                                     | `{authenticated, deviceName, expiresAt:null}` |
| POST /api/v1/auth/logout                           | Bearer                                     | 現在のセッションを取消                        |
| POST /api/v1/auth/logout-all                       | Bearer                                     | 全端末のセッションを取消                      |
| GET /api/v1/packs?after=…                          | Bearer、任意のカーソル                     | `{packs, nextCursor, sequence}`、100件/頁     |
| POST /api/v1/packs/:id/revisions                   | Bearer、ZIP、Idempotency-Key               | revisionメタデータ、201                       |
| GET /api/v1/packs/:id/revisions                    | Bearer                                     | `{revisions}`、新しい順、最大10件             |
| GET /api/v1/packs/:id/revisions/:revision/download | Bearer                                     | 元のZIP、200                                  |
| POST /api/v1/packs/:id/restore                     | Bearer、JSON `{revision}`、Idempotency-Key | 新しい最新版、201                             |

idはURLの1セグメントとしてエンコードし、200文字以内、制御文字なし。ZIP内部のpackIdと一致必須。
メタデータは `packId, revision, contentFingerprint, sha256, size, title, questions, committedAt`。
revisionは共有ライブラリ全体のコミット順による単調増加値。Pack単位の連番とは限らない。

## 検証・冪等性

ZIPのContent-Typeはapplication/zipまたはapplication/octet-stream。圧縮サイズ32 MiB、展開後合計64 MiB、1エントリー12 MiB、JSON 8 MiB、画像8 MiB、256エントリーの既存上限を維持。クラウド経路は全エントリーのCRC・展開サイズも順番に検証する。

意味的Fingerprintは正規化したPackのキー順を固定したJSONと、参照画像のパス順・バイトSHA-256から計算。installedOrder/contentRevision、ZIP日時、学習履歴は含めない。X-Content-Fingerprintがあれば照合する。
同じ意味的内容の通常アップロードは版を増やさない。この応答SHAは既存ZIPの値なので、送信ZIPのSHAと異なることがある。ダウンロードではメタデータSHAと全受信バイトを照合する。レスポンスにもX-Content-SHA256/X-Content-Fingerprintを付ける。

初回共有だけ `If-None-Match: *` を付ける。初回一覧取得後に同じPackが作られても、D1トランザクション内で412にし、古いローカル版による上書きを防ぐ。クライアントはこの初回送信だけ取り下げ、クラウド版を取得する。以後の明示的なローカル更新は通常の最終コミット優先。

Idempotency-Keyは8〜128文字の英数字・ハイフン・アンダースコア。同じ操作ID・意味的内容の再送は以前の応答、別内容への流用は409。クライアントは操作IDと送信ZIPを永続化する。復元は同じ内容でも新しい版を作り、同じ復元操作IDの再送では増やさない。PCの復元操作IDも永続化する。

## 保存と障害

R2に一意キーで保存してから、D1 batchでrevision/head/receiptを原子的に確定。最新版込み10版を保持する。R2削除失敗は永続ジャーナルから再試行。未参照の保存途中オブジェクトは24時間後に回収対象となる。回収は認証済み要求・書き込み後のwaitUntilで起動し、無アクセス時の回収時刻は保証しない。
DBにあるファイルがR2にない場合は503 storage_inconsistentと障害記録。同じ内容を新しい操作IDで再送すると新しいキー・版として修復できる。失われたバイト自体は自動復元できない。

## 認証・CORS

合言葉はSecret SYNC_PASSPHRASEのみ。ランダム32バイトのトークンを64桁hexで発行し、D1にはそのSHA-256を保存。期限なし。現在端末/全端末ログアウト、合言葉Secret変更後の初回APIアクセスでの世代更新により取消する。進行中の処理を後から巻き戻す機能はない。
ログインはIP単位5回/5分・全体100回/5分。書き込み/復元は端末60回/時・全体240回/時。429にRetry-Afterを付ける。

ALLOWED_ORIGINSは完全一致。Androidにはhttps://appassets.androidplatform.netを指定する。ALLOW_NULL_ORIGIN=trueのときだけOrigin:nullを許可。nullはfile://の身元証明ではなくsandbox iframe等も使うため、Bearer認証を必須とする。Cookie認証やAllow-Credentialsは使わない。
OPTIONSはGET/POST、Authorization/Content-Type/Idempotency-Key/X-Content-Fingerprint/If-None-Matchのみ許可。
外部HTML/APKにはSites側の公開設定も必要。SitesのChatGPTログインと本APIのBearer認証は別の制約。公開Sitesの外部到達・32 MiB試験は未実施。

エラーは `{error:code}`。401認証、403オリジン/プリフライト、409操作ID流用、412初回作成競合、413容量、415形式、422教材/画像/CRC、429頻度、503未設定/保存不整合。
