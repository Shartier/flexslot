# FlexSlot — 状況と次の作業

更新日：2026-11-03（日本時間）/ 文書版：status-v0.5。

## 現在地

実装の第1段階（DESIGN 14章の1）を終えた段階。状況を「設計の再確認」と「実装・実接続」に分けて記す。

| 区分 | 状況 |
| --- | --- |
| 設計の再確認（Codex） | `design-review-1-fix2`でDR1-02の残件を含めて第1レビューを完了し、design-v0.3を基準に実装開始を可とした（REVIEWの「第1レビュー完了・実装開始可」）。アプリの動作・実接続の合格判定ではない |
| 実装 | 14章の1（骨組み：パッケージ構成、DBスキーマとトリガー、時計、候補判定、利益計算、サンプルデータ、単体・DB試験）を実装した。ブランチ`impl/skeleton`、タグ`impl-skeleton-1`（`git rev-parse impl-skeleton-1`）。模擬モードのみで、外部へは接続していない。Codexの確認待ち。14章の2以降（PayPalアダプター、実行器、回復、AI、画面、セッション、Webhook）は未着手 |
| 実接続 | AI、PayPal Sandbox、Webhookの実配送は、いずれも未確認。公開・応募も未実施 |

## 骨組みの実装（Claude Code、2026-11-03）

対象：ブランチ`impl/skeleton`（`design-review-1-fix2`から作成）、タグ`impl-skeleton-1`。Windows 11、Node.js v24.22.1（同梱SQLite 3.53.4）、npm 11.19.1。AI：未接続、決済：未接続（模擬モードのサンプルだけ）。

| 項目 | 内容 |
| --- | --- |
| パッケージ | `package.json`（`engines`は`>=24.22.1 <25`）、`.nvmrc`（24.22.1）、`.npmrc`（`engine-strict=true`）、`package-lock.json`。開発依存はTypeScript 7.0.2、Vitest 5.0.5、@types/node 24.19.2（版を固定）。Vitestは前日公開の5.1.0を避け、2週間以上前の5.0.5にした |
| ソース | `src/clock.ts`（`Clock`、`ManualClock`）、`src/time.ts`（半開区間、店のタイムゾーンとUTCの変換）、`src/domain/candidates.ts`（候補判定、純粋関数）、`src/domain/profit.ts`（利益計算）、`src/db/schema.ts`・`src/db/database.ts`（スキーマ、`BEGIN IMMEDIATE`の補助）、`src/sample.ts`（SPEC 4のサンプル、模擬モード） |
| 試験 | `tests/`の6ファイル、80件。候補判定（AC02・C10）、利益（AC14）、時計・時刻変換、DBの制約・トリガー・ロールバック |
| 書き方 | 相対importに`.ts`拡張子を付け、型の消去だけで動く構文に限定した（`erasableSyntaxOnly`）。後の工程でNode 24がビルドなしでソースを実行できるようにするため |

### 実行したコマンドと結果

| コマンド | 終了コード | 結果 |
| --- | --- | --- |
| `npm install --save-dev --save-exact typescript@7.0.2 vitest@5.0.5 @types/node@24.19.2` | 0 | 39パッケージ、脆弱性の報告0件 |
| `npm run typecheck`（`tsc -p tsconfig.json`） | 0 | 型エラーなし |
| `npm test`（`vitest run`） | 0 | 6ファイル・80件すべて成功。`node:sqlite`の実験的機能の警告は出なかった |
| 変異の確認（一時的にスキーマを壊して`npx vitest run`、確認後に元へ戻した） | 1（意図した失敗） | 予約更新のトリガーから予約同士の検査を外すと3件、未確定操作の部分一意インデックスをSENDINGだけにすると1件が失敗した。試験が制約の欠落を検出することを確認。戻したファイルは元と一致（`cmp`） |
| `pwsh -NoProfile -File tools/render-docs.ps1`と`-Check` | コミット直前に実行 | STATUS・REVIEWのHTMLを再生成して照合する。この文書自身が生成の対象のため、結果は文書内ではなく報告メッセージに記載する |

### 試験で確認したこと

