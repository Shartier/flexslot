# FlexSlot — 状況と次の作業

更新日：2026-11-05（日本時間）/ 文書版：status-v0.9。

## 現在地

実装の第3段階（DESIGN 14章の3：実行器・送信待ちキュー・回復処理）を、模擬PayPalでの試験まで終えた段階。状況を「設計の再確認」と「実装・実接続」に分けて記す。

| 区分 | 状況 |
| --- | --- |
| 設計の再確認（Codex） | `design-review-1-fix2`でDR1-02の残件を含めて第1レビューを完了し、design-v0.3を基準に実装開始を可とした（REVIEWの「第1レビュー完了・実装開始可」）。2026-11-04の再確認で、design-v0.4を実行器の基準として採用可とし、指摘IP1-04（D20の照合待ちを7.5へ反映）を出した。design-v0.5でIP1-04の文書を直した。アプリの動作・実接続の合格判定ではない |
| 実装 | 14章の1（骨組み）はタグ`impl-skeleton-1`。14章の2（PayPalアダプター、障害注入付きの模擬PayPal、Vertex AIの最小接続、接続検証スクリプトV0〜V7・V9）はタグ`impl-paypal-1`と修正版`impl-paypal-1-fix1`（ブランチ`impl/paypal`）。修正版はCodexの再確認で、IP1-01〜03がクローズした。14章の3（実行器・送信待ちキュー・回復処理と障害注入の試験）はブランチ`impl/executor`、タグ`impl-executor-1`で、Codexの確認待ち（「実行器・送信待ちキュー・回復処理」の節）。14章の4以降（本格的なAIアダプター、画面、セッション、Webhook）は未着手 |
| 実接続 | PayPal SandboxでV1〜V7を、Vertex AIでV9を実行した（結果は「PayPalアダプターと接続検証」の節）。新しい注文を使ったV2〜V7の通し実行（`run-20261104-f1c97c9d`）は、Codexの再確認で合格扱いになった。実行器は模擬PayPalだけで試験し、Sandboxでは動かしていない。Webhookの実配送（V8）は未実施。画面からの一件の振替はまだ動いていない。公開・応募も未実施 |

## Codexの再確認の結果（`impl-paypal-1-fix1`、2026-11-04）

Codexの再確認の本文は、Codexの資料`outputs/codex-prep/IMPL_PAYPAL_1_FIX1_RECHECK.md`（Codexの未追跡ファイル。Claudeは変更・コミットしていない）。

| 項目 | 結果 |
| --- | --- |
| IP1-01 / P1（別の検証実行への再送防止IDの引き継ぎ） | Codex再確認済み・クローズ |
| IP1-02 / P2（受取先が未設定でも合格を表示できる） | Codex再確認済み・クローズ |
| IP1-03 / P2（Bの候補探索の起点） | Codex再確認済み・クローズ |
| V2〜V7の通し実行（`run-20261104-f1c97c9d`） | この段階のSandbox接続検証として合格扱い。Codexは記録を独立に照合した（実APIは再実行していない） |
| design-v0.4 | D18・D19・D21、6.3の8（I07）、6.1（I08）は採用可。D20は方針を採用可とし、7.5をIP1-04のとおり揃えてから実装する |
| IP1-04 / P2（D20の照合待ちが7.5の保存・再開例にない） | 対応中。design-v0.5で文書を直した（6.2のE6、7.1、7.2、7.5、AC08、15.2）。実装と、2つの停止（POSTの成功を保存した直後・照会の前、照会のタイムアウトの後）の試験は実行器の工程で行う |
| 6.1の小修正（注文作成の前にはorder IDがない） | design-v0.5の6.1で、送信前と応答後に保存する値を分けた |
| 実行器への条件 | I07の「走査対象から外す」扱いを、与信・売上確定・返金の結果不明に広げない。I08は検証スクリプトの`runs.json`の成功を証拠にせず、アプリ本体で永続保存と再開を試験する。I13：保存したハッシュを送信時に渡し、再送の直前に作り直さない |

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
| I02 | 候補の開始時刻は、許容時間の開始から15分刻みで調べる。最も早い成立枠を案にする。Bの枠は「Bの希望時間とAの元枠の重なり」の開始から数える（Codex指摘IP1-03で修正。以前はAの元枠の開始から数えていたため、14:10開始の希望を落としていた。DESIGN D21） | SPEC・DESIGNに刻みの定めがないため。設定で変えられる |
| I03 | ACTIVEの保留は「現在時刻 < 期限」の間だけ有効 | 期限ちょうどの扱いを決めるため |
| I04 | `shops`に営業時間（`business_open_min`、`business_close_min`、現地の0時からの分）を追加。`swap_cases`の元枠・移動先を、元枠・Bの枠・移動先の開始/終了の列と担当者の列にした | DESIGN 3の「主な列」にない値を、候補判定と再検査で使うため |
| I05 | 状態名：試行に、返金・取消の成功を表すSUCCEEDEDを追加。操作の状態はPREPARED・SENDING・UNKNOWN（結果不明）・PENDING・SUCCEEDED・FAILED（確定失敗）・NOT_ACCEPTED（受理されなかった）。案件はSPEC 7の表にDESIGNのPAYMENT_STARTED・A_ACCEPTED・CAPTURED・BOOKING_COMMITTEDを加え、COMPLETED・REJECTED・EXPIRED・COMPENSATEDを終端とした | DESIGNはB_CHARGEの試行の状態だけを挙げており、部分一意インデックスの対象を決めるため |
| I06 | DBで追加した制約：ワールドのモードを変更不可、債務はOPENで作成・金額と通貨は変更不可・SETTLEDは終端、債務の完了は「その債務の試行に属する、対応する種別（B_CHARGEは売上確定、取消は取消、返金は返金）の成功した操作」に限る、Webhookのイベントは同じ`event_id`のVERIFIEDの配信からだけ登録できる、金額は整数だけ（STRICTテーブル） | DESIGNの本文（3章、7.1、7.4、10章）の条件をDBでも守るため |
| I07 | 後の工程への申し送り：支払い期限で試行がEXPIREDになったとき、結果不明のままの注文作成の操作は状態が残る。実行器が再起動時に走査する対象から外す方法は、14章の3で決める | 今回は実行器を作らないため |

### 未実施の範囲

実行器・回復処理・PayPalアダプター・模擬PayPal・AI・画面・セッション・Webhookの処理は作っていない。E7の試験は手書きのトランザクションでの確認で、本番のE7のコードはまだない。同時実行（AC06）、障害注入（AC08）、時計を進める状態遷移（AC05）、権限（AC11）の試験は未実施。サンプルの日付はSPECの固定値で、デモ日に合わせた再生成は後の工程。Sandbox・Vertex AIへの接続、公開・応募は行っていない。

## PayPalアダプターと接続検証（Claude Code、2026-11-03）

対象：ブランチ`impl/paypal`（`impl-skeleton-1`から作成）、タグ`impl-paypal-1`。途中のコミット`dd72fe6`は実装の区切りで、タグはない。Windows 11、Node.js v24.22.1、npm 11.19.1。追加した依存はzod 4.6.7と@google/genai 2.30.0で、どちらも公開から2週間以上たった版に固定した。npmの`allowScripts`により、@google/genaiのpreinstall（何もしない処理）とprotobufjsのpostinstallは実行されていない。試験と実接続はこの状態で動いた。

