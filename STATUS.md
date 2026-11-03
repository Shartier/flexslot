# FlexSlot — 状況と次の作業

更新日：2026-11-03（日本時間）/ 文書版：status-v0.3。

## 現在地

技術設計の修正段階。Codexの第1レビュー（対象：タグ`design-review-1`、判定：設計修正を依頼）の指摘DR1-01〜05と小修正を、DESIGN.md（design-v0.2）に反映した。対応箇所はDESIGN 15章とREVIEWの「第1レビュー指摘への対応」。修正版はタグ`design-review-1-fix1`で特定する（`git rev-parse design-review-1-fix1`）。元のタグ`design-review-1`は付け替えていない。

決済回復に依存しない骨組み・候補判定・利益計算は、Codexの判断で着手してよいことになった。アプリ本体の実装、AIの実接続、PayPal Sandboxの接続、公開、応募の成功はまだ確認していない。

## Claude Codeの確認（2026-11-03、第1区切り）

| 項目 | 確認結果 |
| --- | --- |
| 既存文書とGit | AGENTS、SPEC、STATUS、REVIEW、CLAUDE_STARTを読んだ。着手時は`main`の`a1121b4`（タグhandoff-v0.1と同じ）で、作業ツリーに未コミットの変更はなかった。既存の変更を上書きしていない |
| ブランチ | ユーザーの選択で`design/review-1`を作成し、この上で作業した。`main`は変更していない |
| Node.js / npm | v24.22.1 / 11.19.1 |
| PowerShell 7 | 着手時は未導入。ユーザーの許可を得て、wingetで`Microsoft.PowerShell`をユーザー範囲に導入した（7.6.9）。既存のHTML 5組は導入直後の`render-docs.ps1 -Check`で一致を確認 |
| Google Cloud CLI | `gcloud`はPATHになく、Cloud SDKのフォルダもない。ADCのファイルもない |
| 環境変数 | `PAYPAL_CLIENT_ID`、`PAYPAL_CLIENT_SECRET`、`PAYPAL_WEBHOOK_ID`、`GOOGLE_CLOUD_PROJECT`、`GOOGLE_CLOUD_LOCATION`、`GOOGLE_APPLICATION_CREDENTIALS`、`GEMINI_API_KEY`、`GOOGLE_API_KEY`は、このシェルではいずれも未設定（値は表示していない）。フォルダ内に`.env`はない。別の場所に設定がある可能性は否定していない |
| Gitの作者 | `user.name`と`user.email`は未設定のまま。ユーザーの選択で、今回のコミットだけ仮の作者`Claude Code <claude-code@local.invalid>`を指定した。Gitの設定は変更していない |
| SQLiteの事前確認 | Node内蔵の`node:sqlite`（メモリ上のDB）で、重なる予約・FROZENの保留と重なる予約をトリガーが`SLOT_CONFLICT`で拒否し、同じA予約への2件目の案件を部分一意インデックスが拒否した。隣接する予約は許可された。`BEGIN IMMEDIATE`も実行できた。使い捨ての確認であり、本番スキーマのテストではない |
| PayPalの公式資料 | 与信・売上確定・返金・取消の応答は既定で最小の形式（`return=minimal`）で、完全な応答には`Prefer: return=representation`が必要。部分返金では金額の指定が必要（省略すると全額返金）。2026-11-03に確認 |
| 再送防止IDの保持期間（訂正） | status-v0.2では「記載なし」と書いたが誤り。冪等性の資料と各APIのページには期間の記載がない一方、RESTリクエストの資料（developer.paypal.com/api/make-api-requests/）に「最大45日」保存するとの記述がある（Codexの指摘を受けて2026-11-03に確認）。これは各APIで45日間の保持を保証する記述ではない |
| 観測の範囲 | 上のPowerShell・Cloud SDK・環境変数の結果は、Claude Codeのシェルから見た観測。PC全体での不存在や導入履歴まで確認したものではない |

## 以前の確認（Codex、2026-11-03）

