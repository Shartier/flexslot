# FlexSlot — 画像の指示書（Codex向け、GPT Image）

**最新の依頼は末尾の節「画面イメージ案04（凝った版）・差し色テラコッタの素材」。** それより前の節（旧8点、案02、案03）は経緯の記録で、案03の3点の依頼は送らずに置き換えた。

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

## 画面イメージ案03・案1「上質サロン」の画像（2026-11-07。送らずに案04の依頼へ置き換え）

本人の進め方：先にHTMLで画面のイメージを固め、その後で画像をCodexに依頼する。Claudeが3つの方向のHTML案（`design/mockup-v3/index.html`）を作り、本人が**案1「上質サロン」**を選んだ。画像の場所・比率・大きさはHTML案の「画像枠」で決めてある（HTML案を開き、上の「デザイン」で案1、「画面」で部品一覧を選ぶと、枠の一覧が出る）。この節は、その枠の中身の依頼。

本人の希望のモデル：GPT Image 2.6（使えなければ2.5）。**実際に使ったモデル名と版は、ツールが返した値だけを記録する。** ツールが返さない場合は「不明」と書き、2.6とは書かない。

### 案1の画面の雰囲気（画像を合わせる先）

| 項目 | 値 |
| --- | --- |
| 背景 | 生成り色 #f6f1ea、カード #fffdfa |
| 文字・上段 | 焦げ茶 #2b2420 |
| 主色（ボタン） | 金茶のグラデーション #bd8f5e → #8a5c33、差し色 #e2c18f |
| 完了 | 落ち着いた緑 #3d7c5a |
| 見出し | 明朝体（Noto Serif JP）、本文はゴシック |
| 印象 | 小さく静かな、大人向けの日本の美容室。上質で落ち着いた午後の光。青い色味や派手な色は避ける |

### 作ってほしい画像

| 枠 | ファイル名 | 比率・サイズ | 使う場所 | 内容（プロンプトの下書き、英語） |
| --- | --- | --- | --- | --- |
| 画像枠1 | `salon-hero.webp` | 16:10、1600×1000 | トップページの見出しの横（PC）・下（スマホ）。角丸で表示、スマホでは幅約350px | Interior of a small, quiet, upscale Japanese hair salon in soft afternoon light. Warm ivory walls, dark walnut wood, brushed brass details, one styling chair facing a round mirror, a small green plant, a window with sheer curtains. Calm, premium and uncluttered, with simple areas around the edges. Photorealistic, natural light, gentle depth of field. No people, no text, no letters, no numbers, no logos, no brand names. |
| 画像枠2 | `salon-side.webp` | 3:2、1200×800 | お店・A・Bの画面の右列（PC）・下（スマホ）の店舗カード | A close detail of the same salon: a styling station with a brass-framed mirror, neatly arranged scissors and combs on a walnut shelf, a folded ivory towel, warm light from the side. Same colors and light as the interior. Photorealistic. No people, no text, no logos. |
| 画像枠3 | `service-cut.webp` | 1:1、800×800 | Bの予約券の小さな画像（表示は76px四方。小さくても形が分かること） | Still life of professional hair-cutting scissors and a fine comb resting on a folded ivory towel, brushed brass accents, soft shadow, warm neutral background, simple and centered so it reads at a small size. Photorealistic. No people, no hands, no faces, no text, no logos. |
| （任意） | `cover.webp` | 16:9、1280×720 | Devpostの表紙・YouTubeのサムネイルの土台（文字は後で別に入れる） | The same salon interior as salon-hero, wider, with a calm empty area on the left third for a title to be added later. No people, no text, no logos. |

### 全体の約束

- 画像の中に文字・数字・記号・ロゴを入れない。実在の会社・店・人物に似せない。人物は写さない（手も入れない）。
- 3点（＋任意の表紙）で、同じ店・同じ光・同じ配色に見えること。1点目を作った後、それを参照して残りを作る。
- 実在の美容室の写真に見えても、架空の店であることは画面の文で示す（画像に文字は入れない）。
- 形式はWebP。各300KB以下を目安（`salon-hero.webp`は400KBまで可）。元の生成画像も残す。
- 置き場所：`outputs/codex-prep/images-v3/`（Codexの作業場所）。Claudeが`src/web/images/`へ写して組み込む。Codexは`src/`を編集しない。
- 記録してほしいこと：使ったツール、ツールが返したモデル名と版（返さなければ「不明」）、生成日、最終プロンプトの全文、生成後の加工（縮小・変換だけか）、各ファイルの寸法・バイト数・SHA-256。旧8点・案02と同じ形の記録でよい。
- 公開リポジトリ・動画・表紙に使う前に、利用条件の確認結果も前回と同様に残す。