| 項目 | 内容 |
| --- | --- |
| PayPalアダプター | `src/paypal/`：ポート（`port.ts`）、REST実装（`rest.ts`）、要求の組み立てと本文ハッシュ（`requests.ts`）、結果の分類（`classify.ts`）、zodの応答検証（`schemas.ts`）、金額変換（`money.ts`）、照合（`match.ts`）、設定（`config.ts`）。接続先は`https://api-m.sandbox.paypal.com`に固定し、それ以外は起動時に拒否する。POSTごとに`PayPal-Request-Id`と`Prefer: return=representation`を付け、1回20秒でタイムアウトさせる。トークンは期限の60秒前までキャッシュする。認証情報とトークンはプライベートフィールドに置き、ログ・エラー文に出さない |
| 模擬PayPal | `src/paypal/mock-server.ts`：同じRESTアダプターを、プロセス内のfetch互換の模擬サーバーにつないでポートを実装する。IDはすべて`MOCK-`で始まる。障害注入：応答喪失（処理後に切断）、HTTPエラー（5xx・429、処理あり／なし）、タイムアウト（処理あり／なし）、PENDING、返金FAILED、401。残額超過は422 `REFUND_AMOUNT_EXCEEDED`。同じ再送防止IDの再送は、実接続で分かった挙動（下のF4）に合わせた |
| Vertex AI | `src/ai/`：`@google/genai`を`vertexai: true`とADCで使う。`responseSchema`（JSONスキーマ）、`temperature: 0`、20秒のタイムアウト、5xxと429だけ1回再試行。出力はzodの`strictObject`で検査し、日付（今日から60日以内）・営業時間・施術ID・担当者IDを確かめる。出力に金額・承認・決済の項目はない。本格的なAIアダプター（模擬モード、回数上限、入力の出所の保存）は14章の4で作る |
| 接続検証 | `scripts/verify/`のV0〜V7・V9（`npm run verify:v0`など）。値は表示せず、出力は日時・モード・確認結果・匿名化したID（SHA-256の先頭8桁）・終了コードだけ。生のIDと再送防止IDは、Git対象外の`work/verify/`に保存して再実行に使う。V2・V3は`start`で承認URLを表示し、本人の承認後に`finish`を実行する。`finish`を再実行すると、済んだ操作は送らずに照会だけで確かめる |
| `.env.example` | 変数名：`PAYPAL_CLIENT_ID`、`PAYPAL_CLIENT_SECRET`、`PAYPAL_EXPECTED_MERCHANT_ID`、`PAYPAL_WEBHOOK_ID`（V8用、空欄）、`GOOGLE_CLOUD_PROJECT`、`GOOGLE_CLOUD_LOCATION`、`FLEXSLOT_AI_MODEL`。値はすべて空欄。`.env`は、秘密でない3項目だけを入れた枠をClaudeが作り、PayPalの3項目を本人が記入した。Gitの対象外であることは`git check-ignore`で確認した |

### 実行したコマンドと結果（模擬・単体）

| コマンド | 終了コード | 結果 |
| --- | --- | --- |
| `npm install --save-exact zod@4.6.7 @google/genai@2.30.0` | 0 | install-scriptsが未承認という警告（上記）だけ |
| `npm run check`（型チェックと`vitest run`） | 0 | 9ファイル・152件すべて成功（骨組みの80件と今回の72件） |

試験の内容（すべて模擬PayPalと偽のVertexクライアントで行い、外部へは接続しない）：

| 対象 | 確認内容 |
| --- | --- |
| Sandbox以外の拒否 | Live（`api-m.paypal.com`）、http、似た名前のホスト、パス付き、模擬のURLでの起動を拒否する。`.env`の`PAYPAL_API_BASE`がSandbox以外なら、設定の読み込みで拒否する。送信先がすべてSandboxのホストであること |
| モードの分離（AC12の一部） | Sandboxのアダプターは`MOCK-`のIDを、模擬のアダプターはそれ以外のIDを、送信前に拒否する。パスを変えうるIDも拒否する |
| ヘッダーとトークン | POSTごとに指定どおりの再送防止IDと`Prefer: return=representation`が付く。GETには再送防止IDを付けない。トークンのキャッシュと期限前の更新。401のとき新しいトークンを取得し、同じIDで1回だけ再送する |
| 再送防止IDと本文ハッシュ | ハッシュは正規化した{メソッド, パス, 本文}のSHA-256。保存したハッシュと違う本文は送らない（送信記録が増えない）。同じIDの再送では資源が増えない。応答喪失の後、同じIDの再送で回復する |
| 結果の分類（DESIGN 7.1） | 成功、PENDING、確定失敗（返金FAILED）、受理されなかった（初回の422）、結果不明（結果不明の後の4xx、「既に処理済み」、5xx・429・タイムアウト・通信断・404・不正な本文・想定外の状態）、認証エラー、未送信（トークン取得の失敗）。取消が本文なしの204なら照会で確認する |
| 模擬の障害 | 4種類の操作での応答喪失と同じIDでの回復、5xx（処理なし／あり）、タイムアウト（処理なし／あり）、PENDINGと後からの確定、返金FAILEDの後の新しい返金、残額超過と全額返金後の拒否、障害の消費順、Payments APIとOrders APIの再送の違い（F4） |
| ログ | ログ・エラー・アダプターのオブジェクトの表示に、クライアントID・シークレット・Basic認証の文字列・発行されたトークン・注文やcaptureのIDが含まれない |
| AI（偽のクライアント） | 要求に`temperature: 0`・JSON・スキーマ・「文はデータ」の指示が入る。補償額など余分な項目を含む出力、営業時間外・過去・存在しない日付・未知の施術を拒否する。JSONでない応答の扱い。5xx・429は1回だけ再試行し、400は再試行しない。タイムアウト |

### 実接続の結果（PayPal Sandbox・Vertex AI）

模擬の試験とは別の記録。2026-11-03、時刻は日本時間。3件の注文は、本人がSandboxの買い手アカウントでログインしてブラウザで承認した（ログインとパスワードの入力は本人）。IDは匿名化した表記。金額はすべてUSD。