| 項目 | 確認結果 |
| --- | --- |
| 作業場所 | `C:\Users\ich30\Documents\Codex\2026-11-03\flexslot-paypal-ai-hackathon-web-codex` |
| 着手時のファイル | 空のoutputs、workのみ。既存コード・設定ファイルなし。既存ファイルの上書きなし |
| 専用性 | 今回指定のFlexSlot専用フォルダとして使用。別プロジェクトのコードはコピーしていない |
| 指示ファイル | 作業フォルダからCドライブまでの確認可能な各親にAGENTS.mdなし。ユーザー提示のMarkdown＋HTML作成ルールを新規AGENTS.mdへ記録 |
| Git | 着手時は親も含めGitリポジトリでない。`git init -b main`でローカル初期化。Git 2.53.0.windows.1。リモートなし。初期文書の基準タグはhandoff-v0.1 |
| 以前の会話 | ChatGPT「PayPal☆ハッカソン」（ID: 6ae718f9-0e70-83ec-adf5-d76e746475dc）の取得できた直近5往復を確認。ローカル共有・実装担当一本化・実コードレビューを再確認 |
| 作品内AI | ユーザーはGoogle Cloud APIを希望、クレジットに余裕があると回答。Gemini on Vertex AIを第一候補とした。残高・利用権限の検証は未実施 |
| 公式規約 | 締切11月13日05:00 JST、公開コード＋OSSライセンス、動くデモ、英語/英訳、公開YouTube実演を公式ページで確認 |
| PayPal設計根拠 | 公式のauthorize/capture、void、captureへのrefund、Webhook検証、冪等性と結果照会を確認。APIを実行した記録ではない |
| 作成物 | AGENTS.md、SPEC.md、STATUS.md、REVIEW.md、CLAUDE_START.md、同内容HTML、.gitignore、.gitattributes、文書生成スクリプト |

以前の会話は取得できた範囲の確認であり、過去の全メッセージやPC全体を調査したという意味ではない。現在のユーザー指示を最新の合意とする。

Gitのuser.name/user.emailは未登録だったため、初期文書コミットに限り一時的な作者 `Codex <codex@local.invalid>` を指定した。ユーザーのローカル/グローバルGit設定は変更していない。