### Claude側の作業（並行）

画像を待つ間に、案1の配色・書体・ボタン・上段の見出し・言語の切り替えをアプリに組み込む。画像枠は、画像が届くまで案1の色の仮の面で表示し、届いたら差し替える。

## 画面イメージ案04（凝った版）・差し色テラコッタの素材（最新の依頼、2026-11-07）

経緯：本人の所見「緑とゴールド、ネイビーとゴールドもいまいち」「HTMLで一度に出した印象。軽いHTMLに見えない凝った作りにしたい（今回のハッカソンで特にこだわる点）」を受け、Claudeが凝った版のHTML案`design/mockup-v4/index.html`を作り、本人が差し色**B テラコッタ**を選んだ。HTML案を開き、上の「画面」で**素材一覧**を選ぶと、この節と同じ一覧が出る。今の写真は以前の美容室の画像を仮に使ったもので、この依頼の画像に差し替える。

本人の希望のモデル：GPT Image 2.6（使えなければ2.5）。**実際に使ったモデル名と版は、ツールが返した値だけを記録する。** 返さない場合は「不明」と書き、2.6とは書かない。

### 画面の雰囲気（画像を合わせる先）

| 項目 | 値 |
| --- | --- |
| 地の色 | 生成り #f3efe9、カード #fffdf9、グレージュの線 #d2c7b9 |
| 差し色（1色だけ） | テラコッタ #cb7552 → #9b4a2e |
| 文字・上段 | 墨に近い焦げ茶 #1c1917 |
| 写真の上に重ねる色 | 赤茶を帯びた暗い色（rgba(58,28,18,0.8)）を下から上へ薄く。写真の下側に白い文字が載る |
| 印象 | 小さく静かな、大人向けの日本の美容室。午後のやわらかい自然光。生成り・グレージュ・明るいオーク材・素焼き（テラコッタ）の小物。金色・青・緑の強い色は入れない |
| 写真の調子 | 雑誌の店舗写真のような、自然光・浅すぎない被写界深度・ごく弱いフィルムの粒子。どの写真も同じ店・同じ光・同じ色調に見えること |

### 作ってほしい素材

| 枠 | ファイル名 | 比率・サイズ | 使う場所 | 内容（プロンプトの下書き、英語） |
| --- | --- | --- | --- | --- |
| 画像1 | `salon-cover.webp` | 16:10、2400×1500 | トップの全面写真。左下に見出しと説明の白い文字が重なる | Wide interior photograph of a small, quiet, upscale Japanese hair salon in warm late-afternoon light. Limewashed greige walls, light oak wood, a single styling chair in soft clay-terracotta leather facing a large round mirror, a terracotta ceramic vase with dried pampas grass, linen curtains filtering the sun. The lower-left third is calm and even, with plain wall and floor, leaving room for a headline. 35mm lens, natural light, soft shadows, subtle film grain, editorial interior photography. No people, no hands, no text, no letters, no numbers, no logos, no brand names. |
| 画像2 | `salon-station.webp` | 3:2、1200×800 | お店・A・Bの画面の店舗カード（PCは右列、スマホは下） | Three-quarter view of the same salon's styling station: a round mirror with a thin oak rim, an oak shelf with neatly arranged scissors, a comb and a small terracotta ceramic cup, a folded ivory linen towel. Same light and palette as the interior. Editorial interior photography, subtle film grain. No people, no hands, no text, no logos. |
| 画像3 | `card-backdrop.webp` | 3:2、1600×1067 | A・Bの案内カード（「日時変更のお願い」「満席の時間のご案内」）の背景。上に暗い色と白い文字が重なる | Soft, low-contrast detail of the same salon: a limewashed greige wall with the shadow of a window frame and leaves, the edge of the terracotta chair at the right. The left two thirds are calm and even, suitable for white text over a dark terracotta-brown overlay. Natural light, subtle film grain. No people, no text, no logos. |
| 画像4 | `service-still.webp` | 1:1、800×800 | Bの予約券の小さな写真（表示は84px四方。小さくても形が分かること） | Still life of professional hair-cutting scissors and a fine comb on a folded ivory linen towel, beside a small terracotta ceramic dish, warm side light, soft shadow, greige background, centered and simple so it still reads at 84 pixels. Editorial product photography. No people, no hands, no text, no logos. |
| 画像5 | `done-backdrop.webp` | 3:2、1600×1067 | 完了の案内（「予約確定」「変更完了」、印章つき）の背景。右上に印章、下側に白い文字 | The same salon at the end of the day, tidied and calm: the chair turned slightly, a small fresh bouquet in the terracotta vase, warm low sunlight across the floor. Peaceful, finished feeling. Calm space at the bottom and top right. Natural light, subtle film grain. No people, no text, no logos. |
| 画像6 | `paper-texture.webp` | 512×512、継ぎ目なしで敷き詰められること | 画面全体の背景にうっすら敷く質感（今はコードで描いた粒子で代用） | Seamless tileable texture of fine warm-white handmade paper, washi-like, with very subtle fibers, low contrast, even lighting, no shadows, no visible edges or seams. Base tone close to #f3efe9. |
| （任意） | `cover.webp` | 16:9、1920×1080 | Devpostの表紙・動画のサムネイル（文字は後で別に入れる） | The same salon interior as salon-cover, wider, with a calm empty left third for a title to be added later. No people, no text, no logos. |