| ID | 実行時刻（終了コード） | 結果 |
| --- | --- | --- |
| V0 | 20:43（0） | 必須の6変数があり、`.env`はGit対象外、`PAYPAL_API_BASE`はなし、ADCの資格情報ファイルはあり、`GOOGLE_APPLICATION_CREDENTIALS`は未設定。値は表示していない |
| V1 | 20:43（0） | アクセストークンを取得。`expires_in`は32400秒 |
| V2 | start 20:43（0）、finish 20:50・21:00（1）、21:09（1）、照会だけの再確認 21:12（0） | 注文（`order#c10f1c79`）の作成はHTTP 200・PAYER_ACTION_REQUIRED。承認後の売上確定はHTTP 201・COMPLETED（`capture#17b0d7f5`）。金額60.00・通貨・custom_idが一致し、注文の照会はCOMPLETEDでcaptureを含む。20:50・21:00は受取先の照合だけが不一致で、原因は`.env`の`PAYPAL_EXPECTED_MERCHANT_ID`の値の誤り（1回目は別の13文字、2回目は事業者アカウントのメールアドレス。2回目の値は、PayPalの応答にある受取先のメールアドレスと完全に一致した）。21:09は同じIDでの再送が注文の現在の状態を返して結果不明になった（F4）。本人がPayPal Merchant IDに直した後、21:12の照会だけの再確認で、captureと注文の受取先・金額が一致した（7/7） |
| V3 | start 20:43（0）、finish 21:00（1）、21:09（1）、照会だけの再確認 21:12（0） | 与信用の注文2件（b1 `order#82c7dcbc`、b2 `order#8b99b1d0`）を、承認後に与信した。HTTP 201で、与信はCREATED（`auth#8944072a`、`auth#7e041d2a`）。表現形式の応答に、与信ID・状態・`expiration_time`・金額・custom_idがある。21:00の受取先の不一致はV2と同じ設定の誤り。21:09はV2と同じくF4。21:12の再確認で受取先が一致した（4/4） |
| V4 | 21:01（1）、21:10（1） | b1の与信を、金額を明示し`final_capture`で売上確定した。HTTP 201・COMPLETED（`capture#586258d7`）。同じ再送防止IDの再送はHTTP 200で、同じcapture IDが返った。与信の照会はCAPTURED。注文の照会で売上確定を特定できた（F2）。21:01の不一致は受取先の設定の誤りだけ。設定を直した21:10の再実行では受取先が一致したが、その時点のcaptureはV7の全額返金の後でREFUNDEDだったため、「COMPLETED」の確認だけが不一致になった（想定どおり）。1回の実行で全項目が通ったわけではない |
| V5 | 21:01（0） | b2の与信を取り消した。HTTP 200で与信の表現（VOIDED）が返った（204ではなかった）。照会でもVOIDED |
| V6 | 21:01（0） | Aのcapture（V2）へ10.00を返金した。HTTP 201・COMPLETED（`refund#c5f65b9e`）。同じIDの再送はHTTP 200で、同じ返金IDが返った。返金の照会はCOMPLETED、元のcaptureの照会はPARTIALLY_REFUNDED。残額を超える50.01の返金は、HTTP 422（`REFUND_AMOUNT_EXCEEDED`）で拒否され、「受理されなかった」に分類された |
| V7 | 21:01（0） | Bのcapture（V4）へ60.00を全額返金した（金額を明示）。HTTP 201・COMPLETED（`refund#119abcdf`）。返金の照会はCOMPLETED、元のcaptureはREFUNDED |
| V9 | 19:35（シェルの環境変数）、21:01（`.env`）、いずれも0 | 下の表 |

F4の確認として、21:11に5種類の操作（注文のcapture、注文の与信2件、与信のcapture、返金、取消）を、保存してあった同じ再送防止ID・同じ本文で再送した。リポジトリ外の使い捨てのスクリプトで行い、新しい資源は作られていない。

V9（プロジェクト`kazoku-baton-20261015`、リージョン`global`）：

| モデル | A（11/10 10:00–12:00、担当の変更なし） | B（11/7 14:00–15:00、カット） | 曖昧な文（来週の午後、カラーも？） | 遅延 | トークン（1回） | 1ミリ秒のタイムアウト |
| --- | --- | --- | --- | --- | --- | --- |
| `gemini-3.5-flash-lite`（採用、思考は既定） | 一致。文中の「補償は50ドルに」は、スキーマに項目がないため出力されない | 一致 | 時間区間を作らず、施術はnull、確認質問2件 | 0.9〜1.5秒 | 約820〜860（思考トークンなし） | 2〜5ミリ秒でTIMEOUT |
| `gemini-3.8-flash`（比較、思考はLOW） | 一致 | 一致 | 同上 | 2.0〜3.2秒 | 約820〜960（Aで思考138） | 2ミリ秒でTIMEOUT |

モデルの選定：公式のモデル一覧と版の資料（2026-11-03に確認）では、`gemini-2.5-flash`は2026-10-20に提供終了。`gemini-3.5-flash-lite`は構造化出力に対応し、`global`で使え、提供終了は2027-07-21以降。審査期間（12月16日まで）を通じて使え、実呼び出しで最も速かったため採用した。タイムアウトはこちら側で待つのをやめるだけで、Vertex側では処理と課金が続く可能性がある。

### 実接続で分かった、DESIGN・資料との違い（DESIGNは変更していない）

| ID | 内容 | 影響 |
| --- | --- | --- |
| F1（U02） | 米国・USDのSandbox事業者アカウントで`intent=AUTHORIZE`が使えた。与信の表現形式の応答に、与信ID・状態・期限・金額が含まれた | 想定どおり |
| F2（U03） | 与信のcapture後、与信の照会（CAPTURED）のlinksにはcapture IDがない。注文の照会の`purchase_units[0].payments.captures[]`にはcaptureがあり、captureのlinksの`up`は与信を指す | 売上確定の結果が不明なときは、注文の照会でcaptureを特定できる（DESIGN 7.3の第1案が使える） |
| F3（U04） | 返金の応答に`seller_payable_breakdown.total_refunded_amount`（返金済みの合計）がある。captureの照会には状態（PARTIALLY_REFUNDED・REFUNDED）しかなく、返金済みの額や残額の項目はない（`seller_receivable_breakdown`はgross・net・手数料だけ）。観測した返金の状態はCOMPLETEDだけで、PENDING・FAILEDはSandboxでは再現していない（模擬だけ） | DESIGN 7.1の「元captureを照会し、返金できる残額を確かめる」は、captureの照会だけではできない。残額は「capture金額 − 返金済みの合計（FlexSlotの記録、または最新の返金の`total_refunded_amount`）」で求める必要がある。REVIEWで確認を求める |
| F4（U05） | 同じ再送防止IDの再送：数分以内は、与信のcapture・返金・注文のcaptureとも同じIDの資源が返った（初回はHTTP 201、再送は与信のcapture・返金が200、注文のcaptureが201）。資源の状態が後で変わった後（約10〜30分後）は、Payments API（与信のcapture・返金・取消）は**元の結果**（COMPLETED・VOIDED、同じID、HTTP 200）を返し、Orders API（注文の与信・capture）は**注文の現在の状態**（PARTIALLY_REFUNDED、CAPTURED、VOIDED、HTTP 201）を返した。お金は動いていない。アダプターはこれを「結果不明（想定外の状態）」に分類し、成功とはしない | 与信（ORDER_AUTHORIZE）と注文のcaptureを同じIDの再送で回復するときは、状態ではなくIDとcustom_idで特定する必要がある。アダプターは、結果不明でも応答の資源を返すようにした（I16）。45日の保持は確認していない（短時間の再送だけ）。Codexの確認：これは観測であり公式の保証ではない（公式の説明は「現在の状態を返す」）。DESIGN D19で、同定と次の操作の判定を分け、どちらの応答でも動くようにした |
| F5（7.3の表） | 注文作成（`payment_source.paypal`付き）はHTTP 201ではなく200で、PAYER_ACTION_REQUIREDと`payer-action`リンクが返った。与信の応答の与信オブジェクト、与信のcaptureの応答、注文のcaptureの応答のcaptureオブジェクトには、**受取先（payee）がない**。captureの照会と注文の照会にはある。取消は表現形式で200を返した（204は観測していない） | DESIGN 7.3の「売上確定の応答で受取先を確かめる」は、応答だけではできない。成功と判断する前に、captureか注文の照会で受取先を照合する必要がある。REVIEWで確認を求める |
| F6（U07） | Vertex AIはADCで認証でき、`global`で上記のモデルが構造化出力に対応した | 想定どおり |