参照：[公式規約](https://paypalaihackathon.devpost.com/rules)、[PayPal決済](https://developer.paypal.com/v5/checkout/auth-capture)、[Google Cloud認証](https://cloud.google.com/vertex-ai/generative-ai/docs/start/gcp-auth)。

## 実行した確認とテスト

| 日付・担当 | 区分 | 実施内容 | 結果 |
| --- | --- | --- | --- |
| 11-03 Codex | フォルダ | Get-Location、Get-ChildItem、rg --files --hidden、親AGENTS確認 | 既存コードなし、上書き対象なし |
| 11-03 Codex | Git | git rev-parse / status / remote、git init -b main | 初期化に成功 |
| 11-03 Codex | 文書検証 | render-docs.ps1 -Checkによる本文・SHA-256照合 | 5組で一致 |
| 11-03 Codex | Git除外 | .env、入れ子.env、秘密鍵、DB、ログ、work等の除外 | 除外10パターン合格、追跡可能4パターン合格 |
| 11-03 Codex | 計算 | 利益例、PSTからJSTへの日時換算 | USD 20.50、締切2026-11-13 05:00 JST |
| 11-03 Claude | 環境 | node / npm / pwsh / gcloud / docker のバージョン、ADCファイルと環境変数の有無（値は非表示） | 上の表のとおり |
| 11-03 Claude | 導入 | `winget install --id Microsoft.PowerShell --source winget --scope user` | 終了コード0、7.6.9 |
| 11-03 Claude | 文書検証 | `pwsh -NoProfile -File tools/render-docs.ps1 -Check`（導入直後、変更前） | 5組すべてPASS |
| 11-03 Claude | DB事前確認 | `node:sqlite`の使い捨てスクリプト（トリガー、部分一意インデックス、BEGIN IMMEDIATE） | 期待どおり拒否・許可。スクリプトは削除済みでリポジトリに含めていない |
| 11-03 Claude | 文書生成 | DESIGN.mdを追加し、`render-docs.ps1`の対象に加えて全HTMLを再生成、`-Check`で照合 | 結果はREVIEWの第1レビュー依頼に記載 |
| 11-03 Claude | 設計修正 | DR1-01〜05と小修正をDESIGN（design-v0.2）・STATUS・REVIEWへ反映し、HTMLを再生成して`-Check`で照合 | 結果はREVIEWの「第1レビュー指摘への対応」と報告メッセージに記載 |
| ─ | アプリテスト | 単体・統合・E2E・実API・実機 | 未実行。アプリコードなし |

## 未確認事項

| ID | 項目 | 現時点の扱い | 確認担当・時期 |
| --- | --- | --- | --- |
| U01 | PayPal Developerの準備（Sandboxの事業者・買い手アカウント、RESTアプリの認証情報） | このPCでは環境変数・`.env`とも見当たらない。未作成とは断定しない | 本人がV0で準備。Claudeは値を見ない |
| U02 | Sandboxの事業者アカウントの国と通貨、与信（AUTHORIZE）の利用可否 | 未確認。USDで進める案。競合作品の国の制約は転用しない | V1〜V3 |
| U03 | 与信・注文の照会から、売上確定IDを取得できるか | 未確認。できない場合は同じ再送防止IDでの再送に頼る | V4 |
| U04 | 返金の状態の種類と、元captureの照会で返金済みの額が分かるか | 未確認。返金ID・照会の組み合わせで設計 | V6 |
| U05 | `PayPal-Request-Id`の保持期間 | RESTリクエストの資料に「最大45日」の記述あり。各APIでの保証は未確認。数分以内の再送だけを前提にし、長期間後の再送には頼らない。短時間の再送試験から長期間の安全性を結論しない | V4・V6で短時間の再送だけ確認 |
| U06 | Webhookの実配送と署名検証 | 必須の接続検証（V8）。公開デモの採否とは別に、本人確認後の限定的なHTTPS受信経路で行う。承認がなければ未確認のまま残す | V8（11月7日目標、本人確認後） |
| U07 | Google Cloudのプロジェクト、課金、Vertex AI APIの有効化、リージョン、利用できるGeminiのモデル | 未確認。gcloudとADCはこのPCにない | 本人の準備後にV9 |
| U08 | `node:sqlite`の安定性（Node 24） | 事前確認では警告なく動作。問題があれば`better-sqlite3`に差し替える | 骨組みの実装時 |
| U09 | 公開デモの置き場所と審査員のアクセス方法（Sandboxの買い手アカウントの共有方法を含む） | 未確定。第一候補はCompute Engine | 提出準備時、本人確認後 |
| U10 | OSSライセンス、Devpost登録・参加資格 | 未確定 | 本人、提出準備 |
| U11 | 現在のCodex/Claudeのモデル | モデル切替を実行・検証していない | 各アプリのモデル選択で本人確認 |

## 本人にお願いする準備（V0）

1. **PayPal Developer**：Sandboxの事業者アカウントと買い手アカウント、RESTアプリを用意し、クライアントIDとシークレットをこのフォルダの`.env`に自分で記入する（変数名は実装時に`.env.example`で示す）。値をチャットに貼らない。
2. **Google Cloud**：Vertex AIに使うプロジェクトを決め、課金とVertex AI APIを有効にする。Google Cloud CLIを導入し、`gcloud auth application-default login`でADCを作る。
3. **確認しないこと**：Claudeは認証情報の値を表示・保存・送信しない。設定されたかどうかだけを確認する。

## 次に行う作業

1. Codexによる修正版（`design-review-1-fix1`）の再確認。
2. 並行して、決済回復に依存しない骨組み・候補判定・利益計算と、その単体テストを実装する（Codexの判断で着手可）。決済の実行器と回復は、再確認の後に実装する。認証情報がそろい次第、V1〜V7とV9を実行する。
3. 本人の準備（V0）は並行して進められる。準備が遅れても、模擬モードで進めた部分と、実接続が未確認の部分を区別して記録する。

11月9日機能固定、11月11日提出目標。11月13日05:00 JST締切。接続準備が遅れても、実接続条件を黙って完成条件から外さない。

## 今後の検証記録の書式

各節目で対象コミットSHA、作業ツリー差分、実行日時・環境・モード、コマンド、終了コード、結果、匿名化した証拠の保存先、未実行範囲を追記する。ブラウザで動作を見ただけの確認と、DB・外部APIの整合性確認を区別する。提出用の成功主張は確認できた範囲に限定する。
