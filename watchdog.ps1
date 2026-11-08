# Keeps Claude Relay running in the background: starts the relay server and the Cloudflare Tunnel
# if either is not running. Run by the scheduled task "ClaudeRelay" at logon and every hour.
# Keep this file ASCII-only (Windows PowerShell 5.1 reads BOM-less UTF-8 as ANSI).
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
New-Item -ItemType Directory -Force data\logs | Out-Null
$log = Join-Path $PSScriptRoot 'data\logs\watchdog.log'
function Log($msg) { Add-Content -Path $log -Value ("{0:yyyy-MM-dd HH:mm:ss}  {1}" -f (Get-Date), $msg) }

$port = (Get-Content data\config.json -Raw | ConvertFrom-Json).port
if (-not $port) { $port = 8787 }
$cloudflared = Join-Path $PSScriptRoot 'bin\cloudflared.exe'

# Relay server: something must be listening on the port.
$listening = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if (-not $listening) {
    if (-not (Test-Path 'node_modules\@anthropic-ai\claude-agent-sdk')) { npm install *> data\logs\npm.log }
    $node = (Get-Command node).Source
    Start-Process -FilePath $node -ArgumentList 'server.mjs' -WorkingDirectory $PSScriptRoot -WindowStyle Hidden `
        -RedirectStandardOutput data\logs\server.log -RedirectStandardError data\logs\server.err.log
    Log "relay server was not running on port $port - started"
}

# Tunnel: our cloudflared.exe must be running.
$tunnel = Get-Process cloudflared -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $cloudflared }
if (-not $tunnel) {
    if (-not (Test-Path data\tunnel-token.txt)) { exit 0 }   # no tunnel configured yet: this computer only
    $token = (Get-Content data\tunnel-token.txt -Raw).Trim()
    Start-Process -FilePath $cloudflared -ArgumentList @('tunnel', '--no-autoupdate', 'run', '--token', $token) `
        -WorkingDirectory $PSScriptRoot -WindowStyle Hidden `
        -RedirectStandardOutput data\logs\tunnel.log -RedirectStandardError data\logs\tunnel.err.log
    Log 'tunnel was not running - started'
}
