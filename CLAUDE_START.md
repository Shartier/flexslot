# Claude Codeへの最初の依頼

次の文章を、同じPCのClaude Codeへ渡してください。モデルはClaude側のUIでOpus 5.5を選択し、この文章だけで切り替わったとは扱わないでください。

```text
FlexSlotの実装主担当をお願いします。作業フォルダは
C:\Users\ich30\Documents\Codex\2026-11-03\flexslot-paypal-ai-hackathon-web-codex
です。まずAGENTS.md、SPEC.md、STATUS.md、REVIEW.mdとGitの状態を読み、既存変更を保護してください。

一店舗・一担当者・二施術・A/B一組一回の補償付き振替を作ります。Codexは独立レビュー担当で、通常のコード修正はあなたに集約します。作品内AIはGoogle Cloudを希望し、Gemini on Vertex AIが第一候補です。PayPalはSandboxのみです。

最初の区切りでは、SPECの設計案を検証し、技術構成、DBの枠競合防止、三者の権限、Bの与信→売上確定→予約更新→A元決済への部分返金、および途中失敗の回復方法を具体化してください。AIとSandboxの既存設定は秘密値を表示せず必要範囲で確認し、実接続の検証手順を用意してください。

SPEC/STATUSを更新し、変更点・未確認事項・対象コミットSHAを報告して、Codexの第1レビューへ渡してください。この区切りでは本体実装やUI全体の作成を始めません。その後は最小接続検証から実装します。Markdownを作成・更新したら同内容のHTMLも生成してください。公開・デプロイ・応募は本人確認後です。
```

第1レビューで見るのは設計と検証計画。SandboxやGoogle Cloudの接続成功、アプリの完成を報告する段階ではありません。次の工程では実行したコマンド・結果・モードを残し、未実施を合格扱いしないでください。