### 全体の約束

- 画像の中に文字・数字・記号・ロゴを入れない。実在の会社・店・人物に似せない。人物は写さない（手も入れない）。
- 画像1を先に作り、それを参照して残りを作る（同じ店・同じ光・同じ色調）。
- 印章（予約確定・変更完了・お支払い済み）、ロゴ、アイコン、罫線と番号、損益の帯グラフ、進み具合の線は**コードで描く**ので画像は不要。
- 形式はWebP。目安：写真は各400KB以下（`salon-cover.webp`と`cover.webp`は600KBまで）、質感は120KB以下。元の生成画像も残す。
- 置き場所：`outputs/codex-prep/images-v4/`（Codexの作業場所）。Claudeが`src/web/images/`へ写して組み込む。Codexは`src/`を編集しない。
- 記録してほしいこと：使ったツール、ツールが返したモデル名と版（返さなければ「不明」）、生成日、最終プロンプトの全文、生成後の加工（縮小・変換だけか）、各ファイルの寸法・バイト数・SHA-256、利用条件の確認結果。旧8点・案02と同じ形の記録でよい。

### Claude側の作業（並行）

画像を待つ間に、案04をアプリに組み込む。写真の枠には、画像が届くまで以前の美容室の画像を仮に入れ、届いたら`src/web/art.ts`で差し替える。

### 生成の記録（案04、Codexが記入、Claudeが転記）

| 項目 | 内容 |
| --- | --- |
| 使った機能 | OpenAIの内蔵の画像生成ツール`image_gen.imagegen`（Codex側）。戻り値は画像と出力のヒントだけで、**モデル名・版は不明**（GPT Image 2.6／2.5とは書かない） |
| 生成日 | 2026-11-07（日本時間） |
| 生成の方法 | `salon-cover`を先に生成し、残り6点はその原本を参照（紙の質感は色調だけ参照）。採用7点（任意の表紙を含む） |
| 生成後の加工 | SharpのLanczos3による拡大・縮小、比率を合わせる縁の微小な中央トリミング、WebP変換だけ。色補正・合成・修描・文字入れなし。生成原寸が指定より小さい4点（cover・card-backdrop・done-backdrop・表紙）は拡大しており、倍率はCodexの`assets-manifest.json`に記録 |
| 使ったプロンプト | Codexの`outputs/codex-prep/images-v4/generation-prompts.json`（全7件、参照原本の対応つき） |
| ファイルの確認 | アプリに入れた6点（`salon-cover`・`salon-station`・`card-backdrop`・`service-still`・`done-backdrop`・`paper-texture`）を`src/web/images/`へ写し、SHA-256がCodexの`SHA256SUMS.txt`と6点とも一致（2026-11-07）。`cover.webp`は提出用でアプリには入れない |
| 利用条件の確認 | Codexの`LICENSE_CHECK.md`：OpenAIの規約上、適用法の範囲で出力は利用者に帰属。公開・デモではAI生成であることを示す。全法域での権利の保証ではない。アプリの店舗カードと各画面の下部に「写真はAI生成で、実在の店舗ではありません」と表示 |
| 内容 | 人物・手・顔・文字・数字・ロゴなし。オーク・生成り・グレージュ・素焼きで統一し、真鍮は使わない（Codexの判断。依頼の正本どおり） |

### Claude側の組み込み（案04、2026-11-07）

- `src/web/art.ts`の`PHOTOS`を6点に差し替え（トップ・店舗カード・A/Bの依頼と案内・Bの予約券・完了）。以前の仮の写真（`salon-detail.webp`）はアプリから外した。
- 紙の質感はCodexが確かめた不透明度14%で画面全体に敷き詰め、これまでコードで描いていた粒子は外した（二重に重ねない）。
- Codexの参考指摘（案04のコピーで「お支払い済み」の印章が支払合計に重なる）：実アプリでも同じ位置だったため、印章を予約券の写真の上へ移し、生成りの円を背に置いた。PC幅（1360px）で印章と金額の矩形が重ならないことを確かめた。