| 対象 | 確認内容 |
| --- | --- |
| AC02・C10 | SPEC 4のサンプルで、Aは2026-11-10 10:00–11:00、Bは元の14:00–15:00（UTCで保存）。Bの120分施術は14:00–15:00だけでは不成立。Aの「10:30までに終了」は不成立、「11:00までに終了」は成立。11:00開始の隣接予約は衝突せず、10:30開始の予約は衝突し、10:00–12:00に60分の空きがなくなる |
| 判定規則 | 営業時間（終了ちょうどは可）、店のタイムゾーン（UTCで解釈すると誤る例、日付をまたぐ枠、ロサンゼルスの夏時間終了の前後）、同じ担当者だけが衝突、取消済みの予約は衝突しない、ACTIVEの保留は期限の時刻から無効、FROZENは期限後も有効、RELEASED・CONVERTEDは無効、自分の案件の保留は除外、支払い未確認・移動条件なし・開始済み・過去の枠は不成立。不成立の理由を固定順で重複なく返す |
| AC14 | 利益20.50（2050セント）。機会損失0→32.50、12→20.50、32.50→0、40→−7.50。30%×40.00＝12.00。同じ予約への2回目の補償は`compensation_grants`の一意制約で拒否 |
| 枠のトリガー | 予約・保留のINSERTと、時刻・担当者・状態のUPDATEで`SLOT_CONFLICT`。隣接は許可。UPDATEでは自分自身を除く。取消済み予約の再確定、担当者の変更、解放済み保留の再有効化も検査される |
| 部分一意インデックス | A予約ごとの進行中の案件1件、債務ごとの未終了の試行1つ・成功した試行1つ、試行ごとの未確定の操作1つ（PREPARED・SENDING・UNKNOWN・PENDING）、(試行, 操作種別)ごとの成功1つ、`settled_by_operation_id`の一意 |
| DESIGN 7.5の保存例 | 注文作成・与信・売上確定の3操作が同じ試行で成功状態のまま共存し、B_CHARGEは売上確定の操作でだけSETTLEDにできる（注文作成・与信の操作では拒否） |
| ロールバック | E7と同じ順の手書きのトランザクション（保留をCONVERTED → Aを移動 → Bを挿入 → 補償の権利 → A返金の債務 → 案件の状態）で、途中の`SLOT_CONFLICT`、または補償の権利の重複で失敗させると、すべてが元に戻る |

### 実装で具体化した点（DESIGNに明記がなく、Codexの確認を求める点）

DESIGNの本文は変更していない。以下はREVIEWの確認依頼にも載せた。

| ID | 内容 | 理由 |
| --- | --- | --- |
| I01 | Bの枠は「Aの元の枠の内側」に限る（`swap_cases`のCHECKでも強制） | 予約確定まで守られているのはAの予約がある元枠だけで、元枠の外へはみ出す部分を保留する仕組みがDESIGNにないため。Bの施術がAより長い場合は不成立になる |
| I02 | 候補の開始時刻は、許容時間の開始から15分刻みで調べる。最も早い成立枠を案にする | SPEC・DESIGNに刻みの定めがないため。設定で変えられる |
| I03 | ACTIVEの保留は「現在時刻 < 期限」の間だけ有効 | 期限ちょうどの扱いを決めるため |
| I04 | `shops`に営業時間（`business_open_min`、`business_close_min`、現地の0時からの分）を追加。`swap_cases`の元枠・移動先を、元枠・Bの枠・移動先の開始/終了の列と担当者の列にした | DESIGN 3の「主な列」にない値を、候補判定と再検査で使うため |
| I05 | 状態名：試行に、返金・取消の成功を表すSUCCEEDEDを追加。操作の状態はPREPARED・SENDING・UNKNOWN（結果不明）・PENDING・SUCCEEDED・FAILED（確定失敗）・NOT_ACCEPTED（受理されなかった）。案件はSPEC 7の表にDESIGNのPAYMENT_STARTED・A_ACCEPTED・CAPTURED・BOOKING_COMMITTEDを加え、COMPLETED・REJECTED・EXPIRED・COMPENSATEDを終端とした | DESIGNはB_CHARGEの試行の状態だけを挙げており、部分一意インデックスの対象を決めるため |
| I06 | DBで追加した制約：ワールドのモードを変更不可、債務はOPENで作成・金額と通貨は変更不可・SETTLEDは終端、債務の完了は「その債務の試行に属する、対応する種別（B_CHARGEは売上確定、取消は取消、返金は返金）の成功した操作」に限る、Webhookのイベントは同じ`event_id`のVERIFIEDの配信からだけ登録できる、金額は整数だけ（STRICTテーブル） | DESIGNの本文（3章、7.1、7.4、10章）の条件をDBでも守るため |
| I07 | 後の工程への申し送り：支払い期限で試行がEXPIREDになったとき、結果不明のままの注文作成の操作は状態が残る。実行器が再起動時に走査する対象から外す方法は、14章の3で決める | 今回は実行器を作らないため |

