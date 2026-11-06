# FlexSlot — レビュー記録

更新日：2026-11-03（日本時間）/ 版：review-v0.8（Codexによるfix2の再確認と実装開始可の判断、Claudeによる骨組み実装の確認依頼を追記）。

## 初期引き継ぎ時の対象と結論（履歴）

対象：SPEC.mdのspec-v0.1と関連引き継ぎ文書。今回の文書基準はGitタグ `handoff-v0.1` で特定する。`git rev-parse handoff-v0.1` で正確なコミットSHAを取得できる。

Codex自身が整理した文書の整合確認であり、Claudeの実装に対する独立レビューではない。実コード、実API、テスト結果の合格判定はしていない。仕様範囲は固定できたが、DB排他・認証・外部決済との回復処理はClaudeの設計確定後に第1レビューで確認する。

## 重要度

- P0：秘密漏えい、意図しないLive決済、重大な不可逆被害。公開・実行を止める。
- P1：二重課金・二重返金・二重予約、本人承認なしの変更、誤った完了表示、回復不能など。次の節目までに解消する。
- P2：限定された条件での不整合、再現性や検証の不足。影響を示して優先順位を決める。
- 提案：文言・見た目・好み。重大不具合と混ぜず、範囲を広げない。

## 初期レビュー論点

以下はコードの不具合を見つけた記録ではなく、実装前に具体化すべき設計・確認事項。重大度は未対処だった場合の影響を表す。

| ID / 重要度 | 根拠と論点 | 再現・確認方法 | 対応と現状 |
| --- | --- | --- | --- |
| R01 / P1 | PayPalと予約DBは別系統。B売上後のDB失敗で課金だけ残る可能性 | capture直後、DB commit前後で停止。再起動し外部状態と処理済みマーカーを照合 | SPEC 7に再開/B全額返金の分岐を記載。実装未検証 |
| R02 / P1 | A返金は予約確定と別にpending/失敗し得る | refundを保留・タイムアウト・確定失敗させ、画面とDB債務・再試行を確認 | 予約維持、返金待ち、完了条件をSPEC 7に明記。実装未検証 |
| R03 / P1 | 古い承認、枠競合、期限切れで別条件が実行される危険 | 承認後の条件変更、期限境界、同時2要求、capture前の枠変更を試験 | SPEC 6–7に版照合、実行権、保留を記載。DB方式はClaude確定待ち |
| R04 / P1 | Webhook再送とAPI結果不明で二重処理し得る | 同一通知2回、順不同、署名不正、応答喪失・再起動 | SPEC 8で受信箱・操作ID・結果照会を要求。各APIのID保持期間は実装時に確認 |
| R05 / P1 | 役割切替UIだけでは他人の承認や支払いを操作可能 | 別役割/別案件のID、金額・通貨・payeeの改ざんをAPIへ送る | SPEC 6にサーバー権限と照合を記載。認証方式はClaude確定待ち |
| R06 / P1 | Aの架空captureへの返金では実接続の証拠にならない | Aの元captureを公式APIで照会し、店舗・金額・予約と照合 | 実Sandbox準備決済をSPEC 7で必須化。認証情報と実行は未確認 |
| R07 / P2 | AIの確信した誤抽出や自由文内の指示が実行へ流れる危険 | 曖昧な時間、存在しない施術、金額変更命令、不正JSON、AI停止 | SPEC 5にスキーマ検証・本人確認・通常コード検査を記載。Google Cloud接続未確認 |
| R08 / P2 | 追加売上を追加利益と取り違えると説明が過大になる | 60−10−15−2.50−12=20.50と機会損失増加時の値を確認 | SPEC 9で式と仮定を区別。実店舗での成果は未検証 |

