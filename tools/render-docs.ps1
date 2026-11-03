param([switch]$Check)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$outputRoot = Join-Path $repoRoot 'outputs'
$docs = @('AGENTS', 'SPEC', 'STATUS', 'REVIEW', 'CLAUDE_START')
$labels = @{ AGENTS='共同作業ルール'; SPEC='仕様'; STATUS='進捗'; REVIEW='レビュー'; CLAUDE_START='Claudeへの依頼' }
$css = @'
:root{color-scheme:light;--ink:#182c3a;--muted:#526878;--accent:#006c76;--line:#d9e3e8;--paper:#fff;--wash:#eff4f6}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--wash);color:var(--ink);font-family:"Yu Gothic UI","Meiryo",system-ui,sans-serif;font-size:16px;line-height:1.85}
.top{background:#102f3e;color:white;padding:24px max(24px,calc((100vw - 1100px)/2));}.brand{font-size:24px;font-weight:750;letter-spacing:.04em}.subtitle{font-size:13px;color:#c5dce3;margin:4px 0 16px}nav{display:flex;gap:8px;flex-wrap:wrap}nav a{color:#e5f6f8;text-decoration:none;border:1px solid #547582;padding:5px 14px;border-radius:7px;font-size:14px}nav a[aria-current=page]{background:#e0f6f4;color:#123c43;border-color:#e0f6f4}
main{max-width:1100px;margin:28px auto 64px;background:var(--paper);border:1px solid var(--line);border-radius:12px;padding:36px 44px;box-shadow:0 6px 22px #16334b08;min-width:0}.meta{color:var(--muted);font-size:12px;border-bottom:1px solid var(--line);padding-bottom:16px;overflow-wrap:anywhere}h1{font-size:30px;line-height:1.45;margin:24px 0}h2{font-size:22px;border-left:4px solid var(--accent);padding:6px 0 6px 14px;margin:42px 0 18px}h3{font-size:18px;margin-top:28px}p,li{overflow-wrap:anywhere}p{margin:14px 0}a{color:var(--accent);text-underline-offset:3px}li{padding-left:3px;margin:8px 0}ul,ol{padding-left:26px}
.table-wrap{overflow-x:auto;margin:20px 0;border:1px solid var(--line);border-radius:7px}table{border-collapse:collapse;width:100%;min-width:640px;font-size:14px}th,td{padding:13px 16px;text-align:left;vertical-align:top;border-bottom:1px solid var(--line);overflow-wrap:anywhere}th{background:#eaf2f4;color:#204854;font-weight:700}tr:last-child td{border-bottom:0}tbody tr:nth-child(even){background:#f8fafb}code{font-family:Consolas,"Yu Gothic UI",monospace;font-size:.9em;background:#edf3f6;padding:2px 5px;border-radius:4px;overflow-wrap:anywhere}pre{padding:20px;background:#f0f5f7;border:1px solid var(--line);border-radius:8px;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.8}pre code{background:none;padding:0}blockquote{margin:20px 0;padding:10px 20px;border-left:4px solid #78abb4;background:#f3f8fa}footer{color:var(--muted);font-size:12px;margin-top:32px;padding-top:16px;border-top:1px solid var(--line)}
@media(max-width:700px){body{font-size:15px}.top{padding:20px 16px}main{margin:16px 10px 36px;padding:20px 17px;border-radius:8px}h1{font-size:24px}h2{font-size:19px;margin-top:32px}th,td{padding:10px 12px}nav a{font-size:12px;padding:5px 9px}pre{padding:13px}}
@media print{body{background:white}.top{background:white;color:#182c3a;padding:0}.subtitle,nav{display:none}main{border:0;box-shadow:none;max-width:none;margin:0;padding:12px 0}.table-wrap{overflow:visible}table{min-width:0;font-size:10px}h2,h3{break-after:avoid}tr{break-inside:avoid}a{color:inherit}}
'@
if (-not $Check) { [void][System.IO.Directory]::CreateDirectory($outputRoot) }
foreach ($doc in $docs) {
    $source = Join-Path $repoRoot "$doc.md"
    $markdown = [System.IO.File]::ReadAllText($source)
    $body = (ConvertFrom-Markdown -InputObject $markdown).Html
    $body = $body.Replace('<table>', '<div class="table-wrap"><table>').Replace('</table>', '</table></div>')
    $nav = ($docs | ForEach-Object {
        $current = if ($_ -eq $doc) { ' aria-current="page"' } else { '' }
        '<a href="' + $_ + '.html"' + $current + '>' + $labels[$_] + '</a>'
    }) -join ''
    $digest = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()
    $html = @"
<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="source-sha256" content="$digest"><title>FlexSlot | $($labels[$doc])</title><style>$css</style></head>
<body><header class="top"><div class="brand">FlexSlot</div><div class="subtitle">PayPal AI Hackathon · 開発引き継ぎ · 2026-11-03</div><nav aria-label="引き継ぎ文書">$nav</nav></header>
<main><div class="meta">正本：$doc.md / Markdownと同内容のHTML版</div><article>$body</article><footer>FlexSlot · ローカル開発資料。実装・接続・テストの状態はSTATUSを参照。</footer></main></body></html>
"@
    $target = Join-Path $outputRoot "$doc.html"
    if ($Check) {
        if (-not (Test-Path -LiteralPath $target)) { throw "Missing HTML: $doc" }
        if ([System.IO.File]::ReadAllText($target) -cne $html) { throw "HTML out of sync: $doc" }
        Write-Output "PASS: $doc.md -> outputs/$doc.html (same content, SHA256 $digest)"
    } else {
        [System.IO.File]::WriteAllText($target, $html, [System.Text.UTF8Encoding]::new($false))
        Write-Output "Generated outputs/$doc.html"
    }
}
