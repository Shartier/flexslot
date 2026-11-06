# FlexSlot — 画像の指示書（Codex向け、GPT Image）

作成：Claude Code、2026-11-07（日本時間）。本人の指示：画面をリッチにするため、画像はCodex側でGPT Image（2.5または2.6。Codex側で使えるもの）を使って生成する。Claude Codeからは画像生成のモデルを使えない。

## 進め方と置き場所

| 項目 | 内容 |
| --- | --- |
| 生成する人 | Codex（GPT Image）。実際に使ったモデル名と版、生成日を下の「生成の記録」に書けるよう、Codexの文書に残してほしい |
| 置き場所 | `outputs/codex-prep/images/`（Codexの作業場所）。Claudeがそこから`src/web/images/`へ写して画面に組み込む。Codexは実装のフォルダ（`src/`）を編集しない（AGENTS.mdの「同じファイルを二者で同時に編集しない」） |
| 形式 | WebP（透過が要るものはアルファ付き）。各300KB以下を目安。サイズは下の表 |
| 使う場所 | 三画面（店主・A・B）とトップページ、デモ動画、Devpostの表紙 |

## 全体の約束（すべての画像）

- 画像の中に文字・数字・記号を入れない（多言語の表示と、生成画像の文字の崩れを避ける）。
- 実在の会社のロゴや商標を入れない（PayPal、Google、Cloudflareなど）。決済は一般的なカードやスマホで表す。
- 実在の人物に似せない。人物は簡略化したイラスト調。
- 画風をそろえる：落ち着いたフラットなイラスト、柔らかい影、線は細め。日本の小さな美容室の雰囲気。
- 配色は画面に合わせる：背景のベージュ #f6f5f2、青 #1f5f8b（主色）、緑 #1e7b46（完了）、琥珀 #8a5a00（待ち）、薄紫 #6b3fa0（模擬）。明るい背景と暗い背景（#15171a）の両方で見えること。
- 1枚目を作った後、同じ画風・配色・人物の描き方で残りを作る。

## 作ってほしい画像

| ファイル名 | サイズ・背景 | 使う場所 | 内容（プロンプトの下書き、英語） |
| --- | --- | --- | --- |
| `hero.webp` | 1600×900、背景あり（角丸のカードに入れる） | トップページの最上部、動画の冒頭 | A cozy small Japanese hair salon at the front desk, seen from a slight angle. A large wall calendar shows one afternoon slot that is fully booked. Two customers: one relaxed regular customer smiling and gently stepping aside, and one new customer hurrying in. A stylist behind the desk. Warm, calm flat illustration with soft shadows, thin lines, beige background, blue and green accents. No text, no letters, no numbers, no logos. |
| `role-owner.webp` | 512×512、透過 | 店主の画面の見出しの横 | A friendly salon owner and stylist holding scissors and a tablet, upper body, simple flat illustration, round composition, blue accent clothing. No text, no logos. |
| `role-a.webp` | 512×512、透過 | 既存客Aの画面の見出しの横 | A relaxed regular customer holding a phone and a small calendar card, kind expression, upper body, simple flat illustration, round composition, green accent clothing. No text. |
| `role-b.webp` | 512×512、透過 | 新規客Bの画面の見出しの横 | A new customer in a slight hurry checking a phone, hopeful expression, upper body, simple flat illustration, round composition, amber accent clothing. No text. |
| `swap.webp` | 1200×600、透過 | 振替の提案のカード、動画の説明 | Two appointment cards trading places with curved arrows between them, and a small coin moving back to one of them as a refund. Clean flat icon-like illustration, blue and green accents. No text, no numbers. |
| `checking.webp` | 800×600、透過 | 支払いの確認中・停止中の画面の空き部分 | A payment card and a small clock with a magnifying glass, calm and reassuring, nothing alarming. Flat illustration, blue accent. No text, no logos. |
| `done.webp` | 800×600、透過 | 振替が完了した画面 | A calendar with a check mark, a small pair of scissors and a gentle sparkle, quiet celebration. Flat illustration, green accent. No text. |
| `cover.webp` | 1280×720、背景あり | Devpostの表紙、YouTubeのサムネイルの土台（文字は後で別に入れる） | Same salon scene as hero.webp but simpler, with clear empty space on the left third for a title to be added later. No text, no logos. |

## 生成の記録（Codexが記入、Claudeが転記）

| 項目 | 内容 |
| --- | --- |
| 使った機能 | OpenAIの内蔵の画像生成ツール`image_gen.imagegen`（Codex側）。Codexの記録：ツールがモデルIDと版を返さないため、正確なモデル名と版は分からない。**GPT Image 2.5／2.6を使ったとは書かない** |
| 生成日 | 2026-11-07（日本時間） |
| 生成の方法 | heroを先に作り、それを参照して残り7点を作成。swapだけ植物を除く編集を1回。採用8点、生成・編集の呼び出し計9回。生成後はSharp 0.35.5で縦横比を保った縮小とWebPへの変換だけ（描き足し・文字の合成なし） |
| 使ったプロンプト | Codexの`outputs/codex-prep/images/generation-prompts.json`（全文）。本人の追加の希望「金融系アプリとして上質に」に合わせ、深いブルーと温かいアイボリーで統一 |
| ファイルの確認 | Codexの`assets-manifest.json`のSHA-256と、Claudeが写したファイルが8点とも一致（2026-11-07）。寸法・300KB以下・透過6点のアルファはCodexが検査 |
| 利用条件の確認 | Codexが2026-11-07にOpenAIの利用規約を確認：適用法の範囲で、出力の権利はユーザーとOpenAIの間ではユーザーに帰属。出力が他の利用者と似る可能性や、利用者の確認の責任も記載。全地域での著作権や独占性の保証ではない。公開リポジトリ・動画・表紙に使うことは、本人が準備した内容を確認してから |

## 方向修正：デザイン案02（2026-11-07）

本人から「イラスト中心の素材はAIらしさが強い。人物よりボタン・予約カード・金額を重視したい」という方向修正があり、Codexが画面のデザイン案02（`outputs/codex-prep/frontend-v2/`）を作った。Claudeは旧8点と案02を見比べ、案02を採用した。理由：本人の希望（AIらしさを抑え、判断に必要な日時・金額・ボタンを主役にする）に合う。人物・硬貨・紙のカレンダーのイラストは画面から外した。

案02の素材：写真風の架空の美容室1点（`salon-detail.webp`、900×600、OpenAIの内蔵の画像生成ツール、正確なモデル名と版は不明）と、コードで描いた18個のSVGアイコン（`ui-icons.svg`、生成画像ではない）。写真は店の補助表示だけに使う（トップページ、各画面の右列）。SHA-256はCodexの記録と一致。旧8点はCodexのフォルダに残し、アプリには入れない。

## Claude側の組み込み（旧8点、2026-11-07。案02の採用で置き換え済み）

- アプリで使う7点を`src/web/images/`へ写した（`cover.webp`は提出物用でアプリには入れない）。`src/web/art.ts`から読み込み、Viteが`/assets/`に出力する。サーバーの種類の表に`.webp`を加えた。
- トップページ：heroをPCでは説明の右、スマホでは説明の下に置く。三画面の見出し：立場ごとの人物（PC 88px、スマホ 60px）。振替のカード：承認待ちの間はswap、結果の確認中・保留・返金待ちなど未確定の間はchecking、案件の完了（COMPLETED）のときだけdone。
- すべて飾りとして`alt=""`・`aria-hidden`。意味は画面の文で伝える。寸法を指定し、カードの画像は遅延読み込み。画像がなくても画面は成り立つ。