### 実装で具体化した点（DESIGNに明記がなく、Codexの確認を求める点）

| ID | 内容 | 理由 |
| --- | --- | --- |
| I08 | ポートに、Aの元決済の`ORDER_CAPTURE`（注文のcapture）を加えた。DBの`OPERATION_KINDS`には加えていない | Aの元決済は債務ではなく、`payments`に記録するため（DESIGN 6.1） |
| I09 | トークンを取得できず、何も送っていない場合を`NOT_SENT`として返す | 結果不明と区別し、同じIDでそのまま再送できるようにするため |
| I10 | 初回の送信で、400・422・401・403以外の4xx（404・409など）が返ったら結果不明（照会で確定）にした。409 `PREVIOUS_REQUEST_IN_PROGRESS`は「既に処理済み」に含めた | DESIGN 7.1の表に定めがなく、安全側に倒すため |
| I11 | 「既に処理済み」とみなすPayPalのissue名の一覧（`classify.ts`）を定め、与信のDENIEDを確定失敗に含めた | 公式のエラー資料とOpenAPIのスキーマで確認した名前を使った |
| I12 | 401のときは、トークンを捨てて取得し直し、同じIDで1回だけ再送する。2回目も401・403なら認証エラー | DESIGN 7.1の「認証を直して同じ操作を再送」の具体化 |
| I13 | 本文ハッシュは、正規化した{メソッド, パス, 本文}のSHA-256。パスに対象のIDを含めるため、対象が違えばハッシュも違う。組み立て関数は実行器と共有する | DESIGN 7.5の「再送の前に本文ハッシュを確かめる」のため |
| I14 | 模擬の接続先は`https://mock-paypal.invalid`（名前解決できない）。試験専用に、模擬のIDの接頭辞を変えるオプション（`testIdPrefix`）を置いた | Sandboxモードのアダプターを、ネットワークなしで模擬に対して試験するため |
| I15 | 注文作成には`payment_source.paypal.experience_context`（`return_url`・`cancel_url`、配送なし、PAY_NOW）を使う。検証の戻り先は`http://localhost:8799/...`で、何も待ち受けていない | 承認URLを使って検証するため。画面でPayPal JS SDKのボタンを使うときの本文は、14章の5で確認する |
| I16 | 結果不明でも、2xxの本文を検証できた場合は資源を返す | F4のOrders APIの再送で、与信やcaptureのIDを失わないため |

### Codexの中間確認への対応（`impl-paypal-1-fix1`、2026-11-03）

Codexの中間確認（`impl-paypal-1`を対象。詳細はCodexの資料`outputs/codex-prep/IMPL_PAYPAL_1_REVIEW.md`）は、構成を採用し、指摘3件の修正とF3〜F5のDESIGNへの反映を求めた。V2・V3の既存の記録は「初回の操作の成立と、設定修正後の照会による補完」の限定した接続確認、V4は項目別の確認済み（1回通しの合格ではない）と判断された。既存の失敗の記録は消していない。

| 指摘 | 修正 | 試験 |
| --- | --- | --- |
| IP1-01 / P1：別の検証実行に前回の再送防止IDが引き継がれる | 検証を「実行（run）」で分け、`work/verify/runs.json`に保存する。V2・V3の`start`は、現在の実行がその段階を済ませていれば新しい実行を開く。各POSTは実行ごとに1回だけ、対象ID・本文ハッシュ・再送防止IDに結び付け、上書きしない。再開は同じ結び付きを使い、対象か本文が違えば送らずに止める（`OpBindingError`）。再送防止IDは全実行で重複させない。V6の残額超過の試験は、10.00の返金がその実行のcaptureで確認できたときだけ行う。以前の`work/verify/state.json`は消さずに残し、読まない。手順の本体を`scripts/verify/steps.ts`に移し、模擬で試験できるようにした | `tests/verify-steps.test.ts`：2回続けた実行がどちらも全項目合格で、再送防止IDを共有しない。2回目の残額超過も拒否される。同じ実行の再開ではIDが変わらず資源も増えない。別の対象に変えると送信0回で拒否 |
| IP1-02 / P2：受取先が未設定でも照合の合格を表示できる | V2・V3の`start`、V3の`finish`、V4は、`PAYPAL_EXPECTED_MERCHANT_ID`が未設定なら何も送らずにNOT_READYにする。応答に受取先がないときも不一致として扱う | 未設定（送信0回）、応答に欠落、不一致、一致の4つ |
| IP1-03 / P2：Bの候補探索の起点がI02と違い、成立する枠を落とす | Bの開始時刻を「Bの希望時間とAの元枠の重なり」の開始から15分刻みで調べる。重なりに施術が収まらないときの理由`B_WINDOW_OUTSIDE_ORIGIN_SLOT`を、以前の`B_SLOT_OUTSIDE_REQUEST_WINDOW`の代わりに置いた（DESIGN D21） | 14:10–15:10の希望が14:10で成立、複数の希望時間、元枠の終わりちょうど、元枠より広い希望、重なりが短すぎる希望 |

その他の対応：

| 項目 | 内容 |
| --- | --- |
| F3〜F5 | design-v0.4のD18（返金できる残額の管理値）、D19（同定と次の操作の判定の分離）、D20（売上確定後の照会による受取先の照合）に反映した。実装は実行器（14章の3） |
| I07・I08 | DESIGN 6.3の8（EXPIREDの試行の結果不明の操作は無条件に再送しない）と6.1（Aの元決済も操作単位で保存して回復する）に書いた |
| 模擬の再送 | 模擬PayPalの`replay`設定で、Orders APIとPayments APIのそれぞれについて、元の結果（ORIGINAL）と現在の状態（CURRENT）を選べるようにした。既定はSandboxで観測したとおり（注文はCURRENT、支払いはORIGINAL）。両方の試験を追加した |
| temperature | 公式のモデル資料（2026-11-03に確認）で、`gemini-3.5-flash-lite`はtemperature・top-K・top-Pの指定を無視すると書かれている。`temperature: 0`は送っているが、生成の制御や再現性の保証とは扱わない（DESIGN 9章、`src/ai/vertex.ts`の説明） |
| Codexの確認用スクリプト | `work/codex-review-paypal1/offline-probes.mjs`は、以前の`_lib.ts`の関数（`readState`など）を差し替える作りのため、今回の構成では読み込みの段階で動かない。変更はしていない。同じ3つの場面は、上の回帰試験で確かめている |

#### 修正後の実接続（新しい注文で通し実行）

修正版のスクリプト（コミット`19f00bf`）で、新しい注文を使ってV2〜V7を1回の実行（run）で通した。時刻は日本時間。3件の注文は本人がSandboxの買い手アカウントで承認した。

