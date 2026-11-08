# Runs Claude Relay in this window (foreground): the relay server and, if data\tunnel-token.txt exists,
# the Cloudflare Tunnel (your domain -> localhost:8787). Close the window to stop. For everyday use the
# scheduled task from setup.ps1 / install-autostart.ps1 runs it in the background instead.
# Keep this file ASCII-only: Windows PowerShell 5.1 reads BOM-less UTF-8 as ANSI.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
New-Item -ItemType Directory -Force data | Out-Null
if (-not (Test-Path 'node_modules\@anthropic-ai\claude-agent-sdk')) { Write-Host 'Installing dependencies (first run)...' -ForegroundColor Yellow; npm install }

$server = Start-Process node -ArgumentList 'server.mjs' -NoNewWindow -PassThru
try {
    if (Test-Path data\tunnel-token.txt) {
        $token = (Get-Content data\tunnel-token.txt -Raw).Trim()
        & .\bin\cloudflared.exe tunnel --no-autoupdate run --token $token
    } else {
        Write-Host 'No data\tunnel-token.txt: running on this computer only (see README to put it online). Ctrl+C to stop.' -ForegroundColor Yellow
        Wait-Process -Id $server.Id
    }
} finally {
    Stop-Process -Id $server.Id -ErrorAction SilentlyContinue
}
