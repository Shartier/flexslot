# FlexSlot — 状況と次の作業

更新日：2026-11-03（日本時間）/ 文書版：status-v0.1。

## 現在地

仕様と引き継ぎの準備段階。アプリ実装、AI実接続、PayPal Sandbox接続、公開、応募の成功はまだ確認していない。

## 確認済み

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

Gitのuser.name/user.emailは未登録だったため、今回の初期文書コミットに限り一時的な作者 `Codex <codex@local.invalid>` を指定する。ユーザーのローカル/グローバルGit設定は変更しない。次回以降に使う本人のコミット作者設定は未設定のまま。

参照：[公式規約](https://paypalaihackathon.devpost.com/rules)、[PayPal決済](https://developer.paypal.com/v5/checkout/auth-capture)、[Google Cloud認証](https://cloud.google.com/vertex-ai/generative-ai/docs/start/gcp-auth)。

## 実行した確認とテスト

| 区分 | 実施内容 | 結果 |
| --- | --- | --- |
| フォルダ | Get-Location、Get-ChildItem、rg --files --hidden、親AGENTS確認 | 既存コードなし、上書き対象なし |
| Git事前確認 | git rev-parse / status / remote | 未初期化を確認。アプリ不具合ではない |
| Git初期化 | git init -b main | 成功 |
| 文書検証 | PowerShellでMarkdown→HTML生成、render-docs.ps1 -Checkによる本文・SHA-256照合 | 5組で一致。ナビゲーションのローカルリンク先も確認 |
| Git除外 | .env、入れ子.env、秘密鍵、DB、ログ、work等の除外 | 除外10パターン合格、example設定と文書等の追跡可能4パターンも合格 |
| 計算 | 利益例の算術、PSTからJSTへの日時換算 | USD 20.50、締切2026-11-13 05:00 JSTを再計算 |
| HTML表示 | ローカルfile URLをブラウザで開く試行 | ブラウザのURLポリシーで拒否。PC/スマホの目視確認は未実施。画面表示成功とは扱わない |
| アプリテスト | 単体・統合・E2E・実API・実機 | 未実行。アプリコードなし |

補足：文書生成ツール確認時、WindowsAppsのpython.exeエイリアスは起動できなかった。Pythonをアプリの必須要件にしていない。HTML生成には利用可能なPowerShell 7のConvertFrom-Markdownを用いる。

HTMLは外部スクリプト・画像・iframeを含まず、ローカルファイルとして直接開ける形で保存した。レスポンシブCSSと表の横スクロールを用意したが、その見た目を今回のブラウザで検証できたとは主張しない。

## 未確認事項

| 項目 | 現時点の扱い | 確認担当/タイミング |
| --- | --- | --- |
| PayPal Sandbox準備 | ユーザーへ準備状況だけ質問中。未設定・失敗とは断定しない | 本人/Claude、第1段階 |
| Sandboxの店舗とA/Bアカウント、通貨 | 未確認。競合作品の国・カード制約を転用しない | Claude、公式仕様と実アカウントで確認 |
| Aの元capture | 未作成と断定しない。今回フォルダに証拠なし | Claude、実接続デモの前提として照合 |
| Google Cloudプロジェクト・リージョン・モデル・認証 | 未確認。秘密値の提出は求めていない | 本人/Claude、既存設定を値非表示で確認 |
| 実装技術とDB排他設計 | Claudeが選定・設計を具体化する | 第1レビュー |
| Devpost登録・参加資格 | 未確認。規約を読んだことと登録済みは別 | 本人、提出準備 |
| OSSライセンス・デモ公開先・審査アクセス | 未確定 | 提出準備時に具体案を作る |
| 現在のCodex/Claudeモデル | モデル切替を実行・検証していない | 各アプリのモデル選択で本人確認 |

## 次に行う作業

1. Claude Codeでこのフォルダを開き、CLAUDE_START.mdの依頼を渡す。
2. Claudeは技術構成、DBの排他制御、役割別認証、決済状態と回復方法を具体化し、SPECの設計案との差分を記録する。
3. 最初の区切りは設計確定と接続検証計画。コミットSHAと変更点をCodexへ渡し、第1レビューを受ける。本体実装を一気に開始しない。
4. その後、Claudeが小さなAI/Sandbox接続検証から開始し、一件全体、失敗時の回復、提出物の順に実装する。秘密情報が使えなければモックで進め、実接続未確認を残す。

11月9日機能固定、11月11日提出目標。11月13日05:00 JST締切。詳細はSPECの計画を参照。接続準備が遅れても、実接続条件を黙って完成条件から外さない。

## 今後の検証記録の書式

各節目で対象コミットSHA、作業ツリー差分、実行日時・環境・モード、コマンド、終了コード、結果、匿名化した証拠の保存先、未実行範囲を追記する。ブラウザで動作を見ただけの確認と、DB・外部APIの整合性確認を区別する。提出用の成功主張は確認できた範囲に限定する。