| 実行 | 時刻 | 結果 |
| --- | --- | --- |
| `run-20261103-9655a6aa` | 11-03 21:45 V0・V1・V2 start・V3 start（いずれも0） | 注文3件を作成したが、承認されないまま約25時間が過ぎ、11-04 22:54の照会では3件とも404（見つからない）になった。PayPal側で未承認の注文が失効したと考えられる（正確な失効までの時間は確かめていない）。この実行は記録を残し、以後は使っていない |
| `run-20261104-f1c97c9d` | 11-04 22:54 V2 start・V3 start（0） | 新しい注文3件（A `order#771c7d44`、b1 `order#8a56c537`、b2 `order#b1802e8e`）。3件目の承認URLを、Claudeがチャットで1文字誤って伝えたため、本人の承認が一度失敗した（PayPalの画面は「Things don't appear to be working at the moment」）。正しいURLで承認した |
| 同上 | 11-04 23:01 V2 finish（0、9/9） | 売上確定COMPLETED（`capture#04b58909`）。captureと注文の照会で、金額・通貨・custom_id・受取先が一致 |
| 同上 | 23:01 V3 finish（0、8/8） | 与信2件CREATED（`auth#02da81c1`、`auth#3cee8e19`）、表現形式に期限あり、受取先一致 |
| 同上 | 23:01 V4（0、10/10） | 売上確定COMPLETED（`capture#57314ea7`）、同じIDの再送で同じcapture ID、与信はCAPTURED、注文の照会にcaptureあり、captureの受取先一致。売上確定の状態の間に確認した |
| 同上 | 23:01 V5（0、3/3） | 取消VOIDED（照会でも確認） |
| 同上 | 23:01 V6（0、7/7） | 10.00の返金COMPLETED（`refund#7c8bca38`、`total_refunded_amount`は10.00）、同じIDの再送で同じ返金ID、返金がこの実行のAのcaptureに属すること、captureはPARTIALLY_REFUNDED。前提を確かめたうえで、50.01の返金が422 `REFUND_AMOUNT_EXCEEDED`で拒否された |
| 同上 | 23:01 V7（0、6/6） | 60.00の全額返金COMPLETED（`refund#de9d689d`）、captureはREFUNDED |
| ─ | 23:02 V0・V1（0） | 設定とトークン |

この実行では、V2〜V7のすべての確認項目が1回の実行で合格した。以前の実行（11-03）の失敗の記録は`work/verify/results.jsonl`に残している。V9は、送る内容を変えていない（`src/ai/vertex.ts`は説明の変更だけ）ため、再実行していない。

### 未実施の範囲（この段階）

実行器・送信待ちキュー・回復処理（14章の3）、本格的なAIアダプター（14章の4）、画面・セッション（14章の5）、Webhook（V8）は作っていない。Sandboxでの障害（通信断、5xx、PENDING、返金FAILED）は再現しておらず、模擬だけで試験した。再送防止IDの長期間の保持（45日）は確かめていない。PayPal JS SDKのボタンからの承認は未確認。

## 実行器・送信待ちキュー・回復処理（Claude Code、2026-11-05）

対象：ブランチ`impl/executor`（`impl-paypal-1-fix1`から作成）。文書の更新（design-v0.5、IP1-04と6.1）はコミット`5f68f90`、実装と試験はタグ`impl-executor-1`。Windows 11、Node.js v24.22.1。決済：模擬PayPalだけで、外部へは接続していない。Sandboxでの新しい実接続は行っていない。

| 項目 | 内容 |
| --- | --- |
| 実行器 | `src/executor/executor.ts`：E1（再検査と凍結。B_CHARGE・試行・注文作成の操作を1つのトランザクションで作る）、E2（注文作成）、E3・E4（承認の合図から与信。同じトランザクションで試行の有効性を確かめ、与信の操作をSENDINGで作る）、E5（売上確定前の再検査。不成立ならE-V）、E6（売上確定と照合）、E7（予約確定と処理済みマーカー。確定的に不能ならE-R）、E8（Aへの返金）、E-V、E-R、支払い期限（6.3）、店主の回復（`retryObligation`）、Aの元決済（I08） |
| 操作の駆動 | `src/executor/engine.ts`：操作の行ごとに、PREPAREDは初回送信、SENDING・UNKNOWNは回復（照会で決まるなら照会、決まらなければ同じIDで再送）、PENDINGは照会、照合待ちは照合の照会。どの段階も貸出を取ってから行い、結果は取得時の世代番号を条件に前向きにだけ書く。送信の前に、保存した固定入力から組み立てた要求のハッシュが保存済みのハッシュと一致することを確かめ、保存済みのハッシュを`expectedRequestHash`として渡す（作り直したハッシュで保存値を置き換えることはない） |
| 種類ごとの処理 | `src/executor/handlers.ts`：要求の組み立て、資源の同定（D19）、回復の判断（7.3）、照合（D20）、結果に応じた試行・債務・案件の更新（操作の結果と同じトランザクション）。Bの操作（`payment_operations`）とAの元決済（`a_payment_operations`）の2種類 |
| 同定と照合 | `src/executor/identify.ts`（純粋関数）：注文・与信・capture・返金を、ID・親子関係・custom_id・金額で同定する（配列の末尾は使わない）。次に進めるかは、同定した資源の現在の状態で別に判断する。照合は、ID・親の与信・custom_id・金額・状態・受取先がすべてそろって一致したときだけ成功（欠落も不一致） |
| 返金の残額（D18） | `src/executor/ledger.ts`：capture IDごとに、確認済みの返金をrefund IDで重複を除いて合計する。送信済みで未確定の返金、記録の欠落、refund IDの食い違い、返金超過、`total_refunded_amount`の不一致を検出する。初回送信の前にcaptureを照会し、状態と金額が記録と合うか確かめる |
| 送信待ちキュー | `processDue()`：支払い期限の処理、期限の来た操作（再送・照会・照合）、進行中の案件の前進。再送は通信エラー・タイムアウト・5xx・429のときだけ、同じIDで2・4・8・16・32・64秒後（送信は合計7回まで、`next_send_at`）。上限に達しても失敗とはせず、結果不明のまま店主の要対応にする |
| 回復処理 | `recover()`：起動時に、SENDING・UNKNOWN・PENDINGの操作と照合待ちの操作を走査し、その操作だけを照会か同じIDの再送で回復する。続けて進行中の案件を前へ進める（E7の処理済みマーカーの有無もここで見る）。新しい操作・試行は作らない。生きている貸出は奪わない |
| スキーマ | `src/db/schema.ts`をversion 2にした（次の表） |
| 試験 | `tests/`に7ファイル（試験6、補助1）を追加し、既存の2ファイルを直した。模擬PayPal（`MockPayPalServer`の`inject`・`replay`・`settle`）、応答を止める・書き換えるfetchの包み、`ManualClock`、停止点のフックを使う |

### スキーマの変更（version 2）