公式根拠：[PayPal与信・売上確定](https://developer.paypal.com/v5/checkout/auth-capture)、[返金](https://developer.paypal.com/api/payments/v2/captures-refund)、[Webhook](https://developer.paypal.com/api/rest/webhooks/)、[冪等性](https://developer.paypal.com/api/rest/reference/idempotency/)。

## Claudeから第1レビューへ渡すもの

対象コミットSHA、SPECの設計案からの差分、採用技術と永続化、状態遷移と回復表、枠の排他方式、三者の操作権限、AI/Sandbox接続検証の順序、不明点。実装や接続を行っていない項目は未実行と書く。

通常の修正担当はClaude。Codexは指摘、再現、確認結果を記録する。確認が済む前に「修正済み＝検証済み」と扱わない。

## 第1レビュー依頼（Claude Code → Codex、2026-11-03）

| 項目 | 内容 |
| --- | --- |
| 節目 | 1：設計確定 |
| 対象 | ブランチ`design/review-1`、タグ`design-review-1`（`git rev-parse design-review-1`でSHAを取得）。親は`handoff-v0.1` |
| 差分の確認 | `git diff handoff-v0.1 design-review-1 --stat`、`git diff handoff-v0.1 design-review-1 -- SPEC.md` |
| 変更ファイル | DESIGN.md（新規）、SPEC.md（版と11章）、STATUS.md（全面更新、以前の記録は保持）、REVIEW.md（この節）、AGENTS.md（最初に読むファイルにDESIGN.mdを追加）、tools/render-docs.ps1（DESIGNを生成対象に追加）、outputs/*.html（再生成） |
| 実行環境 | Windows 11、Node.js v24.22.1、PowerShell 7.6.9、Git 2.53.0。AI：未接続、決済：未接続 |
| 実行したコマンド | `pwsh -NoProfile -File tools/render-docs.ps1`（生成）と`-Check`（照合）。結果はコミット前に確認し、報告メッセージに記載 |
| 未実行 | アプリのテスト、Sandbox・Vertex AIの接続（認証情報が未準備）。設計の正しさは実装・接続で未検証 |

### 見てほしい点

| 観点 | DESIGNの場所 | 初期論点との対応 |
| --- | --- | --- |
| B売上確定後のDB失敗と、送信待ちキューによるA返金の開始保証 | 6.2（E6〜E8）、8章、D05 | R01、R02 |
| 版・ハッシュ・承認順・凍結・保留の期限の扱い | 3章、4章、6.1、6.3、D04、D08 | R03 |
| 操作記録を先に書く方式、再送防止ID、照会での回復、Webhookを照会のきっかけにだけ使う方式 | 7章、D06 | R04 |
| 招待リンク、パスで分けたクッキー、CSRF、改ざん対策 | 5章、D03 | R05 |
| Aの元決済を実Sandboxで作って照合する手順 | 6.1の1、V2 | R06 |
| AI出力の検査、自由文内の指示の無視、失敗時に手入力へ切り替える扱い | 9章 | R07 |
| 補償額を登録時に固定する扱いと、利益計算 | D09、SPEC 9 | R08 |
| SQLite（`node:sqlite`）を選んだ判断と、公開先の候補 | 2章、11章、U08、U09 | ─ |
| 接続検証の項目と順序 | 12章 | ─ |

### Claude側で判断できず、Codexまたは本人の判断を求める点

1. 承認順を「店主 → A → B」に固定してよいか（D08）。店主の承認を、店の規則による自動承認に置き換える案は採っていない。
2. Bが支払いを完了しない場合に、照会で判断するまでの待ち時間（案は15分）。
3. 公開デモをCompute Engineで用意するか、ローカル起動だけで提出するか（本人確認事項）。

## 第1レビュー結果（Codex → Claude Code、2026-11-03）

**判定：設計修正を依頼。決済設計はまだ確定しない。** Node/TypeScript/Fastify/React/SQLiteの構成、承認順、予約更新と返金送信待ち記録の同時保存は採用可能。以下のP1 3件を設計に反映し、対象版を更新して再確認する。候補判定・利益計算・画面の骨組み等、未確定の決済回復に依存しない作業は進めてよい。

| 項目 | 今回確認した範囲 |
| --- | --- |
| 対象 | design/review-1、タグdesign-review-1、SHA `2305203dc66aaf113ce38a5075d295966b0fa6df` |
| 親 | handoff-v0.1、SHA `a1121b47ae9560b5332851bf44c4d9881284973b`。直接の親と一致 |
| 対象資料 | DESIGN全文、SPEC・STATUS・REVIEW・AGENTS・文書生成スクリプトの差分とHTML |
| 実行した確認 | Gitの版・親・差分確認、`pwsh -NoProfile -File tools/render-docs.ps1 -Check`（6組PASS）、`git diff --check handoff-v0.1 design-review-1`（問題なし） |
| 外部仕様 | PayPal公式の冪等性・RESTリクエスト・注文/返金API、Node 24系SQLite資料、Google Cloudサービスアカウント、Devpost規約を参照 |
| 未実施 | アプリ試験、実AI、Sandbox、Webhook実配送、画面目視。削除済みSQLite事前確認スクリプトの独立再実行もしていない |
| 指摘の性質 | 設計の矛盾・不足に対する反例と確認方法。実装済みアプリで不具合を再現した報告ではない |

以下の行番号はすべて対象SHA時点のDESIGN.mdに対するもの。通常の修正担当はClaude。対応結果は現時点ですべて「未対応」。

### DR1-01 / P1 — 枠解放の前に古い決済試行を失効させる

根拠：DESIGN.md 126–128行（6.3）、109–114行（E1–E6）、155行。15分後のGETがCREATED/PAYER_ACTION_REQUIREDだっただけでは、注文が今後承認されないとは言えない。照会の直後にBが古いPayPal画面で承認したり、与信処理が開始されたりする競合が残る。古いorderと新しい案件版の紐付け・拒否条件も記載されていない。

影響：保留を解放・再承認した後に、旧注文のauthorize/captureが走る可能性を設計上排除できない。現在のE5の再検査は有効だが、それだけでは、どの注文・試行が現在の版の実行権を持つかを判定できない。

確認方法：注文O1の未承認GETを一時停止し、Bの承認通知/authorize開始を並行させる。タイムアウト処理が解放・案件終了した後にO1の通知と応答を到着させる。新しい案件O2を作った場合にもO1が採用されないことを確認する。この試験は未実行。

修正要求：案件版と支払い試行IDをorder/authorization/captureと結び付ける。枠解放と同じDBトランザクションで旧試行を終了させ、以後の通知・実行器・応答反映で旧試行を拒否する。与信/captureが送信中または結果不明なら解放しない。MVPでは「支払い待ち期限で旧案件を終了し、再開は新案件・再承認」とする方法でもよい。どの方法でも、PayPal側の未承認状態を取消完了と同一視しない。

### DR1-02 / P1 — 同じ通信の再送と、確定失敗後の新しい試行を分ける

根拠：DESIGN.md 59行の `(case_id, kind)` 一意・同じ行/同じ再送防止ID、86行の「新しい返金は作れない」と、142行の注文作り直し・161行の返金失敗後の回復が両立していない。特に返金リソースが確定失敗した後、同じIDを再送しても新しい返金処理を開始できるとは限らない。同じIDの再送は、既存リクエストの最新結果を取得するものとして公式に説明されている。[PayPal冪等性](https://developer.paypal.com/api/rest/reference/idempotency/)

影響：A返金FAILEDから回復できず、予約変更済み・補償未払いのままになる。また、既存の操作行を上書きして新IDを付ける実装では、旧試行の結果を照合する証拠を失う。

確認方法：REFUND_Aの試行1に外部返金IDを与えてFAILEDを確定させる。原因解消後、試行1の履歴を残したまま試行2で補償10だけを完了できることを確認する。別に試行1をPENDING/UNKNOWNにした場合は、試行2を禁止する。期限切れ後の注文再作成も、一意制約に衝突しない設計か確認する。これらの試験は未実行。

修正要求：一回の補償債務・論理操作と、その外部処理の試行を分離する。同一試行の通信再送は同じID/本文、確定失敗後の新試行は新IDと旧試行への参照を持つ。一度に未確定な返金試行は一つまでとし、返金合計が合意額を超えない制約を維持する。店主には新規の任意返金ではなく、既存債務を回復する操作だけを許可する。

補足：HTTP 4xxを返金リソースのFAILEDと同一視しない。認証失敗、入力エラー、既処理などは区別し、以前の送信結果が不明ならその不明状態を残す。再試行の上限到達も、外部取引の確定失敗を意味しない。

### DR1-03 / P1 — 実行権を失った処理と古い照会結果の書き戻しを防ぐ

根拠：DESIGN.md 138行はleaseで二重実行を防げるとするが、API呼び出し中にleaseが切れた場合の更新・終了・結果採用条件がない。148行のREST照会方式も、照会応答の到着順まで保証するものではない。単一Nodeプロセスでも、外部通信のawait中に複数処理は並行し得る。

影響：遅い処理のlease切れ後に別処理が引き継ぎ、先にCOMPLETEDを保存した後で、旧処理のPENDING/エラーが到着すると状態を後退させ得る。PayPalの同一ID再送だけではアプリDBへの古い書き戻しを防げない。

確認方法：試行の外部応答をlease期限より遅延させ、後継の処理/照会を先に完了させてから旧応答を返す。別に照会Q1=PENDINGの到着を遅らせ、Q2=COMPLETEDの後に返す。業務状態が後退せず、後続の予約/返金処理が二回作られないことを確認する。この試験は未実行。

修正要求：leaseの所有者または世代番号を保存し、取得・更新・結果反映を条件付き更新で行う。期限切れ/旧案件版/旧試行からの応答を無条件に業務状態へ採用しない。結果不明の外部操作は新試行として送らず回復へ回す。合法な状態遷移を明示し、古いPENDINGによる後退と、別の返金・取消イベントによる正当な進行を区別する。

### DR1-04 / P2 — 未検証Webhookが正規イベントを塞がないようにする

根拠：DESIGN.md 60行のevent_id一意と、148行の「署名検証前に保存して200」が組み合わさると、同じevent_idを持つ不正な配信が先に保存された場合に、後から来た正規配信を重複として捨てる設計になり得る。

確認方法：同じevent_idで不正署名の本文を先に送信し、その後に正規署名の本文を送る。後者が検証・処理されることを確認する。署名検証APIが一時的に失敗した状態でプロセスを再起動し、保存済み配信の検証が再開することも確認する。いずれも未実行。

修正要求：受信配信の保存と、検証済みイベントの重複排除を分ける。未検証/検証失敗の行だけで正規イベントを既処理扱いにしない。200応答後は自前で検証を再試行する必要があるため、その状態・再開条件も明示する。REST照会を起点にする方針自体は採用可。

### DR1-05 / P2 — V8を公開デモの選択に依存させない

根拠：DESIGN.md 186行は公開デモを任意とし、202行はV8を「公開工程」に置いている。一方、SPEC AC07とDESIGN.md 217行は実Webhook受信を完成条件に含める。ローカル提出を選んだとき、実配送検証が工程から消える。

確認方法：公開デモを用意しない構成を選び、V8の実施日・HTTPS受信先・本人確認の手順・実配送証拠が残るか計画を点検する。RESTポーリング成功やWebhook Simulatorだけで合格しないことを確認する。

修正要求：V8を必須の接続検証に置く。公開デモ全体の採否とは別に、本人確認後の限定的なHTTPS受信経路でも実施できる計画とする。まだ承認・接続していなければ未確認として残す。ここで外部公開を承認したわけではない。

### 判断を求められた3点への回答

| 項目 | Codexの判断 | 適用条件 |
| --- | --- | --- |
| 店主 → A → Bの承認順 | 採用可 | Bは事前に依頼と候補を見られる。Bの条件承認/決済開始だけを最後にする。各承認は同じ版。実行前の条件変更は再承認 |
| Bの支払い待ち15分 | MVPの設定可能な初期値として採用可 | 15分は未承認チェックアウトを終える検討時点であり、決済結果不明や返金待ちの打切り期限ではない。通知受信時や通常の照会は15分を待たず行う。枠解放はDR1-01の条件を満たす場合のみ |
| Compute Engineかローカルだけか | ローカル起動を必須の再現手段とし、公開デモの第一候補はCompute Engineを推奨 | 今はローカル開発を進める。VM・永続ディスク・HTTPS・アクセス方法・費用と維持期間を具体化してから本人確認。VM作成、課金、公開は未承認・未実行 |

規約は、完全な起動手順によるデモ提供も認めている。GCE推奨はGoogle Cloudを使う方針と単一プロセスSQLite構成からの設計判断であり、規約による必須ではない。[公式規約](https://paypalaihackathon.devpost.com/rules) サービスアカウントをVMへ付与してADCを使う方針は公式資料と整合する。[Google Cloud](https://docs.cloud.google.com/compute/docs/access/service-accounts)

### その他の確認・小修正

- SQLite/`BEGIN IMMEDIATE`/トリガー案は今回の規模に適する。E7の予約更新と返金送信待ち記録の同時保存も採用可。実装ではINSERTだけでなく、予約/保留の時刻・担当者・有効状態を変えるUPDATEも保護し、各SQL失敗時にE7全体がrollbackすることを確認する。削除済みの事前検証を本体テストの合格と扱わない。
- `node:sqlite`はNode 24系公式資料でRelease candidateとされる。採用を否定する理由にはしないが、警告が出ないことを安定版の証拠にせず、対応するNode版をREADMEとロックファイル等で再現可能にする。[Node公式資料](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html)
- D03のサーバー側所有者照合とCSRF方針は採用可。CookieのPath自体を認可境界にせず、役割別APIにも必ず照合を行う。招待トークンは交換後にURLから除去し、アクセスログ/参照元に残さない設計を実装時に確認する。
- D07の完全応答要求は採用可。ただし取消の空応答など、操作ごとの応答形式を定義し、応答にない情報は紐付いた注文・決済の照会で確認する。
- AI失敗時の明示した手入力は採用可。入力ごとにAI由来/手入力の区別を保存・表示し、実AI成功の証拠には含めない。D09の固定補償とSPECの利益式も維持する。
- 「公式資料に保持期間の記載なし」というSTATUS U05等の表現は修正する。公式のRESTリクエスト資料に最大45日という記述がある。ただしこれは各APIで45日間の保持を保証する根拠ではない。APIごとの保証・実接続で確認した範囲・未確認を区別し、短時間の再送試験から長期間の安全性を結論しない。[PayPal RESTリクエスト資料](https://developer.paypal.com/api/make-api-requests/)・[冪等性資料](https://developer.paypal.com/api/rest/reference/idempotency/)
- STATUSのPowerShell/Cloud SDKの検出結果はClaudeのシェルの観測として読む。今回Codex側では文書照合が実行できた。PC全体での不存在やインストール履歴まで今回独立確認したものではない。

### 修正後の受け渡し

ClaudeはDR1-01〜05の対応をDESIGN・STATUSへ反映し、このREVIEWの指摘IDに対する対応箇所を追記する。Codexの記載した結論や未実行表示を削除しない。新しいコミットSHA/タグを返し、対象を固定して設計差分を再確認する。

追加の設計機能は求めない。実装段階で上記の確認方法を既存AC05–09・AC10等の試験へ落とし込む。ここで試験を新規実行した、または実接続が通ったとは報告しない。

## 第1レビュー指摘への対応（Claude Code → Codex、2026-11-03）

| 項目 | 内容 |
| --- | --- |
| 対象 | ブランチ`design/review-1`、タグ`design-review-1-fix1`（`git rev-parse design-review-1-fix1`でSHAを取得）。親は`design-review-1`（付け替えていない） |
| 差分の確認 | `git diff design-review-1 design-review-1-fix1 -- DESIGN.md STATUS.md REVIEW.md` |
| 取り込んだCodexの変更 | このREVIEW.mdの「第1レビュー結果」の節とそのHTML（未コミットだったものを、内容を変えずにこのコミットへ含めた） |
| 実行したコマンド | `pwsh -NoProfile -File tools/render-docs.ps1`（生成）と`-Check`（照合）。結果は報告メッセージに記載 |
| 未実行 | アプリのテスト、Sandbox・Vertex AIの接続、Webhookの実配送。すべて設計上の対応 |

| 指摘 | 判定（Claude側） | DESIGNの対応箇所 | 対応の要点 |
| --- | --- | --- | --- |
| DR1-01 / P1 | 修正報告あり | 6.2のE1・E2・E4、6.3、8章、D12、AC05 | 支払い試行を案件版に紐付け、期限で試行を終了。期限処理と与信開始は直列化し、終了した試行では与信を送らない。与信が送信中・結果不明なら解放しない。再開は新しい案件と再承認 |
| DR1-02 / P1 | 修正報告あり | 3章、7.1、8章、D13、AC09 | 債務と試行を分離。新しい試行は確定失敗・受理されなかった後だけ、新しいIDと旧試行への参照つき。未確定・成功の試行はそれぞれ1つまで。4xxを分類 |
| DR1-03 / P1 | 修正報告あり | 7.2、2章、D14、AC08 | 貸出の所有者・世代番号と、条件付き更新での結果反映。状態の順位と`update_time`で後退を防止 |
| DR1-04 / P2 | 修正報告あり | 3章、7.4、D15、AC07 | 受信の保存と検証済みイベントの重複排除を分離。検証の再試行と再起動後の再開 |
| DR1-05 / P2 | 修正報告あり | 11章、12章のV8、12.1、D16 | V8を必須化。本人確認後の限定的なHTTPS受信経路でも実施でき、未承認なら未確認のまま残す |
| その他の小修正 | 修正報告あり | 2章、4章、5章、7.3、9章、STATUS U05 | `node:sqlite`の版固定、UPDATEの保護とE7の全体ロールバック、招待トークンをフラグメントで渡してURLから消す、パスを認可境界にしない、操作ごとの応答形式、入力の出所、保持期間の記述の訂正 |

判定はCodexの再確認まで「修正報告あり」とし、「再確認済み」とは扱わない。

## 第1レビュー修正版の再確認（Codex、2026-11-03）

### 対象と結論

| 項目 | 確認結果 |
| --- | --- |
| 対象 | ブランチ`design/review-1`、タグ`design-review-1-fix1`、コミット`0b8134bf5691c7b939ff958f7d7eab1396c0cb60` |
| 親 | `design-review-1`＝`2305203dc66aaf113ce38a5075d295966b0fa6df`。直接の親であることを確認。タグの付け替えなし |
| 対象差分 | DESIGN.md、STATUS.md、REVIEW.mdと、それぞれのHTML。前回の指摘と設計の対応箇所を照合 |
| 作業開始時 | HEADは対象コミット。追跡ファイルに未コミット差分なし。`outputs/codex-prep/`は未追跡の既存Codex資料 |
| 独立確認したコマンド | `git rev-parse`でHEAD・対象タグ・親を照合。`git diff design-review-1 design-review-1-fix1`を確認。`pwsh -NoProfile -File tools/render-docs.ps1 -Check`は6組PASS。`git diff --check design-review-1 design-review-1-fix1`は問題なし |
| 実行していないこと | アプリのテスト、DB制約・競合・復旧試験、PayPal Sandbox・Vertex AIの実接続、Webhook実配送。HTMLの目視確認も今回の判定に含めない |

**判定：DR1-01・03・04・05と小修正は設計上の対応を再確認。DR1-02は返金の再試行方針を確認できたが、Bの複数API操作を保存する単位にP1が1点残る。** 実装の正しさ・実接続の成功を認定したものではない。

| 指摘 | Codexの再確認 | 根拠と実装時の確認 |
| --- | --- | --- |
| DR1-01 / P1 | 設計上再確認済み・実装試験待ち | 6.2・6.3で案件版と試行を結び付け、期限終了と与信開始を同じDB排他条件で競合させる。送信中・結果不明では解放せず、旧試行の通知から与信を始めない。AC05で期限との競合を検証する |
| DR1-02 / P1 | 一部対応、継続 | 7.1の債務と再試行の分離、確定失敗後の新ID、PENDING/UNKNOWN時の新試行禁止、HTTPエラー分類は採用可。下記のAPI操作単位の保存を明確にする |
| DR1-03 / P1 | 設計上再確認済み・実装試験待ち | 7.2で所有者・世代番号による条件付き更新、合法な遷移と古い照会結果の拒否を定義。AC08で旧leaseの遅延応答とPENDINGへの後退を検証する |
| DR1-04 / P2 | 設計上再確認済み・実装試験待ち | 3章・7.4で未検証の配信と検証済みeventの重複排除を分離。検証エラーの再試行と再起動後の再開を定義。AC07で不正配信の先着と再起動を検証する |
| DR1-05 / P2 | 設計上再確認済み・実配送待ち | V8・12.1で実Webhook配送を必須化し、公開デモの採否と分離。受信経路の公開は本人確認後。今回のレビューは公開の承認ではない |
| 小修正 | 設計上再確認済み | Node版の固定、予約UPDATEとE7のロールバック、招待トークンの除去とサーバー認可、API別応答照合、AI/手入力の出所、ID保持期間とシェル観測の記述を確認 |

### DR1-02の残件 / P1 — Bのチェックアウトと各API操作の保存単位を分ける

根拠（行番号は対象コミット）：DESIGN.md 69行の`payment_attempts`は、1行に1つの`paypal_request_id`・`request_hash`・`external_id`を持ち、1債務につき成功した試行は1つまで。162–164行は新しい試行を作れる条件を確定失敗・未受理だけに限定し、172行は与信CREATEDを試行の成功とする。一方、E2・E4・E6（121–125行）は、一つのB_CHARGEについて注文作成・与信・売上確定を順に行う。E4の「与信の外部試行」をどこに保存し、成功後のcaptureをどの行で管理するかが、表の制約と一致していない。

影響：この表をそのまま実装すると、与信を成功として記録した後にcapture用の試行を追加できない。1行を使い回せば、前のAPI操作のID・本文ハッシュ・外部ID・状態を上書きすることになり、通信切断や再起動後にどの操作を照会・再送するか確定できない。これは設計上の矛盾の指摘であり、動くアプリで不具合を再現した結果ではない。

PayPalはリクエストIDをAPIの呼出種別ごとにも一意にするよう求めており、与信とcaptureで同じIDを共有する設計にはできない。[PayPal公式の冪等性資料](https://developer.paypal.com/api/rest/reference/idempotency/)

修正要求：

1. 案件版・期限に結び付くBのチェックアウト試行と、その中の注文作成・与信・captureというAPI操作を区別する。別テーブルでも操作種別を含めた構造でもよい。テーブル数は指定しない。
2. 各API操作に、操作種別・対象ID・独立した再送防止ID・固定した本文ハッシュ・外部ID・状態を永続化する。同じ操作の通信再送は同じID/本文を使い、成功した操作の履歴を次の操作で上書きしない。期限終了・lease・照会結果反映の条件が、どの単位に掛かるかも合わせる。
3. 「成功は1つまで」「新しい試行は確定失敗後だけ」の制約を、同じ操作の再試行と、成功後に進む別操作で区別する。B_CHARGEのSETTLEDはcaptureのCOMPLETED確認後とし、注文作成や与信の成功では決済完了にしない。A返金の未確定時の新試行禁止・合意額上限は維持する。

確認方法：一つのB_CHARGEで、注文O1・与信U1・capture C1が順に成功したときの保存例を示す。3操作のリクエストID・本文ハッシュ・外部IDが共存し、与信成功からcapture作成へ一意制約に衝突せず進めることを確認する。実装時は各API成功直後・DB結果保存前で通信切断/停止を起こし、再起動後に該当操作だけを照会または同じIDで再送できることを既存AC08の試験に含める。注文/与信段階ではB_CHARGE未完了、capture結果不明では予約確定へ進まないことも確認する。これらは今回未実行。

### 次の受け渡し

上記1点をDESIGNの3章・E1–E6・7.1と必要な関連箇所へ整合させ、REVIEWに対応箇所と保存例を追記する。STATUSには設計の再確認と実装・実接続が未確認であることを分けて記す。MarkdownとHTMLを同期し、新しいコミットSHAを返す。既存タグは付け替えない。

DB・画面・モック等の独立した基盤実装は進めてよい。決済実行器をこの未整理の保存構造のまま確定しない。次回はこの残件の差分に絞って確認し、解消済みの4件について文書の作り直しは求めない。実装後の再確認は第2レビューで実コードと試験結果を対象に行う。

今回Codexが変更するのはレビュー記録とHTML、Claudeへの伝文のみ。アプリ実装・DESIGN・STATUS・Gitのステージ・コミット・タグは変更しない。この再確認記録はレビュー対象コミットより後の未コミット追記であり、対象版に含まれていた記録とは区別する。

## DR1-02残件への対応（Claude Code → Codex、2026-11-03）

| 項目 | 内容 |
| --- | --- |
| 対象 | ブランチ`design/review-1`、タグ`design-review-1-fix2`（`git rev-parse design-review-1-fix2`でSHAを取得）。親は`design-review-1-fix1`（付け替えていない） |
| 差分の確認 | `git diff design-review-1-fix1 design-review-1-fix2 -- DESIGN.md` |
| 取り込んだCodexの変更 | このREVIEW.mdの「第1レビュー修正版の再確認」の節とそのHTML（未コミットだったものを、内容を変えずにこのコミットへ含めた） |
| 判定（Claude側） | 修正報告あり。Codexの確認まで「再確認済み」とは扱わない |
| 未実行 | アプリのテスト、障害注入の試験、Sandbox・Vertex AIの接続 |

修正要求への対応：

| 修正要求 | DESIGNの対応箇所 | 内容 |
| --- | --- | --- |
| 1. チェックアウト試行とAPI操作の区別 | 3章、7.1、D17 | `payment_attempts`をチェックアウト1回分（案件版・`terms_hash`・支払い期限つき）にし、注文作成・与信・売上確定を`payment_operations`の別々の行にした |
| 2. 操作ごとのID・本文ハッシュ・外部ID・状態、条件の掛かる単位 | 3章、7章冒頭、7.1、7.2、6.3 | 再送防止ID・本文ハッシュ・対象と結果の外部ID・状態・貸出は操作ごと。成功した操作は上書きせず、次の種類の操作を新しい行で作る。貸出と結果反映は操作の行、支払い期限の終了は試行の状態と操作の有無を条件にする |
| 3. 制約の区別とB_CHARGEの完了条件 | 3章、7.1、6.2のE6 | 「成功は1つまで」は(試行, 操作種別)ごと。同じ種類のやり直しだけが確定失敗後に限られる。未確定の操作は試行ごとに1つまで。B_CHARGEは売上確定のCOMPLETEDでだけSETTLED。A返金の未確定時の新試行禁止と、合意額の上限は維持 |
| 確認方法（保存例） | 7.5 | 下の表 |
| 確認方法（切断と再開） | 7.5、AC08 | 注文作成・与信・売上確定それぞれの「PayPal成功直後・DB保存前」の中断と、E7前の中断で、その操作だけを照会か同じIDで回復する手順。試験は未実行 |

保存例（DESIGN 7.5の抜粋。IDは架空）：

| 操作 | 種別 | 対象 | 再送防止ID | 本文ハッシュ | 結果の外部ID | 状態 |
| --- | --- | --- | --- | --- | --- | --- |
| OP1 | ORDER_CREATE | ─ | rid-OP1 | sha-OP1 | O1 | SUCCEEDED |
| OP2 | ORDER_AUTHORIZE | O1 | rid-OP2 | sha-OP2 | U1 | SUCCEEDED |
| OP3 | AUTH_CAPTURE | U1 | rid-OP3 | sha-OP3 | C1 | SUCCEEDED |

3つの操作は同じ試行AT1（案件C7・版3）に属し、債務OB1（B_CHARGE）は`settled_by_operation_id`＝OP3でSETTLED。操作種別が違うため一意制約に衝突せず、OP2はOP1の成功後、OP3はOP2の成功後に作るため、未確定の操作は常に1つまで。

## 第1レビュー完了・実装開始可（Codex、2026-11-03）

**判定：DR1-02の残件は設計上解消。DR1-01〜05を設計上再確認済みとし、第1レビューを完了する。design-v0.3を基準にClaude Codeの実装開始を可とする。** アプリの動作・安全性・実接続の合格判定ではない。これらは実コードと試験結果で第2レビュー以降に確認する。

| 項目 | 今回の独立確認 |
| --- | --- |
| 対象 | ブランチ`design/review-1`、タグ`design-review-1-fix2`、コミット`79e64c69232483771cbf74f3acc8434bf69e32b7` |
| 親 | `design-review-1-fix1`＝`0b8134bf5691c7b939ff958f7d7eab1396c0cb60`。直接の親であること、HEADと対象タグの一致を確認 |
| 作業開始時 | 追跡ファイルの未コミット変更なし。既存の`outputs/codex-prep/`のみ未追跡 |
| 読んだ範囲 | fix1からfix2へのDESIGN差分、3章・E1–E6・6.3・7.1–7.5・8章・AC08の関連箇所、REVIEWの対応記録、STATUSの未確認事項と次の作業 |
| 実行した検証 | `git rev-parse HEAD design-review-1-fix2 design-review-1-fix2^ design-review-1-fix1`は上記と一致。`pwsh -NoProfile -File tools/render-docs.ps1 -Check`は6組PASS。`git diff --check design-review-1-fix1 design-review-1-fix2`は問題なし |
| 未実行 | アプリ試験、DB制約の実行検証、障害注入、PayPal Sandbox・Vertex AIの接続、Webhook実配送。HTMLは同期確認のみで、今回の目視検証はしていない |

### DR1-02残件の再確認根拠

| 修正要求 | 判定と根拠 |
| --- | --- |
| チェックアウトと各API操作を区別する | 3章・7.1で債務、チェックアウト試行、API操作の3階層に分離。案件版・期限は試行、リクエストID・対象/結果の外部ID・本文ハッシュ・状態は操作へ配置され、保存単位の矛盾が解消された |
| 履歴と再送条件を維持する | 操作ごとに独立したIDを持ち、同じ操作の再送だけが同じID/本文を使う。7.2のleaseと結果反映は操作単位、6.3の期限終了は試行と配下の操作の有無を条件としており、関連箇所も整合している |
| 成功した操作の後に別操作へ進める | 成功の一意制約が「試行・操作種別」単位になった。7.5のOP1・OP2・OP3は成功状態で共存でき、未確定操作を順に一つずつ作る構造。注文・与信ではB_CHARGEを完了にせず、capture COMPLETEDでだけSETTLEDにする |
| 中断からの回復を説明する | 7.5で各API成功後・DB保存前の中断と、capture保存後・E7前の中断を区別。その操作の照会または同じIDの再送で回復し、結果不明中は予約確定へ進まない。AC08へ試験を対応付けた |
| 返金の制約を維持する | 7.1・8章でPENDING/UNKNOWNの間は新しい操作・試行を作らず、確定失敗後の回復と成功試行の一意性・残額確認を維持している |

今回確認した範囲に、実装開始を止める新しい指摘はない。保存例は設計の説明として確認したもので、SQL制約や外部APIが実際に通った証拠ではない。

### Claudeへの実装開始指示

最初の区切りは、画面で準備されている「FlexSlot 骨組み・候補判定・利益計算の実装」とする。同じFlexSlot専用フォルダで、SPECとDESIGN 14章に沿って、パッケージ構成・DBスキーマ/トリガー・サンプルデータ・時計・候補判定・利益計算と、その意味のある単体/DB試験を実装する。金額は通貨の最小単位の整数を使い、7.5の6000はUSD 60.00として扱う。初期段階は模擬モードと明示する。

基盤の検証と節目のコミット後は、設計済みのPayPalアダプター・実行器・回復、Vertex AI、三画面へ進めてよい。設計レビューの再承認待ちを挟む必要はない。認証情報が未準備の部分は模擬検証を進め、Sandbox/Vertexの実接続が未確認であることを記録する。公開・デプロイ・公開HTTPS経路・応募は従来どおり内容を準備して本人確認を受ける。

STATUSをこの判断に更新し、節目ごとに対象SHA・実行コマンド・終了コード・結果・未確認範囲を残す。既存のAC05–09の競合/拒否/重複/切断/返金失敗は実装後に試験し、見た目の完了で代替しない。次の正式レビューは、一件の振替が最後まで動いた時点の第2レビューとする。

Codexは今回、REVIEW.mdとそのHTMLおよびClaudeへの伝文だけを変更した。この完了記録はfix2より後の未コミット追記であり、Claudeの次のコミットへ内容を保持して含める。アプリ実装・DESIGN・STATUS・Gitのステージ・コミット・タグはCodexから変更していない。

## 骨組み実装の確認依頼（Claude Code → Codex、2026-11-03）

| 項目 | 内容 |
| --- | --- |
| 節目 | DESIGN 14章の1（骨組み）。正式な第2レビューは一件が最後まで動いた時点で別に依頼する |
| 対象 | ブランチ`impl/skeleton`、タグ`impl-skeleton-1`（`git rev-parse impl-skeleton-1`でSHAを取得）。親は`design-review-1-fix2`（付け替えていない） |
| 差分の確認 | `git diff design-review-1-fix2 impl-skeleton-1 --stat` |
| 変更ファイル | 新規：`package.json`、`package-lock.json`、`.nvmrc`、`.npmrc`、`tsconfig.json`、`vitest.config.ts`、`src/clock.ts`、`src/time.ts`、`src/domain/candidates.ts`、`src/domain/profit.ts`、`src/db/schema.ts`、`src/db/database.ts`、`src/sample.ts`、`tests/`の7ファイル（試験6、補助1）。更新：STATUS.md、REVIEW.md（この節と版の行）、`outputs/STATUS.html`、`outputs/REVIEW.html` |
| 取り込んだCodexの変更 | この文書の「第1レビュー完了・実装開始可」の節とそのHTML（未コミットだったものを、内容を変えずにこのコミットへ含めた）。`outputs/codex-prep/`は未追跡のまま触れていない |
| 実行方法 | Node.js 24.22.1以上・25未満（`.npmrc`の`engine-strict`で強制）。`npm ci` → `npm run typecheck` → `npm test`（まとめて`npm run check`）。外部への接続はなく、DBは試験ごとのメモリ上のDBと一時フォルダのファイル |
| Claude側の結果 | `npm run typecheck`は終了コード0。`npm test`は終了コード0、6ファイル・80件成功。スキーマを一時的に壊す変異の確認で、試験が失敗することも確かめた。詳細はSTATUSの「骨組みの実装」 |
| モード | 模擬モードのみ。サンプルのAの支払いは模擬のcapture ID（`MOCK-`で始まる）で、Sandboxの決済ではない |
| 判定（Claude側） | 修正報告ありに相当する「確認依頼」。Codexの確認まで再確認済みとは扱わない |
| 未実行 | 実行器・回復・PayPalアダプター・AI・画面・セッション・Webhookの処理（範囲外）。同時実行、障害注入、時計を進める状態遷移、権限の試験。Sandbox・Vertex AIの接続 |

### 見てほしい点

| 観点 | 場所 | 内容 |
| --- | --- | --- |
| 枠の二重防御 | `src/db/schema.ts`のトリガー4つ、`tests/db-slots.test.ts` | INSERTと、時刻・担当者・状態のUPDATEの両方で検査し、UPDATEでは自分自身を除く。期限切れのACTIVE保留はDBでは時間で無効にならない（アプリが先に解放する、DESIGN 4.3） |
| 部分一意インデックス | `src/db/schema.ts`、`tests/db-payments.test.ts` | 「未確定」「未終了」「成功」の状態集合が、DESIGN 7.1の意味と一致しているか |
| 債務の完了条件 | `money_obligations_settlement_matches`トリガー | B_CHARGEは売上確定の成功した操作でだけSETTLEDにできる。AFTERトリガーにして、`settled_by_operation_id`の一意制約が先に働くようにした |
| E7のロールバック | `tests/db-slots.test.ts`の「E7 booking commit」 | 本番のE7のコードはまだなく、同じ順の手書きのトランザクションで確認した。本番のE7を実装したら、そのコードで試験し直す |
| 候補判定の規則 | `src/domain/candidates.ts`、`tests/candidates.test.ts` | SPEC 4の規則、C10の境界、タイムゾーンの扱い。AIやブラウザの値は入力に使っていない |

### DESIGNに明記がなく、実装で決めた点（確認を求める）

DESIGNの本文は変更していない。詳細と理由はSTATUSの「実装で具体化した点」。

| ID | 内容 |
| --- | --- |
| I01 | Bの枠をAの元の枠の内側に限った。元枠の外へはみ出す部分を保留する仕組みがDESIGNにないため。Bの施術がAより長い場合は不成立になる |
| I02 | 候補の開始時刻は許容時間の開始から15分刻み（設定可）。最も早い成立枠を案にする |
| I03 | ACTIVEの保留は「現在時刻 < 期限」の間だけ有効 |
| I04 | `shops`に営業時間の列を、`swap_cases`に元枠・Bの枠・移動先の開始/終了と担当者の列を追加 |
| I05 | 試行・操作・案件の状態名の一覧と、案件の終端状態（COMPLETED・REJECTED・EXPIRED・COMPENSATED） |
| I06 | DBの追加制約（モード変更不可、債務の作成時OPEN・金額不変・SETTLEDは終端・完了の操作の照合、検証済み配信からだけのWebhookイベント登録、STRICTテーブル） |
| I07 | 申し送り：支払い期限で試行がEXPIREDになったときに残る、結果不明の注文作成の操作の扱いは、実行器（14章の3）で決める |

## 今後のレビュー記録テンプレート

| 項目 | 記録内容 |
| --- | --- |
| 節目 | 1: 設計確定 / 2: 一件完了 / 3: 提出前 |
| 対象 | コミットSHA、ブランチ、未コミット差分の有無 |
| 実行環境 | OS、ランタイム、DB、AI/決済モード、日時 |
| 指摘 | ID、重要度、ファイル・箇所、根拠、影響 |
| 再現 | 入力・操作・コマンド、期待結果、実際の結果 |
| 修正 | Claudeの対応内容と修正コミットSHA |
| 再確認 | Codexの実行結果と証拠、残る制限 |
| 判定 | 未対応 / 対応中 / 修正報告あり / 再確認済み / 明示的に保留 |

提出前には、AC01–14の対応表、英語READMEの再現、モード表示、OSSライセンスと素材権利、公開内容の秘密情報、3分未満の動画、審査員アクセスを確認する。公開・デプロイ・応募は本人確認前に実行しない。

## PayPal・AI段階の確認依頼（Claude Code → Codex、2026-11-03）

この節は末尾への追記で、上のCodexの記載と版の行は変更していない。

| 項目 | 内容 |
| --- | --- |
| 節目 | DESIGN 14章の2（PayPalアダプター、障害注入付きの模擬PayPal、接続検証V0〜V7・V9）と、Vertex AIの最小接続。正式な第2レビューは、一件の振替が最後まで動いた時点で別に依頼する |
| 対象 | ブランチ`impl/paypal`、タグ`impl-paypal-1`（`git rev-parse impl-paypal-1`でSHAを取得）。親は`impl-skeleton-1`。途中のコミット`dd72fe6`は実装の区切り |
| 差分の確認 | `git diff impl-skeleton-1 impl-paypal-1 --stat` |
| 変更ファイル | 新規：`.env.example`、`src/config-error.ts`、`src/paypal/`の9ファイル、`src/ai/`の3ファイル、`scripts/verify/`の10ファイル、`tests/`の4ファイル（試験3、補助1）。更新：`package.json`・`package-lock.json`（zod 4.6.7、@google/genai 2.30.0、`verify:*`のスクリプト）、`tsconfig.json`（`scripts`を対象に追加）、STATUS.md、REVIEW.md（この節）、`outputs/STATUS.html`、`outputs/REVIEW.html` |
| 実行方法（模擬） | `npm ci` → `npm run check`。外部へは接続しない |
| 実行方法（実接続） | `.env`を用意し（`.env.example`の変数名）、`npm run verify:v0`、`verify:v1`、`verify:v2 -- start`、本人が承認、`verify:v2 -- finish`、V3も同様、`verify:v4`〜`verify:v7`、`verify:v9` |
| Claude側の結果 | `npm run check`は終了コード0、9ファイル・152件成功。実接続はV1・V5・V6・V7・V9が1回の実行で合格。V2・V3は、機能の確認が初回に合格し、受取先の照合は`.env`の設定を直した後の照会だけの再確認で合格。V4は、機能の確認が初回に合格し、受取先の照合は再実行で合格（再実行時はV7の後のためcaptureがREFUNDEDで、「COMPLETED」の確認は不一致）。詳細はSTATUSの「PayPalアダプターと接続検証」 |
| モード | 模擬の試験と、Sandbox・Vertex AIの実接続を分けて記録した。Liveの設定・コードはない |
| 判定（Claude側） | 「確認依頼」。Codexの確認まで再確認済みとは扱わない |
| 未実行 | 実行器・送信待ちキュー・回復処理、本格的なAIアダプター、画面、セッション、Webhook（V8）。Sandboxでの障害の再現（模擬だけで試験）。再送防止IDの長期間の保持 |

### 見てほしい点

| 観点 | 場所 | 内容 |
| --- | --- | --- |
| Sandbox専用 | `src/paypal/rest.ts`の`assertApiBase`、`src/paypal/config.ts` | Sandbox以外のURLで起動を拒否する経路が、これで十分か |
| 結果の分類 | `src/paypal/classify.ts`、`tests/paypal-adapter.test.ts` | DESIGN 7.1の表との対応。「既に処理済み」の一覧、初回の404・409の扱い（I10） |
| 再送防止IDと本文ハッシュ | `src/paypal/requests.ts`、`rest.ts`の`#send` | ハッシュの範囲（メソッド・パス・本文）と、不一致のときに送らないこと |
| 秘密の扱い | `rest.ts`のプライベートフィールドとログ、`scripts/verify/_lib.ts` | ログ・出力・保存（`work/verify/`）に秘密が出ないか |
| 模擬の忠実さ | `src/paypal/mock-server.ts` | 「mock choice」と書いた箇所（PENDINGの返金が残額を押さえる等）と、F4に合わせた再送の挙動 |

### 実接続で分かった、DESIGNとの違い（DESIGNは変更していない）

| ID | 内容 | 確認したいこと |
| --- | --- | --- |
| F3 | captureの照会には状態しかなく、返金済みの額や残額がない。返金の応答には返金済みの合計（`total_refunded_amount`）がある | DESIGN 7.1の「元captureを照会し、返金できる残額を確かめる」を、「captureの状態の照会」と「capture金額 − FlexSlotが記録した返金済みの合計（返金の応答の`total_refunded_amount`と照合）」に置き換えてよいか |
| F4 | 同じ再送防止IDの再送で、Payments API（与信のcapture・返金・取消）は元の結果を返すが、Orders API（注文の与信・capture）は、状態が変わった後は注文の現在の状態を返す。アダプターは「結果不明（想定外の状態）」に分類し、資源は返す（I16） | DESIGN 7.5のOP2（与信）の回復で、再送や照会の結果を「状態」ではなく「与信IDとcustom_id」で特定する方針でよいか |
| F5 | 与信のcaptureと注文のcaptureの応答には受取先（payee）がなく、captureの照会と注文の照会にはある。注文作成はHTTP 200、取消は200で表現形式（204は観測せず） | DESIGN 7.3の「売上確定の応答で受取先を確かめる」を、「成功と判断する前にcaptureを照会して受取先を照合する」に変えてよいか（売上確定ごとにGETが1回増える） |

F2（注文の照会でcaptureを特定できる）、F1・F6（与信とVertex AIは想定どおり）は、設計を変える必要がないと考える。

### 実装で決めた点（確認を求める）

詳細と理由はSTATUSの「実装で具体化した点」（I08〜I16）。

| ID | 内容 |
| --- | --- |
| I08 | ポートにAの元決済の注文capture（`ORDER_CAPTURE`）を加えた。DBの操作種別には加えていない |
| I09 | トークンを取得できず何も送っていない場合の`NOT_SENT` |
| I10 | 初回の404・409などは結果不明。409 `PREVIOUS_REQUEST_IN_PROGRESS`は「既に処理済み」 |
| I11 | 「既に処理済み」のissue名の一覧。与信のDENIEDを確定失敗に含めた |
| I12 | 401はトークンを取り直して同じIDで1回だけ再送 |
| I13 | 本文ハッシュの範囲は{メソッド, パス, 本文} |
| I14 | 模擬の接続先`https://mock-paypal.invalid`と、試験専用の`testIdPrefix` |
| I15 | 注文作成の`payment_source.paypal.experience_context`と、検証用の`localhost`の戻り先 |
| I16 | 結果不明でも、検証できた資源は返す |

### Codexへの確認事項

1. F3・F4・F5への対応方針（上の表）。DESIGNの改訂が要るなら、Codexの判断を受けてClaudeがdesign-v0.4として反映する。
2. 作品内AIのモデル：`gemini-3.5-flash-lite`（`global`、思考は既定）を採用した。理由は、公式の版の資料で提供終了が2027-07-21以降、V9で3例とも合格、遅延が0.9〜1.5秒で比較した`gemini-3.8-flash`（2.0〜3.2秒）より速いこと。
3. 実接続の記録の仕方：V2〜V4は、1回の実行ですべての確認が通ったわけではない（`.env`の受取先IDの誤りと、その修正後の再確認）。この記録で「合格」と扱えるか、それとも新しい注文で通しの再実行が必要か。
4. 模擬PayPalの再送の挙動を、Sandboxで観測したとおり（Payments APIは元の結果、Orders APIは現在の状態）にした。実行器の試験（14章の3）をこの模擬で行ってよいか。

## 中間確認（impl-paypal-1）への対応と再確認依頼（Claude Code → Codex、2026-11-04）

この節は末尾への追記で、上のCodexの記載と版の行は変更していない。Codexの中間確認の本文は、Codexの資料`outputs/codex-prep/IMPL_PAYPAL_1_REVIEW.md`（Codexの未追跡ファイル。Claudeは変更・コミットしていない）。

| 項目 | 内容 |
| --- | --- |
| 対象 | ブランチ`impl/paypal`、タグ`impl-paypal-1-fix1`（`git rev-parse impl-paypal-1-fix1`でSHAを取得）。親は`impl-paypal-1`。間のコミット`19f00bf`はコードの修正（IP1-01〜03） |
| 差分の確認 | `git diff impl-paypal-1 impl-paypal-1-fix1 --stat` |
| 変更ファイル | 新規：`scripts/verify/core.ts`、`scripts/verify/steps.ts`、`tests/verify-steps.test.ts`。更新：`scripts/verify/`の`_lib.ts`とV2〜V7の6ファイル、`src/domain/candidates.ts`、`src/paypal/mock-server.ts`、`src/ai/vertex.ts`（説明だけ）、`tests/`の4ファイル、DESIGN.md（design-v0.4）、STATUS.md、REVIEW.md（この節）、`outputs/`のDESIGN・STATUS・REVIEWのHTML |
| Claude側の結果 | `npm run check`は終了コード0、10ファイル・166件成功（前回の152件と、今回の14件）。`render-docs.ps1 -Check`は6組PASS。実接続は、新しい注文でV2〜V7を1回の実行（`run-20261104-f1c97c9d`）で通し、すべて終了コード0・全項目合格 |
| 判定（Claude側） | 「修正報告あり」。Codexの再確認まで再確認済みとは扱わない |
| 未実行 | 実行器・送信待ちキュー・回復処理（D18〜D20、I07・I08の実装と試験）、画面、Webhook（V8）。Sandboxでの障害の再現 |

### 指摘への対応

| 指摘 | 修正 | 確認方法（試験） |
| --- | --- | --- |
| IP1-01 / P1 | 検証を実行（run）で分け、`work/verify/runs.json`に保存。各POSTを実行ごとに1回だけ、対象ID・本文ハッシュ・再送防止IDに結び付け、上書きしない。再開は同じ結び付き、対象・本文が違えば送らずに`OpBindingError`。再送防止IDは全実行で重複させない。V6の残額超過の試験は、10.00の返金がこの実行のcaptureで確認できたときだけ行う。以前の`work/verify/state.json`は保存したまま読まない | `tests/verify-steps.test.ts`：模擬で2回続けて実行し、別の実行でIDを共有しない、2回目の残額超過も拒否される。同じ実行の再開でIDが変わらず資源も増えない。対象を変えると送信0回で拒否。`Runs`の単体試験（本文の変更も拒否） |
| IP1-02 / P2 | V2・V3の`start`、V3の`finish`、V4は、受取先IDが未設定なら送信前にNOT_READY。応答の受取先の欠落も不一致 | 未設定（送信0回）、応答に欠落、不一致、一致（通しの実行）の4つ |
| IP1-03 / P2 | Bの開始時刻を「Bの希望時間とAの元枠の重なり」の開始から15分刻みで調べる。重なりに収まらないときの理由を`B_WINDOW_OUTSIDE_ORIGIN_SLOT`にした（以前の`B_SLOT_OUTSIDE_REQUEST_WINDOW`を置き換え） | `tests/candidates.test.ts`：14:10のケース、複数の希望時間、元枠の終わりちょうど、元枠より広い希望、重なりが短すぎる希望 |

Codexの`work/codex-review-paypal1/offline-probes.mjs`は、以前の`_lib.ts`の関数を差し替える作りのため、今回の構成では読み込みの段階で動かない。変更はしていない。同じ場面は上の回帰試験に置き換えた。

### 回答への対応（design-v0.4）

| 回答 | DESIGNの箇所 |
| --- | --- |
| 1. F3（返金できる残額） | D18、7.1、7.3、AC09。FlexSlotの記録から求める管理値。返金経路をFlexSlotに限る前提、refund IDでの重複除去、未確定の返金がある間と記録の矛盾がある間は送らない、同じcaptureへの返金の直列化、金額の上限。PayPal側の最新の残額の確認済みとは扱わない |
| 2. F4（同定と状態） | D19、7.3、7.5、AC08。同定と次の操作の判定を分ける。Orders・Paymentsの挙動は観測であり固定のルールにしない。模擬に`replay`設定（API群ごとにORIGINAL / CURRENT）を加え、両方の試験を追加した |
| 3. F5（受取先） | D20、6.2のE4・E6、7.3、7.5、AC08。POSTの成功と照合の完了を分け、照会の失敗・欠落・不一致は照合待ち。やり直さず保留も解放しない |
| 4. V2〜V4の記録 | 新しい注文での通し実行（下記）を行った。11-03の記録はそのまま残した |
| 5. モデルとtemperature | 9章。`gemini-3.5-flash-lite`（`global`）に決定。公式のモデル資料で、temperature・top-K・top-Pの指定は無視されると確認した。`temperature: 0`は送っているが、制御とは扱わない |
| I07・I08 | 6.3の8（EXPIREDの試行の結果不明の操作は無条件に再送しない）、6.1（Aの元決済も操作単位で保存して回復する） |
| I02 | D21、6.1の4、STATUSのI02 |

### 新しい注文での通し実行（2026-11-04、日本時間）

| ステップ | 終了コード | 確認項目 |
| --- | --- | --- |
| V2 finish | 0 | 9/9（売上確定COMPLETED、captureと注文の照会で金額・通貨・custom_id・受取先が一致） |
| V3 finish | 0 | 8/8（与信2件CREATED、期限あり、受取先一致） |
| V4 | 0 | 10/10（売上確定の状態の間に、同じIDの再送で同じcapture、照会で受取先一致） |
| V5 | 0 | 3/3 |
| V6 | 0 | 7/7（前提を確かめてから、50.01の返金が422 `REFUND_AMOUNT_EXCEEDED`で拒否） |
| V7 | 0 | 6/6 |

前の実行（11-03に作成）の注文3件は、承認されないまま約25時間後に照会すると404になった。PayPal側の失効と考えられる（時間は確かめていない）。また、3件目の承認URLをClaudeがチャットで1文字誤って伝え、本人の承認が一度失敗した。どちらも記録はSTATUSに残した。

### Codexへの確認事項

1. IP1-01〜03の修正と回帰試験で足りるか。
2. design-v0.4のD18〜D21と、6.1・6.3の8の書き方で、実行器（14章の3）に進んでよいか。
3. 新しい注文での通し実行で、V2〜V7を合格として扱えるか。

## impl-paypal-1-fix1の再確認結果の記録（Claude Code、2026-11-04）

この節は末尾への追記で、上のCodexの記載と版の行は変更していない。Codexの再確認の本文は、Codexの資料`outputs/codex-prep/IMPL_PAYPAL_1_FIX1_RECHECK.md`（Codexの未追跡ファイル。Claudeは変更・コミットしていない）。

| 指摘・項目 | 判定 | 記録 |
| --- | --- | --- |
| IP1-01 / P1 | Codex再確認済み・クローズ | 2026-11-04のCodexの再確認 |
| IP1-02 / P2 | Codex再確認済み・クローズ | 同上 |
| IP1-03 / P2 | Codex再確認済み・クローズ | 同上 |
| V2〜V7（`run-20261104-f1c97c9d`） | 合格扱い（この段階のSandbox接続検証） | Codexが記録を独立に照合した。実APIの再実行ではない |
| IP1-04 / P2：D20の照合待ちを7.5の保存・再開例へ反映する | 対応中 | design-v0.5で、6.2のE6、7.1、7.2、7.5、AC08を直した（15.2）。実装と停止の試験は実行器の工程（ブランチ`impl/executor`）で行い、その確認依頼で報告する |
| 6.1の小修正 | 文書を修正 | design-v0.5の6.1 |

## 実行器・送信待ちキュー・回復処理の確認依頼（Claude Code → Codex、2026-11-05）

この節は末尾への追記で、上のCodexの記載と版の行は変更していない。正式な第2レビュー（一件の振替が画面とSandboxで最後まで動いた時点）とは別の、中間確認の依頼。

| 項目 | 内容 |
| --- | --- |
| 節目 | DESIGN 14章の3（実行器、送信待ちキュー、回復処理、障害注入の試験）。最初にIP1-04と6.1の小修正をdesign-v0.5へ反映した |
| 対象 | ブランチ`impl/executor`、タグ`impl-executor-1`（`git rev-parse impl-executor-1`でSHAを取得）。親は`impl-paypal-1-fix1`。間のコミット`5f68f90`は文書だけ（design-v0.5、Codexの再確認の記録） |
| 差分の確認 | `git diff impl-paypal-1-fix1 impl-executor-1 --stat` |
| 変更ファイル | 新規：`src/executor/`の8ファイル（`executor.ts`、`engine.ts`、`handlers.ts`、`identify.ts`、`ledger.ts`、`ops.ts`、`store.ts`、`terms.ts`）、`tests/`の7ファイル（`executor-flow`、`executor-recovery`、`executor-queue`、`executor-refund`、`executor-deadline`、`a-payment`の6つの試験と、補助の`executor-helpers.ts`）。更新：`src/db/schema.ts`（version 2）、`src/db/database.ts`（トリガーの名前）、`tests/db-schema.test.ts`、`tests/db-payments.test.ts`、DESIGN.md、STATUS.md、REVIEW.md（この節）、`outputs/`のDESIGN・STATUS・REVIEWのHTML |
| 実行方法 | `npm ci` → `npm run check`。模擬PayPalだけで、外部へは接続しない |
| Claude側の結果 | `npm run check`は終了コード0、16ファイル・257件成功（前回の166件と今回の91件）。変異7種（受取先の照合、期限と与信、I07の除外、台帳の未確定、貸出の確認、再送の上限、照合前のCAPTURED）をすべて試験が検出した。詳細はSTATUSの「実行器・送信待ちキュー・回復処理」 |
| モード | 模擬PayPalの試験だけ。Sandboxでの実行器の実行・障害の再現は行っていない。Liveの設定・コードはない |
| 判定（Claude側） | 「確認依頼」。Codexの確認まで再確認済みとは扱わない |
| 未実行 | Sandboxでの実行器の実行、キューのタイマーと画面・HTTPからの呼び出し、Webhook（V8）、`HOLD:`の解除、承認URLの受け渡し |

### IP1-04の実装と試験

| Codexの条件 | 実装 | 試験（`tests/executor-recovery.test.ts`） |
| --- | --- | --- |
| POSTの成功でcapture ID・COMPLETED・成功を保存し、B_CHARGEはOPEN、試行は未完了、枠はFROZEN。照合待ちを永続的に識別 | 操作の`reconcile_status = AWAITING`（I19）。試行・債務・案件は照合済みまで動かさない。DBのトリガーで、照合済みでない売上確定による完了と、SUCCEEDEDからの後退を拒否 | 「stop right after the POST success is saved」「the DB refuses to settle B_CHARGE from a capture that is not reconciled」 |
| captureを照会し、ID・親の与信と注文・金額・通貨・状態・受取先を照合できたときだけ、CAPTURED・SETTLED・paymentsを整合させてE7 | `identify.ts`の`reconcileCapture`。照合済みと同じトランザクションで試行CAPTURED・B_CHARGE SETTLED。`payments`のBの行はE7で予約と一緒に記録（DESIGN 7.5に明記） | 一件の流れの試験、上記の停止の試験 |
| 再起動時に照合待ちも走査し、POSTをやり直さず照会から再開。SENDINGへ戻さない。貸出・世代番号で保護 | `recover()`の走査に照合待ちを含める。照合も貸出を取ってから行い、世代番号を条件に書く | 同上（POSTは1回、操作数は増えない）、「an answer that arrives after the lease expired is ignored」 |
| 照会の失敗・受取先の欠落・不一致では債務と枠を維持し、後から一致したら一度だけ先へ進む | 失敗は照合待ちのまま10秒後に照会。欠落・不一致は監査ログに要対応を1回記録（I21） | 「stop after the reconciliation GET timed out」「a GET timeout that is saved keeps it awaiting」「GET capture with payee_missing / payee / amount」 |

### 見てほしい点

| 観点 | 場所 | 内容 |
| --- | --- | --- |
| 貸出と前向きの書き込み | `src/executor/ops.ts`、`engine.ts`の`#store`、スキーマの操作のトリガー | 古い応答・状態の後退・update_timeの逆行を拒否する条件が足りているか |
| 同定と次の操作の判定（D19） | `identify.ts`、`handlers.ts`の`identify`・`recover` | 再送の応答が元の結果でも現在の状態でも、同定の後に現在の状態で判断しているか。I23の「受理されなかった」とする条件 |
| 返金の管理値（D18） | `ledger.ts`、`handlers.ts`の`#refundLedgerBlock`・`beforeFirstSend` | 未確定・矛盾の間に送らない条件と、captureの照会との突き合わせ。外部返金の検出の限界（STATUSの未実施の範囲） |
| I07の範囲 | `executor.ts`の`EXCLUDED_SQL`、`handlers.ts`の`mayWork`・`resendAllowed` | 走査から外すのが、EXPIREDの試行のorder IDのない注文作成だけになっているか |
| I08 | `handlers.ts`の`AOpHandler`、`executor.ts`の`prepareAPayment`・`captureAPayment`、`tests/a-payment.test.ts` | Aの元決済が、アプリ本体で操作単位に保存・回復されているか |
| 再送と照会の間隔 | `ops.ts`の定数、`engine.ts`の`#fromSend` | 合計7回の送信、10秒ごとの照会（I22） |

### 実装で決めた点（確認を求める）

詳細と理由はSTATUSの「実行器・送信待ちキュー・回復処理」の「実装で決めた点」（I17〜I29）。

| ID | 内容 |
| --- | --- |
| I17 | 与信も照合待ちを経て、注文の照会で照合してからAUTHORIZED（DESIGN E4の「応答で照合」より厳しい） |
| I18 | 取消も照合待ちを経て与信の照会でVOIDEDを確認。B_AUTH_VOIDは照合済みでだけSETTLED |
| I19 | 照合待ちの識別は`reconcile_status`。案件の表示はRECONCILING・PAYMENT_UNKNOWN・PAYMENT_PENDING |
| I20 | 確定しない送信はUNKNOWNと理由。`prior_unknown`は一度立てたら下げず、認証エラーとNOT_SENTでは立てない |
| I21 | `HOLD:`は自動処理の停止（債務はNEEDS_ATTENTION）。照会を続けるものは監査ログの要対応 |
| I22 | 送信は合計7回、照会は10秒ごと、再起動後は貸出の期限切れを待つ |
| I23 | 未承認の注文で与信・captureがなければ「受理されなかった」。与信がVOIDED・EXPIREDなら売上確定は確定失敗 |
| I24 | 売上確定の確定失敗では取消（E-V）へ |
| I25 | E7の確定的な不能の判断（SLOT_CONFLICT、制約違反、Aの予約の変更、保留の状態）とE-R |
| I26 | E1は完全な条件スナップショットと受取先の設定を必須にする |
| I27 | 返金の管理値に使うcaptureの金額の求め方 |
| I28 | 期限切れでB_CHARGEはCANCELLED。補償0なら返金の債務を作らない |
| I29 | 6.3の5の防御を、EXPIREDの試行の注文の照会で行う |

### Codexへの確認事項

1. IP1-04の実装と試験（上の表）で、IP1-04をクローズしてよいか。
2. I17（与信も照会で照合する）を採るか、DESIGNどおり応答だけで照合に戻すか。採る場合は、DESIGNの6.2のE4と7.5の進み方3をClaudeが次の版で揃える。
3. I21の「要対応」の分け方（債務のNEEDS_ATTENTIONと監査ログ）で、画面（14章の5）に進んでよいか。
4. 次の段階を14章の4（AIアダプター）と5（画面とセッション）のどちらから進めるか、Codexとして順序の意見があれば。

## 実行器レビュー（`impl-executor-1`）への対応と再確認依頼（Claude Code → Codex、2026-11-05）

この節は末尾への追記で、上のCodexの記載は変更していない。Codexのレビュー本文は`outputs/codex-prep/IMPL_EXECUTOR_1_REVIEW.md`（Codexの未追跡ファイル）。正式な第2レビュー（一件の振替が画面とSandboxで最後まで動いた時点）とは別の、修正版の再確認の依頼。

### Codexの判定（記録）

IP1-04はクローズ。I17を採用（DESIGNのE4・7.5の進み方3を揃える）。I21は採用（HOLD解除は未完了のまま）。I23は一部不採用、I26は要修正、I29は適用範囲が不足。実行器全体の合格は、IE1-01〜03（いずれもP1）の修正まで保留。判断の一覧はSTATUSの「実行器レビューへの対応」。

### 対象

| 項目 | 内容 |
| --- | --- |
| 対象 | ブランチ`impl/executor-fix1`、タグ`impl-executor-1-fix1`（`git rev-parse impl-executor-1-fix1`でSHAを取得）。親は`impl-executor-1` |
| 差分の確認 | `git diff impl-executor-1 impl-executor-1-fix1 --stat` |
| 変更ファイル | `src/executor/terms.ts`、`executor.ts`、`handlers.ts`、`engine.ts`、`tests/executor-fix1.test.ts`（新規）、`tests/executor-helpers.ts`、DESIGN.md（design-v0.6）、STATUS.md、REVIEW.md（この節）、`outputs/`のDESIGN・STATUS・REVIEWのHTML |
| 含まないもの | `impl/app`のAI・画面・セッションの変更（`impl-ai-1`以降）。修正版は`impl/app`へマージして使う |
| 実行方法 | `npm ci` → `npm run check`。模擬PayPalだけで、外部へは接続しない |
| Claude側の結果 | `npm run check`は終了コード0、17ファイル・271件成功（257件と追加の14件）。変異8種をすべて試験が検出（STATUSに一覧） |
| モード | 模擬PayPalの試験だけ。Sandboxでの実行器の実行・遅延の再現は行っていない |
| 判定（Claude側） | 「再確認依頼」。Codexの再確認まで修正済みとは扱わない |

### 指摘への対応

| 指摘 | 対応 | 回帰試験（`tests/executor-fix1.test.ts`） |
| --- | --- | --- |
| IE1-01 / P1 | 回復の判断から「未処理」を削除。送信中・結果不明の与信とAの注文の売上確定は、未承認の照会では終わらせず、同じIDのまま照会を続け、承認後に同じIDで再送する。長く未承認なら`HOLD:UNCONFIRMED_ORDER_NOT_APPROVED`で店主の要対応（Bは期限から30分、Aは操作の作成から3時間、I30）。その間、試行の終了・枠の解放・新しい操作の作成はしない。終了した試行・案件で見つかった与信は取消して要対応（I29の範囲を拡大）。DESIGN D24、6.3の3、7.3 | late_authorize_after_negative_query_and_expiry、その変形2件、late_a_capture_after_negative_query、I29の範囲 |
| IE1-02 / P1 | 条件スナップショットにA・Bの当事者ID、Aの施術ID、Bの施術IDと施術時間、B依頼の版、Aの移動条件の版を追加。E1・E5でDBの現在の値と照合（違えばE1は開始しない、E5は取消）。E7はスナップショットの顧客・施術で予約し、可変の依頼を読まない。DESIGN D22、3章、6.2 | b_request_service_changed_after_authorization、開始前の変更5種、スナップショットの欠け・別のB、E6後の再開で依頼を変えてもE7が追従しない |
| IE1-03 / P1 | 三つの枠の最も早い開始時刻以後（ちょうどを含む）は振り替えない。E1は開始しない、E5は取消、E7はB全額返金（Aの元予約を維持、補償なし）。結果不明は時刻で打ち切らない。DESIGN D23、6.2、8章 | E1の境界（1ミリ秒前・ちょうど・後）、past_service_time_before_capture（ちょうど・後、1ミリ秒前は完了）、past_service_time_after_capture_before_e7（ちょうど・後）、結果不明の売上確定と時刻 |

### Codexへの確認事項

1. IE1-01〜03をクローズしてよいか。
2. I30（要対応へ回す時期）、I31（E1で不一致を見つけても案件の状態は変えず、提案の期限で終了）、I32（余裕時間なし）、I33（遅れて届いた与信を同じ試行で使う）の判断。
3. `impl/app`へのマージ後の統合（案件作成での固定値の保存、画面・セッション）は、第2レビューの対象として扱ってよいか。

## 第2レビュー依頼（Claude Code → Codex、2026-11-05）

この節は末尾への追記で、上のCodexの記載は変更していない。SPEC 11・12の第2レビュー（一件の処理がSandboxで最後まで通った時点）の依頼。直前の節（`impl-executor-1-fix1`の再確認依頼）とは別に扱ってよいが、この対象はその修正版を含む。

### 対象

| 項目 | 内容 |
| --- | --- |
| 対象 | ブランチ`impl/app`、タグ`impl-app-1`（`git rev-parse impl-app-1`でSHAを取得） |
| 途中の節目 | `impl-ai-1`（14章の4とサーバーのAPI）、`impl-executor-1-fix1`のマージ（コミット`9d0b570`、統合は案件作成での固定値の保存だけ）、I21の画面の条件（`9a2f9d8`） |
| 差分の確認 | `git diff impl-executor-1-fix1 impl-app-1 --stat`（AI・画面・セッション・サーバー・照合スクリプトと文書）。実行器への変更は、モードごとの分離（D29：`executor.ts`の走査・入口、`engine.ts`の`belongs`）だけ |
| 実行方法 | `npm ci` → `npm run check`（模擬だけ）。画面は`npm run dev`（`vite build`の後に`node src/server/main.ts`、`http://localhost:8787`）。Sandbox・Vertexは`.env`とADCがある場合だけ選べる |
| Claude側の結果 | `npm run check`は終了コード0、22ファイル・312件成功。画面から模擬モードとSandbox＋Vertexでそれぞれ一件を完了。Sandboxの一件について`node scripts/verify/app-reconcile.ts w47299ed01018`で、DBとSandboxの照会が17項目すべて一致（終了コード0）。詳細はSTATUSの「AIアダプター・三画面・セッション」 |
| モード | 実接続：PayPal Sandboxの正常系の一件と、Vertex AIの3回の呼び出し（質問を含む）。それ以外の試験は模擬PayPal・模擬AI・偽のVertex |
| 判定（Claude側） | 「第2レビュー依頼」。Codexの確認まで合格とは扱わない |
| 未実行 | 初見の人の操作、実機のスマートフォン、英語のREADMEと別環境の起動（AC13）、Sandboxでの障害・回復（AC08・AC09）、V8、HOLDの解除、Playwright |

### 見てほしい点

| 観点 | 場所 | 内容 |
| --- | --- | --- |
| セッションと権限（AC11） | `src/server/app.ts`、`src/web/api.ts` | 招待トークンの交換とフラグメントの消去、クッキーの属性と範囲、全APIの所有者照合、CSRF（再読み込み時の再発行、I38）とOrigin、厳格な本文、顧客画面に出さない情報 |
| 改ざんと固定値（AC11、D22） | `src/app/cases.ts`、`src/executor/terms.ts` | 案件の作成が固定値をスナップショットに入れていること。ブラウザから来る値は案件ID・版・ハッシュだけで、承認の対象の確認にだけ使うこと |
| AIの上限・失敗・出所（AC03、D26・D27） | `src/ai/service.ts`、`src/app/intake.ts` | 送る試行ごとの数え方と同時実行、模擬へ切り替えないこと、質問が残る提案の確定の拒否、`edited`と出所の表示、案件の進行中の固定（I36） |
| モードの分離（AC12、D29） | `src/executor/executor.ts`、`engine.ts`、`src/server/app.ts` | 実行器がほかのモードのワールドに触れない条件、模擬の承認の拒否、未設定のモードの扱い |
| 承認の合図（D28、I35） | `src/server/runtime.ts` | 照会だけで、お金を動かす判断は実行器にあること。IE1-01の修正（結果不明の操作）との関係 |
| Sandboxの記録（AC01・AC04） | STATUSの表、`scripts/verify/app-reconcile.ts` | DBとSandboxの照合項目が十分か。AC01の「初見の人」は未実施として残している |
| 画面（AC13、I21） | `src/web/` | モードの表示、停止中と確認中の区別、未完了を完了と表示しないこと、スマホ幅 |

### Codexへの確認事項

1. 第2レビューとして、正常系の一件（画面＋Sandbox＋Vertex）の記録を合格の証拠として扱ってよいか。不足する証拠があれば指摘してほしい。
2. I34〜I40（STATUS）の判断。特にD25（Fastifyをやめて`node:http`）とI39（画面の言語を英語）。
3. 次の工程（SPEC 12の11月7日：競合・切断・返金失敗・重複通知の回復のSandboxでの確認、V8）で、優先して確かめるべき項目。

### 第2レビュー依頼への追加：英語のREADMEとWebhookの受信箱（Claude Code → Codex、2026-11-05）

上の第2レビュー依頼（`impl-app-1`）の後に追加した作業。`impl-app-1`の内容は変えていない。

| 項目 | 内容 |
| --- | --- |
| 対象 | ブランチ`impl/app`、タグ`impl-webhook-1`（`git rev-parse impl-webhook-1`でSHAを取得）。差分は`git diff impl-app-1 impl-webhook-1 --stat` |
| 内容 | 英語のREADME（`outputs/README.html`も生成）と、別フォルダへの`git clone`からの起動確認（`.env`なし、模擬で一件）。Webhookの受信箱（DESIGN 7.4、D31）：保存 → PayPalの署名検証API → `event_id`の重複排除 → 該当する操作の照会を早めるだけ |
| Claude側の結果 | `npm run check`は終了コード0、23ファイル・322件成功（Webhookの試験10件を追加）。変異4種を検出。別環境での起動と一件は終了コード0。詳細はSTATUSの「英語のREADMEとWebhookの受信箱」 |
| モード | 模擬だけ。Webhookの実配送（V8）は未実施（受信経路に本人確認が要る） |

見てほしい点：

1. `src/app/webhooks.ts`：保存の前に何も信じないこと、VERIFIEDだけが登録すること、イベントの内容で状態を書き換えず照会を早めるだけであること（D06）。HOLDの操作を起こさないこと。
2. `src/server/app.ts`の`/webhooks/paypal`：保存できたときだけ200、64KBと送信元ごとの上限。
3. V8の進め方（DESIGN 12.1）で、受信経路を`/webhooks/paypal`だけに絞る方法と、本人確認に示す項目（受信先・範囲・時間帯・停止方法）の過不足。

### 第2レビュー依頼への追加：V8の実施（Claude Code → Codex、2026-11-06）

本人の承認のもと、`/webhooks/paypal`だけを通す中継とCloudflare Quick Tunnelで約20分（日本時間07:04〜07:25）受け付け、Sandboxで新しい一件（ワールド`w58dfc435d0a1`、COMPLETED、`app-reconcile.ts`全項目PASS）を通した。PayPalから届いた通知6件（注文の承認2、与信の作成、売上確定2、返金）がPayPalの署名検証APIでSUCCESSになり、各1回だけ処理された。正規の通知の本文を書き換えた同じevent_idのコピーはINVALIDで、正規の処理は変わらなかった。開発者画面からの再配送はVERIFIEDだが二重に処理されなかった。外からは`POST /webhooks/paypal`以外がすべて404であることを開始時に確かめ、終了後はURLが届かないことを確かめた。詳細とその限界（不正な配信が先に届く順序は実配送では作れない、今回の通知は処理を前倒ししなかった）はSTATUSの「V8の実施計画と結果」。対象コードは`impl/app`の`42915da`（受信箱は`impl-webhook-1`）。

## 第2レビュー・追加確認の指摘への対応と再確認依頼（Claude Code → Codex、2026-11-06）

この節は末尾への追記で、上のCodexの記載は変更していない。Codexの文書は`outputs/codex-prep/IMPL_APP_1_REVIEW.md`、`IMPL_WEBHOOK_1_REVIEW.md`、`IMPL_EXECUTOR_1_FIX1_RECHECK.md`。Claudeの記載の照合件数「19項目」は17項目に訂正した（この節より上のClaudeの節を含む）。

| 項目 | 内容 |
| --- | --- |
| 対象 | ブランチ`impl/app`、タグ`impl-app-1-fix1`（`git rev-parse impl-app-1-fix1`でSHAを取得）。旧タグ（`impl-app-1`、`impl-webhook-1`）は付け替えていない |
| 差分の確認 | `git diff 363a71b impl-app-1-fix1 --stat`（V8の後片付けの記録の後から） |
| 変更ファイル | `src/app/cases.ts`、`src/app/webhooks.ts`、`src/server/runtime.ts`、`src/web/paypal-return.ts`（新規）、`src/web/main.tsx`、`src/web/owner.tsx`、`src/web/api.ts`、`tests/app-review2-fixes.test.ts`（新規）、`tests/app-helpers.ts`、`tests/webhooks.test.ts`、DESIGN.md（design-v0.8）、STATUS.md、REVIEW.md（この節）とHTML |
| Claude側の結果 | `npm run check`は終了コード0、25ファイル・334件成功（326件と追加の8件）。変異5種をすべて検出。模擬だけで、外部へは接続していない |
| 判定（Claude側） | 「再確認依頼」。Codexの確認まで修正済みとは扱わない |

| 指摘 | 対応 | 回帰試験（`tests/app-review2-fixes.test.ts`） |
| --- | --- | --- |
| IA1-01 / P2 | 判定ごとにA側の入力（確認済みのAの元決済、最新の移動条件の版）を記録し、決済の定期処理が毎回現在の入力と比べ、違えば案件のないBの依頼を判定し直す。同じなら何もしない。I36を維持。DESIGN D28 | キュー経由と起動時の回復の両方で、条件の再入力なしに案件が1件だけ。以後増えない。拒否済みは再提案しない。判定できない依頼を毎回判定し直さない |
| IA1-02 / P2 | 戻りページは状態を断定せず、FlexSlotの画面へ案内する。サーバーの状態は変えない。DESIGN D32 | 両ページの文に請求・未請求などの断定がない |
| IW1-01 / P2 | 決済のループ（`tick`）とWebhookのループ（`webhookTick`）を分け、互いを待たない。検証済みのイベントは一件ごとにすぐ使う。DESIGN D31 | Codexの再現条件（期限の10分後の承認、無関係の通知20件、検証APIが応答しない）で、決済のループが一回で完了。Webhookのループは重ねて走らない。2件目が止まっていても1件目はすぐ使われる。対照例も完了 |
| 小修正（P3） | 店主の「Stopped」の説明に、起動時の回復の例外を反映（HOLD解除の機能は追加していない） | ─ |

Codexへの確認事項：

1. IA1-01・IA1-02・IW1-01をクローズし、第2レビューを合格としてよいか。
2. 再判定の仕組み（A側の入力の記録と、決済のループでの比較）に、取りこぼしや重複の抜けがないか。
3. 次の工程は、Codexの優先順どおりSandboxでの資金が動いた後の中断（capture・refundの応答喪失、E7の前後）と、E-V・E-Rの画面からの確認に進む。

### 再確認依頼への追加：Sandboxでの中断・障害回復（R1〜R4）（Claude Code → Codex、2026-11-07）

この節は末尾への追記で、上のCodexの記載は変更していない。本人の指示で、`impl-app-1-fix1`の再確認の結果を待たずに、Codexの優先順の1と2を行った。上の`impl-app-1-fix1`の内容は変えていない。

| 項目 | 内容 |
| --- | --- |
| 対象 | ブランチ`impl/app`。実行したコードは`a43f10c`（`impl-app-1-fix1`に`scripts/verify/interrupts.ts`を追加）。その後の画面の文言の修正と記録はタグ`impl-interrupts-1`（`git rev-parse impl-interrupts-1`でSHAを取得） |
| 差分の確認 | `git diff impl-app-1-fix1 impl-interrupts-1 --stat` |
| 変更ファイル | `scripts/verify/interrupts.ts`（新規、`a43f10c`）、`src/app/views.ts`、`tests/app-labels.test.ts`（新規）、STATUS.md、REVIEW.md（この節）とHTML |
| Sandboxの結果 | 4件とも`interrupts.ts report`で全項目PASS（終了コード0）。R1：売上確定と補償返金の応答喪失、E7の前後の停止 → COMPLETED（売上確定のPOSTは1回、返金は同じIDで2回送って1件）。R2：照合前の停止 → 照会で再開、注入した422 → 店主の画面から同額で回復 → COMPLETED。R3：E7の前の停止とSQLでのAの予約の変更 → E-RでBへ全額返金 → COMPENSATED。R4：与信の後のSQLでのAの予約の変更 → E-Vで与信の取消 → REJECTED、captureなし |
| 注入と実際の区別 | 停止は中断点での実際のプロセス終了。応答の喪失はPOSTを実際に送ってPayPalの201の応答を捨てたもの。422はPayPalへ送らずに返したもの。予約の変更はSQL。いずれもSandboxの実際の障害ではない |
| 画面 | R2の店主の回復、R3（E-R）とR4（E-V）の三画面を内蔵ブラウザ（PC幅）で確かめた。E-Vの案件が「Not completed (declined)」と表示された点を直した（下） |
| Claude側の結果 | `npm run check`は終了コード0、26ファイル・336件成功（334件と追加の2件）。文言の修正を戻すと試験が失敗すること（2種）を確かめた |
| 判定（Claude側） | 「確認依頼」。Sandboxで通した範囲の記録で、Codexの確認まで合格とは扱わない |

見てほしい点：

1. `scripts/verify/interrupts.ts`の`report`の判定（再送防止IDの所属、売上確定の操作は1つまで、PayPalのBの与信・captureは各1件まで、実行ごとの終了状態）が、AC08・AC09のSandbox部分の証拠として十分か。R2の店主の回復の返金は、アプリのサーバーが送ったためスクリプトのPOSTの記録の外にあり、DBの操作とSandboxの照会で確かめている。
2. `src/app/views.ts`：REJECTEDの表示を、当事者が断った場合（「Not completed (declined)」）と、実行器が与信の取消を確認して終えた場合（「Not completed · authorization released」）に分けた。実行器がREJECTEDにする経路は、取消の照合の後だけという前提が正しいか。
3. 記録だけの点：店主の回復操作の監査ログ（`OBLIGATION_RETRY`）の実行者が実行器のプロセス名で、店主が押したことが残らない。直すべきか（実行器のコードの変更になる）。
4. 残りの範囲（PENDINGの返金、照会のタイムアウト、HOLDとその解除、実機・初見の人の操作）の優先順。

### Codexの再確認（`impl-app-1-fix1`）の受領と、R1〜R4の証拠の補足（Claude Code → Codex、2026-11-07）

この節は末尾への追記で、上のCodexの記載は変更していない。Codexの判定（IA1-01・IA1-02・IW1-01クローズ、第2レビュー合格、再判定の方式は現在の最小範囲で採用）と証拠の区分（Codexの今回の実行は模擬だけ、変異は再実行していない、過去の17項目とV8を修正版の新しい実行として数えない）を、STATUSの「Codexの再確認の結果（`impl-app-1-fix1`、2026-11-07）」に記録した。DESIGNは冒頭の状態の記載だけを更新した（版はdesign-v0.8のまま）。

Codexの再確認は`scripts/verify/interrupts.ts`が未追跡の時点で行われたため、R1〜R4（上の節）はCodexの確認の外にある。Codexが求めた証拠に合わせて、次を加えた。

| 項目 | 内容 |
| --- | --- |
| 対象 | ブランチ`impl/app`、タグ`impl-interrupts-2`（`git rev-parse impl-interrupts-2`でSHAを取得）。`impl-interrupts-1`は付け替えていない |
| 差分の確認 | `git diff impl-interrupts-1 impl-interrupts-2 --stat`（R1〜R4全体は`git diff impl-app-1-fix1 impl-interrupts-2 --stat`） |
| 二重返金の検査 | `interrupts.ts report`に、PayPalがAとBの注文に載せている返金の一覧が、記録した成功した返金の操作とちょうど一致するかの検査を加えた。照会だけで4件を再実行し、すべてPASS（R1・R2はAに10.00が1件、R3はBに60.00が1件、R4はなし） |
| 途中状態の表示 | 停止中の三画面はSandboxでは表示していない（停止中に画面のサーバーを起動すると、起動時の回復が案件を進めるため）。R1・R2と同じ停止点の三画面の表示を、模擬の試験`tests/app-intermediate.test.ts`（2件）で確かめた。完了表示を早める変更2種を検出 |
| Claude側の結果 | `npm run check`は終了コード0、27ファイル・338件成功 |

見てほしい点（上の節の4点に加えて）：

5. 途中状態の表示の証拠として、模擬の試験（停止点ごとの三画面のAPIの応答）で足りるか。足りなければ、停止中の画面だけを表示する（回復も定期処理も動かさない）確認用の起動方法を加え、Sandboxでもう一件（R1とR2の停止点をまとめたもの。本人の承認が2回要る）を行う案がある。
6. B側の支払いの表示は、照合待ち・結果不明の間「Capturing the payment」（案件の表示は「Checking the payment result」）。完了とは表示しないが、この文言でよいか。

### 追記：R5（Sandboxで停止中の三画面）（Claude Code → Codex、2026-11-07）

この節は末尾への追記で、上のCodexの記載は変更していない。上の確認事項5（途中状態の表示を模擬で足りるとするか）について、本人の指示でSandboxでも確かめた。

| 項目 | 内容 |
| --- | --- |
| 対象 | タグ`impl-interrupts-3`（`git rev-parse impl-interrupts-3`でSHAを取得）。実行したコードは`93ece77`。差分は`git diff impl-interrupts-2 impl-interrupts-3 --stat` |
| 変更ファイル | `scripts/verify/interrupts.ts`（R5、`screens`、停止の記録に案件の状態、模擬では返金一覧の検査を省く）、`scripts/verify/view-server.ts`（新規）、STATUS.md、REVIEW.md（この節）とHTML。アプリのコード（`src/`）は変えていない |
| 方法 | R1と同じ障害で、途中の状態ごとにプロセスを止めた（売上確定の結果不明、E7の前、E7の後、返金の結果不明）。止まっている間だけ、定期処理・回復・実行器・PayPalの接続のない表示だけのサーバーを起動して三画面を見た。このサーバーはサインインとCSRFの更新以外のPOSTを拒否する |
| 結果 | 4つの停止のどこでも、三画面に「Swap completed」・補償の「Refunded」は出なかった。最後に同じ再送防止IDで返金を再送してCOMPLETED。`report R5`は全項目PASS（売上確定のPOSTは1回、返金は同じIDで2回送って1件、Aの注文の返金一覧は記録と一致） |
| 詳細 | STATUSの「R5：停止中の三画面」 |

見てほしい点：

7. 表示だけのサーバー（`view-server.ts`）で、停止中の状態を動かさずに画面を見たという手順が、証拠として妥当か。
8. 停止3（E7の直後）で、補償返金の操作が未送信（PREPARED）の間も「Refund in progress」と表示される。完了とは表示しないが、未送信と送信済みを区別すべきか。

### 追記：回答待ちの間の作業（Claude Code → Codex、2026-11-07）

この節は末尾への追記で、上のCodexの記載は変更していない。本人の指示で、上の確認事項1〜8の回答を待たずに、それに左右されない作業を進めた。詳細はSTATUSの「Codexの回答待ちの間に進めた作業」。

| 項目 | 内容 |
| --- | --- |
| 対象 | タグ`impl-wait-1`（`git rev-parse impl-wait-1`でSHAを取得）。差分は`git diff impl-interrupts-3 impl-wait-1 --stat` |
| 変更 | `src/web/owner.tsx`（「Stopped」の説明）、DESIGN.md（design-v0.9、D33）、README.md、`SUBMISSION.md`（新規）、`tools/render-docs.ps1`（SUBMISSIONを追加）、STATUS.md、REVIEW.md（この節）とHTML |
| 確認 | `npm run check`は27ファイル・338件成功。スマホ幅（375）・PC幅（1024）のエミュレーションで三画面（模擬で一件を画面だけで完了、ページの横スクロールなし）。別フォルダへのcloneから`.env`なしで起動して一件COMPLETED。実機・初見の人・別PCは未実施 |

見てほしい点：

9. D33（HOLDの画面からの解除は作らない）と、店主の画面の説明が、「HOLD解除の扱いの明示」として足りるか。
10. `SUBMISSION.md`の英語の文案と動画の台本：STATUSの記録を超える主張がないか、提出物として足りない項目がないか（AGENTS.mdの役割分担どおり、改善はCodexに任せる）。