### 未実施の範囲

実行器・回復処理・PayPalアダプター・模擬PayPal・AI・画面・セッション・Webhookの処理は作っていない。E7の試験は手書きのトランザクションでの確認で、本番のE7のコードはまだない。同時実行（AC06）、障害注入（AC08）、時計を進める状態遷移（AC05）、権限（AC11）の試験は未実施。サンプルの日付はSPECの固定値で、デモ日に合わせた再生成は後の工程。Sandbox・Vertex AIへの接続、公開・応募は行っていない。

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
| 11-03 Claude | 設計修正 | DR1-02の残件をDESIGN（design-v0.3）・STATUS・REVIEWへ反映し、HTMLを再生成して`-Check`で照合 | 結果はREVIEWの「DR1-02残件への対応」と報告メッセージに記載 |
| 11-03 Claude | 骨組みの実装 | `npm run typecheck`、`npm test`、変異の確認、文書の再生成と`-Check` | 型チェック・試験とも終了コード0、80件成功。詳細は「骨組みの実装」 |
| ─ | アプリテスト | 統合・E2E・実API・実機・同時実行・障害注入 | 未実行。単体・DBの試験だけ実施 |

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
| U08 | `node:sqlite`の安定性（Node 24） | 骨組みの試験（Node v24.22.1、SQLite 3.53.4、Vitest 5.0.5）で、トリガー・部分一意インデックス・STRICTテーブル・WAL・`isTransaction`が警告なく動作した。負荷と長時間の運用は未確認。問題があれば`better-sqlite3`に差し替える | 実行器の実装時、公開前 |
| U09 | 公開デモの置き場所と審査員のアクセス方法（Sandboxの買い手アカウントの共有方法を含む） | 未確定。第一候補はCompute Engine | 提出準備時、本人確認後 |
| U10 | OSSライセンス、Devpost登録・参加資格 | 未確定 | 本人、提出準備 |
| U11 | 現在のCodex/Claudeのモデル | モデル切替を実行・検証していない | 各アプリのモデル選択で本人確認 |

## 本人にお願いする準備（V0）

1. **PayPal Developer**：Sandboxの事業者アカウントと買い手アカウント、RESTアプリを用意し、クライアントIDとシークレットをこのフォルダの`.env`に自分で記入する（変数名は実装時に`.env.example`で示す）。値をチャットに貼らない。
2. **Google Cloud**：Vertex AIに使うプロジェクトを決め、課金とVertex AI APIを有効にする。Google Cloud CLIを導入し、`gcloud auth application-default login`でADCを作る。
3. **確認しないこと**：Claudeは認証情報の値を表示・保存・送信しない。設定されたかどうかだけを確認する。

## 次に行う作業

1. Codexによる骨組みの確認（タグ`impl-skeleton-1`、REVIEWの確認依頼、特にI01〜I07）。確認を待たずに次へ進めてよい（REVIEWの実装開始指示）。
2. DESIGN 14章の2：PayPalアダプター、障害注入付きの模擬PayPal、接続検証スクリプト（V1〜V7）。認証情報がそろい次第、Sandboxで実行する。その後、14章の3（実行器・回復）、4（AI）、5（画面とセッション）へ進む。
3. 本人の準備（V0）は並行して進められる。準備が遅れても、模擬モードで進めた部分と、実接続が未確認の部分を区別して記録する。

11月9日機能固定、11月11日提出目標。11月13日05:00 JST締切。接続準備が遅れても、実接続条件を黙って完成条件から外さない。

## 今後の検証記録の書式

各節目で対象コミットSHA、作業ツリー差分、実行日時・環境・モード、コマンド、終了コード、結果、匿名化した証拠の保存先、未実行範囲を追記する。ブラウザで動作を見ただけの確認と、DB・外部APIの整合性確認を区別する。提出用の成功主張は確認できた範囲に限定する。