| 変更 | 内容 | 理由 |
| --- | --- | --- |
| `payment_operations`の列 | `request_json`（固定した入力）、`reconcile_status`（照合待ちAWAITING／照合済みMATCHED）、`reconciled_at`、`result_amount_minor`、`observed_total_refunded_minor`、`prior_unknown`（以前の送信が結果不明になったか）、`created_at`、`updated_at` | 再送で同じ本文を使うため（I13）、照合待ちの永続的な識別（IP1-04）、D18の記録、4xxの分類（DESIGN 7.1） |
| `a_payment_operations`（新しい表） | Aの元決済の注文作成（ORDER_CREATE）と注文の売上確定（ORDER_CAPTURE）を、Bの操作と同じ列で保存する。予約ごとに未確定は1つ、(予約, 種別)ごとに成功は1つ | I08。Bの債務の表へ混ぜない（Codexの条件） |
| 操作のトリガー | 状態の後退を拒否（終端から別の状態、PENDINGから送信中・結果不明、送信中・結果不明から準備）。照合の状態はAWAITING→MATCHEDの前向きだけ。保存した要求（再送防止ID・本文ハッシュ・固定した入力・対象ID）と、一度保存した外部IDは変更不可 | DESIGN 7.2をDBでも守るため。I13 |
| 試行のトリガー | 状態の後退を拒否（OPEN < ORDER_CREATED < AUTHORIZED < 終端） | DESIGN 7.2 |
| 債務の完了のトリガー | B_CHARGEとB_AUTH_VOIDは、照合済み（MATCHED）の操作でだけSETTLEDにできる | D20、IP1-04 |
| 版 | `SCHEMA_VERSION`を2にした。version 1のDBファイルは開けない（起動時に拒否）。DBファイルを使う運用はまだないため、移行処理は作っていない | ─ |

既存の試験の変更：`tests/db-schema.test.ts`（表の一覧に`a_payment_operations`を加え、版の期待値を`SCHEMA_VERSION`にした）、`tests/db-payments.test.ts`（DESIGN 7.5の保存例で、照合待ちの売上確定ではSETTLEDにできないことを確かめてから、照合済みにしてSETTLEDにする）。どちらも試験の意図は変えていない。

### 実行したコマンドと結果

| コマンド | 終了コード | 結果 |
| --- | --- | --- |
| `npm run check` | 0 | 型チェック成功、16ファイル・257件成功（前回の166件と今回の91件） |
| 変異の確認（一時的に実装を壊して実行器の試験を実行し、確認後に元へ戻した。戻したファイルは`cmp`で一致） | 1（意図した失敗） | 照合で受取先の不一致を見ない（2件失敗）、支払い期限が結果不明の与信を無視する（2件）、I07の除外を`mayWork`から外す（最初は検出できなかったため試験を強め、1件）、台帳が未確定の返金を無視する（2件）、結果の書き込みで貸出を確かめない（1件）、再送の上限を1回増やす（1件）、照合の前に案件をCAPTUREDにする（42件） |
| `pwsh -NoProfile -File tools/render-docs.ps1`と`-Check` | 0 | コミット直前に実行。結果は報告メッセージに記載 |

### 試験で確認したこと（模擬PayPal、外部へは接続していない）

| AC | 試験ファイル | 確認内容 |
| --- | --- | --- |
| 一件の流れ | `executor-flow.test.ts` | E1〜E8：凍結、注文作成（送信前はorder IDなし、保存したハッシュが固定入力と一致）、与信、売上確定、照合、予約確定（Aは移動先、Bは元枠、保留はCONVERTED）、Aへの10.00の返金。操作は4つで再送防止IDはすべて別、各POSTは1回。完了後の`processDue`・`recover`は何も送らない。E1の再検査（版・ハッシュ、Bの本人、受取先の未設定・変更、承認の欠落、保留の期限、Aの支払い未確認、Aの予約の変更、提案の期限、条件と列の食い違い、決済モードの不一致）で拒否したときは何も変えない。E5で不成立なら取消（VOIDEDを照会で確認、保留を解放、REJECTED、売上確定なし）。E7が確定的に不能なら、Bへ60.00を全額返金（Aの予約は元のまま、補償なし、COMPENSATED） |
| AC08 | `executor-recovery.test.ts` | 7.5の4つの中断点（OP1は同じIDの再送で同じ注文、OP2・OP3は照会で特定して再送しない、OP3の照合後・E7の前はE7を1回）と、E7の後の停止。IP1-04の2つの停止（POSTの成功を保存した直後・照会の前、照会のタイムアウトの後）：再起動後に照会から再開し、売上確定のPOSTは1回、売上確定の操作は1つのまま。照合の前は試行AUTHORIZED・B_CHARGE OPEN・保留FROZEN・E7の印なし。保存した照会の失敗は、キューが照会だけをやり直す。照会の結果で受取先の欠落・不一致、金額の不一致があれば何も解放せず、要対応を1回だけ記録し、後から一致したら一度だけ先へ進む（Bの予約は1件）。照合前のSETTLEDはDBが拒否する。再送の応答が元の結果でも現在の状態でも（模擬の`replay`の4通り）、注文作成の応答喪失、売上確定の応答喪失、外部で返金されたcapture（同定はするが、Bの支払いには使わず要対応）、返金の応答喪失が正しく扱われる。PENDINGのcaptureは照会を続け、COMPLETEDの後に進む。同定できない与信の応答は使わず、照会で同定する。注文の受取先が違う与信では売上確定しない。貸出が切れた後に届いた応答は採用しない（監査ログに記録）。遅れて届いたPENDINGの照会結果で、COMPLETEDの返金が戻らない。生きている貸出は別の実行器が取れない。保存した要求が変わっていれば送らずに要対応。EXPIREDの試行に残る結果不明の注文作成：order IDがなければ走査から外して監査ログに残し、直接の要求でも触れない。order IDがあれば照会だけで閉じ、注文に与信が見つかれば取消して要対応にする |
| AC10 | 同上 | 6つの停止点で順に止めて再起動しても、操作は種類ごとに1つ、PayPal側の注文・与信・capture・返金も1件ずつで、一件の振替が完了する |
| 再送 | `executor-queue.test.ts` | 5xxのとき2・4・8・16・32・64秒後に同じIDで再送し、その時刻より前には送らない。7回目の失敗の後は送らず、結果不明のまま要対応（再起動の回復でも上限を超えない）。429と、処理済みのタイムアウトも同じIDで、返金は1件。NOT_SENTは以前の結果不明を消さない。401が続いても操作を終わらせず、同じIDで再送する |
| AC09 | `executor-refund.test.ts` | 返金のPENDINGは照会だけで、その間は新しい試行を作れない。応答喪失は同じIDで回復する。確定失敗（FAILED、初回の422）の後だけ、店主の回復で新しい試行（旧試行を参照、新しいID）を作れ、補償の10.00は1回だけ。完了後の回復は拒否。B_CHARGEは回復の対象外。同じcaptureに未確定の返金がある間は別の返金を送らず、確定後に管理上の残額の範囲で送る。FlexSlotの外の返金でcaptureの状態が記録と合わなければ送らずに要対応。返金の応答の`total_refunded_amount`が記録と違えば、返金自体は確定するが矛盾として残し、以後の返金を止める。台帳の単体試験（refund IDの重複除去、未確定の一覧、食い違い、超過、captureの照会との突き合わせ） |
| AC05・AC06 | `executor-deadline.test.ts` | 与信を始めていない試行は期限で終了し（案件EXPIRED、保留RELEASED、B_CHARGE CANCELLED）、遅れた承認には与信を送らない。期限の境界（1ミリ秒前は有効、ちょうどは無効）。与信が送信中なら期限を過ぎても終了しない。期限が先に記録されれば、同時の承認は拒否。結果不明の与信は期限を過ぎても試行を終了させず、照会で回復する。受理されなかった与信の後は、承認を経て新しい与信の操作を作れる（または期限で終了できる）。E1への同時要求は1つだけ成功。ブラウザ・Webhook・キューからの同時のE4でも与信のPOSTは1回。2つの実行器が同じ案件を進めても、売上確定と返金は1回 |
| I08 | `a-payment.test.ts` | Aの元決済：送信前は固定入力とハッシュだけ（order IDなし）、order IDは応答から保存、注文のcaptureの前に対象のorder IDを保存、captureの照会が一致してから`payments`に記録する。注文作成・注文のcaptureの応答喪失や停止からの再起動でも、注文とcaptureは1件。受取先の不一致では支払い確認済みにしない。承認前のcaptureは受理されず、承認後に新しい操作で支払える。照会が落ちていれば照会をやり直し、古い読み取りでcaptureが見えなければ同じIDで再送して同定する |

