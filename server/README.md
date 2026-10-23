# LoopDeck3 Pack Sync server

Sites Vinext/Workers + D1 + R2。承認済みの専用実験サイトで公開・実測済み。本番へのデータ移行は行っていない。
実験URL: https://loopdeck3-sync-20261022.salmon1124.chatgpt.site 。`.openai/hosting.json` はこの実験Siteの識別子であり、新しいSiteでは必ず差し替える。
API仕様: ../docs/cloud-sync-api.md。
受入結果と未検証範囲: ../docs/cloud-sync-validation.md。
同じリポジトリの ../src/packs を正本とし、ビルド前にscripts/prepare-protocol.mjsでgenerated/へ共通検証コードを束ねる。ソースハッシュ・ソースマップ・ライセンスを同梱し、サーバー用に検証ロジックを書き直さない。
Sites用にserverだけを切り出した場合は、版管理されたgeneratedモジュールのSHAを検証して使用する。親srcなしの単独ビルドもローカルで確認済み。

## ローカル再現

Node 22.13以上。リポジトリルートで npm ci、server内でも npm ci。
server内で npm run test:sync、npx tsc --noEmit、npm run build。
テストは実際のローカルworkerd・D1・R2とHTTP要求を使い、公開用と無関係なfixture合言葉を利用する。
tests/.generated/results.json と two-clients-results.json に結果を保存する。公開Sitesや実機の証拠とは扱わない。

## 承認後のSites公開手順

1. 新しい本番Site・D1・R2を作り、実験データから分離する。GitHubの別リポジトリは作らない。
2. .openai/hosting.json に返されたSite IDを設定。DB/BUCKETの論理バインディングを維持する。
3. Sites SecretのSYNC_PASSPHRASEを設定。ALLOWED_ORIGINSはappassetsのオリジンだけ、PC file利用用にALLOW_NULL_ORIGIN=trueを明示。値はソース・ログに保存しない。
4. drizzle/0000__.sql、0001__.sqlを順にSitesのDB移行として適用。要求処理中にDDLを実行しない。
5. 正本ルートから共有モジュールを再生成後、Sites source helperのチェックアウトへserver配下を渡してビルドする。配布対象はdist。この経路は専用実験Siteで登録・公開・再デプロイを実測済み。
6. Sitesネイティブのsave/deployフローで公開。他サービスや通常のwrangler deployへ切り替えない。ビルド内のプレースホルダーDB IDを実サービスへ流用しない。
7. 実HTTPでhealth、null/appassetsプリフライト、認証、1/5/16/32 MiB・32 MiB+1、SHA、再デプロイ後のセッション・ファイル残存を確認する。
8. 公開URLをAndroidの -PsyncApiOrigin=https://...chatgpt.site に固定して再ビルドし、PC・実機・終了中Workerを試験する。

ローカルbuild成功だけでSites登録・公開・128 MB環境の最大サイズ対応を成功扱いにしない。本番APIの指定・Secret・データ移行は実験Siteとは別のリリース判断とする。