### 実装で決めた点（DESIGNに明記がなく、Codexの確認を求める点）

| ID | 内容 | 理由 |
| --- | --- | --- |
| I17 | 与信の成功も照合待ちを経て、注文の照会（GET order）で照合してから試行をAUTHORIZEDにする。照合では与信ID・custom_id・金額・注文の受取先・与信の現在の状態（CREATED）を見る。DESIGN 6.2のE4と7.5の進み方3は「応答で照合」で、それより厳しい | D19（次の操作は現在の状態で判定）を、再送の応答が元の結果でも現在の状態でも同じ道筋で守るため。Sandboxでは与信ごとにGETが1回増える |
| I18 | 取消（E-V）も照合待ちを経て、与信の照会でVOIDEDを確認する。B_AUTH_VOIDは照合済みの取消でだけSETTLEDにする（DBのトリガーでも） | E-Vの「照会で取り消されたことを確認する」を、売上確定と同じ仕組みで実装するため |
| I19 | 照合待ちの永続的な識別は、操作の列`reconcile_status`（AWAITING／MATCHED）で行う。試行・債務・案件は照合済みになるまで動かさない。案件の表示用の状態は、照合待ちの間RECONCILING、結果不明の間PAYMENT_UNKNOWN、PENDINGの間PAYMENT_PENDINGにする | IP1-04（保存の方法はClaudeが決めてよい） |
| I20 | 送信を試みた後に確定しない操作は、状態UNKNOWNにし、理由を`last_error_class`に残す（通信系、`AUTH_ERROR`、`NOT_SENT:...`、`UNIDENTIFIED:...`、`UNEXPECTED_STATUS:...`）。4xxの分類に使う「以前の送信が結果不明」は`prior_unknown`で別に持ち、一度立てたら下げない。認証エラーとNOT_SENTでは立てない。NOT_SENTは送信回数に数えない | NOT_SENTが以前の結果不明を取り消さないため（I09）。認証エラーで操作を終わらせないため（I12） |
| I21 | `last_error_class`が`HOLD:`で始まる操作は、自動の処理を止めて店主の要対応にする（保存した要求とハッシュの不一致、再送の上限、照合で次へ進めない状態（与信のVOIDED、captureのREFUNDEDなど）、返金の記録の矛盾）。その債務はNEEDS_ATTENTIONにする。キューは触れず、起動時の回復だけが一度やり直す。照合の不一致のように照会を続けるものは、債務を変えずに監査ログの要対応（`ATTENTION`）に記録する（理由が変わったときだけ） | 要対応を、自動で止まったもの（債務の状態）と、照会を続けながら知らせるもの（監査ログ）に分けるため |
| I22 | 時間：再送の間隔は2秒から倍で、送信は合計7回（初回と再送6回）。照会（PENDING、照合、回復）は10秒ごと。貸出は60秒、1回の通信は20秒。再起動の後は、止まった実行器の貸出が切れてから回復する（生きている貸出は奪わない） | DESIGN 7、7.2。照会の間隔はDESIGNに定めがない |
| I23 | 回復の判断：注文がまだ承認されていない（CREATED・PAYER_ACTION_REQUIRED）うえに与信・captureがない場合、与信やAの注文のcaptureは「受理されなかった」（NOT_ACCEPTED）とし、承認の後に新しい操作（op_seq＋1、新しいID）を作れる。与信がVOIDED・EXPIREDなら売上確定の操作は確定失敗。注文が承認済みで与信がなければ同じIDで再送 | 7.3の表の具体化。PayPalが処理していないことを照会で確定できる場合を分けるため |
| I24 | 売上確定の確定失敗（FAILED・受理されなかった）では、B_CHARGEを要対応にし、与信の取消（E-V）を始めて案件をVOID_PENDING→REJECTEDにする | 不要な与信を残さないため（SPEC 7） |
| I25 | E7が確定的に不能と判断するのは、`SLOT_CONFLICT`、SQLiteの制約違反、Aの予約の変更、保留がFROZENでないとき。全体をロールバックし、別のトランザクションでB_RECOVERY_REFUND（全額）を作り、保留を解放してB_REFUND_PENDINGにする | DESIGN 8の「確定的に不能（DBの制約違反など）」の具体化 |
| I26 | E1は、`terms_json`が完全な条件スナップショット（`src/executor/terms.ts`の`CaseTerms`、受取先を含む）で、`terms_hash`と一致し、案件の列と食い違わないことを確かめる。店の受取先IDが未設定なら実行を始めない | 改ざん対策と、IP1-02（受取先は必須）を実行器にも適用するため。後の工程の案件作成はこの形で保存する |
| I27 | 返金の管理値に使うcaptureの金額は、`payments`の行、照合済みのBの売上確定、B_RECOVERY_REFUNDの債務額の順で求める。分からなければ送らずに要対応 | D18 |
| I28 | 支払い期限で試行を終えるとき、B_CHARGEはCANCELLEDにする。補償額が0なら返金の債務を作らず、E7で案件をCOMPLETEDにする | DESIGNに定めがないため |
| I29 | 6.3の5（終了した試行に与信・売上確定が見つかった場合）は、EXPIREDの試行の注文作成を照会したときに確かめる。CREATEDの与信には取消の債務、COMPLETEDのcaptureには全額返金の債務を作り、監査ログに要対応を残す。案件はEXPIREDのまま。作った操作はキューが送る | 6.3の8で照会する経路に、6.3の5の防御を置くため |

STATUS I07（申し送り）は、DESIGN 6.3の8とI29の実装で解消した。走査から外すのは「EXPIREDの試行の、order IDのない注文作成」だけで、与信・売上確定・返金の結果不明には広げていない（`src/executor/executor.ts`の`EXCLUDED_SQL`、`handlers.ts`の`mayWork`）。

### DESIGNとの違い（DESIGNは変更していない）

| 箇所 | DESIGNの記述 | 実装 |
| --- | --- | --- |
| 6.2のE4、7.5の進み方3 | 与信の応答で照合し、U1を保存してAUTHORIZEDにする | 応答で同定し、照合待ちを経て注文の照会で照合してからAUTHORIZEDにする（I17） |
| 7.1の表の「認証エラー」 | 処理されていないが、操作は終わらせない | 状態UNKNOWN・理由`AUTH_ERROR`で残し、10秒後に同じIDで再送する（I20） |

### 未実施の範囲（この段階）

- Sandboxでの実行器の実行（模擬だけで試験した）と、Sandboxでの障害の再現。
- 送信待ちキューを定期的に動かす仕組み（タイマー）と、画面・HTTPからの呼び出し（14章の5）。今は呼ぶ側が`processDue()`と`recover()`を実行する必要がある。
- Webhook（V8）を照会のきっかけにする処理。
- 店主の回復は、確定失敗の後の新しい試行だけ。`HOLD:`の解除（原因を直した後の再開）は未実装。
- 承認URLの受け渡し（`createOrder`は注文IDだけを返す）。
- D18の限界：FlexSlotの外の返金は、captureの照会の状態で分かる範囲でしか検出できない（部分返金の後に外部で返金されても状態が変わらない場合は検出できない）。MVPの前提（返金はFlexSlotからだけ）のまま。

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
| 11-03 Claude | PayPal・AIの実装（模擬） | `npm run check` | 終了コード0、152件成功。詳細は「PayPalアダプターと接続検証」 |
| 11-03 Claude＋本人 | 実接続 | V0〜V7（PayPal Sandbox、承認は本人）、V9（Vertex AI） | 「PayPalアダプターと接続検証」の実接続の表。V8は未実施 |
| 11-04 Claude | Codex指摘の修正 | `npm run check`、`render-docs.ps1 -Check` | 終了コード0、10ファイル・166件成功。文書6組PASS |
| 11-04 Claude＋本人 | 実接続（修正版） | 新しい実行でV2〜V7、V0・V1 | すべて終了コード0。「修正後の実接続」の表 |
| 11-05 Claude | 実行器（模擬） | `npm run check`、変異の確認、`render-docs.ps1 -Check` | 終了コード0、16ファイル・257件成功。変異7種をすべて検出。詳細は「実行器・送信待ちキュー・回復処理」 |
| ─ | アプリテスト | E2E・画面・実APIでの実行器・実機 | 未実行。実行器の同時実行・障害注入・再起動は模擬PayPalで実施 |

## 未確認事項

| ID | 項目 | 現時点の扱い | 確認担当・時期 |
| --- | --- | --- | --- |
| U01 | PayPal Developerの準備（Sandboxの事業者・買い手アカウント、RESTアプリの認証情報） | 解消（2026-11-03）。本人が準備し、`.env`に記入した。V0・V1で確認（値は見ていない） | ─ |
| U02 | Sandboxの事業者アカウントの国と通貨、与信（AUTHORIZE）の利用可否 | 解消（2026-11-03）。米国・USDの事業者アカウントで与信が使えた（F1） | ─ |
| U03 | 与信・注文の照会から、売上確定IDを取得できるか | 解消（2026-11-03）。注文の照会では取得できる。与信の照会のlinksでは取得できない（F2） | 実行器の回復処理で使う |
| U04 | 返金の状態の種類と、元captureの照会で返金済みの額が分かるか | 一部解消（2026-11-03）。返金の応答に返金済みの合計がある。captureの照会は状態だけで、額は分からない。観測した返金の状態はCOMPLETEDだけ（F3）。残額はFlexSlotの記録から求める管理値とする（Codexの条件付き採用、DESIGN D18） | 実行器で実装 |
| U05 | `PayPal-Request-Id`の保持期間 | RESTリクエストの資料に「最大45日」の記述あり。各APIでの保証は未確認。短時間（約30分以内）の再送では同じ資源が返ったが、Orders APIは状態の変化後に現在の状態を返す（F4）。数分以内の再送だけを前提にし、長期間後の再送には頼らない。短時間の再送試験から長期間の安全性を結論しない | 長期間の保持は未確認のまま |
| U06 | Webhookの実配送と署名検証 | 必須の接続検証（V8）。公開デモの採否とは別に、本人確認後の限定的なHTTPS受信経路で行う。承認がなければ未確認のまま残す | V8（11月7日目標、本人確認後） |
| U07 | Google Cloudのプロジェクト、課金、Vertex AI APIの有効化、リージョン、利用できるGeminiのモデル | 解消（2026-11-03）。本人がgcloudとADCを準備した。プロジェクト`kazoku-baton-20261015`・リージョン`global`・`gemini-3.5-flash-lite`でV9が合格（F6） | 公開時はサービスアカウントで再確認 |
| U08 | `node:sqlite`の安定性（Node 24） | 骨組みの試験（Node v24.22.1、SQLite 3.53.4、Vitest 5.0.5）で、トリガー・部分一意インデックス・STRICTテーブル・WAL・`isTransaction`が警告なく動作した。負荷と長時間の運用は未確認。問題があれば`better-sqlite3`に差し替える | 実行器の実装時、公開前 |
| U09 | 公開デモの置き場所と審査員のアクセス方法（Sandboxの買い手アカウントの共有方法を含む） | 未確定。第一候補はCompute Engine | 提出準備時、本人確認後 |
| U10 | OSSライセンス、Devpost登録・参加資格 | 未確定 | 本人、提出準備 |
| U11 | 現在のCodex/Claudeのモデル | モデル切替を実行・検証していない | 各アプリのモデル選択で本人確認 |

## 本人にお願いする準備（V0）

2026-11-03に完了した（V0・V1・V9で確認）。

1. **PayPal Developer**：Sandboxの事業者アカウント（米国・USD）と買い手アカウント、RESTアプリを用意し、クライアントID・シークレット・事業者アカウントのPayPal Merchant IDを、このフォルダの`.env`に自分で記入した（変数名は`.env.example`）。値はチャットに貼っていない。
2. **Google Cloud**：プロジェクト`kazoku-baton-20261015`で課金とVertex AI APIを有効にし、`gcloud auth application-default login`でADCを作った。
3. **確認しないこと**：Claudeは認証情報の値を表示・保存・送信しない。設定されたかどうかと、匿名化した照合結果だけを確認する。
4. **今後も本人が行うこと**：Sandboxの買い手アカウントでの承認（ログインとパスワードの入力）。V8の受信経路の公開の承認。

## 次に行う作業

1. Codexによる修正版の再確認は2026-11-04に完了した（「Codexの再確認の結果」の節）。
2. DESIGN 14章の3は実装し、模擬PayPalで試験した（タグ`impl-executor-1`）。Codexの中間確認（REVIEWの最後の節）を待つ。IP1-04の実装の確認と、I17〜I29の判断を求めている。
3. 次は14章の4（AIアダプターの本格版）か5（画面とセッション。キューのタイマー、承認URLの受け渡し、画面からの`onBuyerApproved`を含む）。その後、V8（本人確認後）、Sandboxでの一件の通し、第2レビューへ進む。

11月9日機能固定、11月11日提出目標。11月13日05:00 JST締切。接続準備が遅れても、実接続条件を黙って完成条件から外さない。

## 今後の検証記録の書式

各節目で対象コミットSHA、作業ツリー差分、実行日時・環境・モード、コマンド、終了コード、結果、匿名化した証拠の保存先、未実行範囲を追記する。ブラウザで動作を見ただけの確認と、DB・外部APIの整合性確認を区別する。提出用の成功主張は確認できた範囲に限定する。
