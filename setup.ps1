# Claude Relay - one-shot setup on Windows 10/11 (no admin rights needed).
#   git clone https://github.com/<you>/claude-relay.git ; cd claude-relay
#   powershell -ExecutionPolicy Bypass -File setup.ps1
# It installs the npm dependencies, downloads cloudflared, asks for your two addresses and the Cloudflare
# tunnel token, builds the "my computer" connector, registers autostart and starts the relay.
# Safe to run again (keeps your keys and data). Keep this file ASCII-only: Windows PowerShell 5.1 reads
# BOM-less UTF-8 as ANSI.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$CloudflaredVersion = '2026.10.6'
function Step($m) { Write-Host "`n== $m" -ForegroundColor Cyan }
function Save-Json($obj, $file) { [IO.File]::WriteAllText((Join-Path $PSScriptRoot $file), ($obj | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding $false)) }

Step 'Checking Node.js'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host 'Node.js is not installed. Run this, open a NEW PowerShell window, then run setup.ps1 again:' -ForegroundColor Yellow
    Write-Host '  winget install OpenJS.NodeJS.LTS'
    exit 1
}
$major = [int]((node --version).TrimStart('v').Split('.')[0])
if ($major -lt 20) { Write-Host "Node $(node --version) is too old; need 20 or newer (winget upgrade OpenJS.NodeJS.LTS)." -ForegroundColor Yellow; exit 1 }
Write-Host "  node $(node --version)"

Step 'Installing npm dependencies'
npm ci --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }

Step "Getting cloudflared $CloudflaredVersion"
$cf = Join-Path $PSScriptRoot 'bin\cloudflared.exe'
if (-not (Test-Path $cf)) {
    New-Item -ItemType Directory -Force bin | Out-Null
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -Uri "https://github.com/cloudflare/cloudflared/releases/download/$CloudflaredVersion/cloudflared-windows-amd64.exe" -OutFile $cf -UseBasicParsing
}
& $cf --version

Step 'Your addresses'
New-Item -ItemType Directory -Force data | Out-Null
$config = if (Test-Path data\config.json) { Get-Content data\config.json -Raw -Encoding UTF8 | ConvertFrom-Json } else { [pscustomobject]@{} }
$cur = $config.publicUrl
if (-not $cur -or $cur -like 'http://localhost*') {
    Write-Host 'The web address of your relay, e.g. https://claude.example.com (see README, step 2: Cloudflare).'
    $pub = (Read-Host 'Main address (Enter = only this computer, http://localhost)').Trim().TrimEnd('/')
    if ($pub) {
        if ($pub -notmatch '^https?://') { $pub = "https://$pub" }
        $u = [Uri]$pub
        $defPrev = "$($u.Scheme)://preview.$($u.Host -replace '^[^.]+\.', '')"
        $prev = (Read-Host "Preview address (Enter = $defPrev)").Trim().TrimEnd('/')
        if (-not $prev) { $prev = $defPrev }
        if ($prev -notmatch '^https?://') { $prev = "https://$prev" }
        $config | Add-Member -Force publicUrl $pub
        $config | Add-Member -Force previewUrl $prev
        Save-Json $config 'data\config.json'
    }
} else { Write-Host "  $cur (preview: $($config.previewUrl)) - edit data\config.json to change" }

if ($config.publicUrl -and $config.publicUrl -notlike 'http://localhost*' -and -not (Test-Path data\tunnel-token.txt)) {
    Write-Host 'Paste the token of your Cloudflare tunnel (the long eyJ... string; the whole "cloudflared service install eyJ..." command also works):' -ForegroundColor Yellow
    $t = ((Read-Host 'Tunnel token') -replace '.*service install\s+', '').Trim()
    if ($t) { Set-Content -Path data\tunnel-token.txt -Value $t -NoNewline }
}

Step 'Building the "my computer" connector (Mac + Windows programs, about 300 MB, takes a minute)'
try { node connector/build.mjs; if ($LASTEXITCODE -ne 0) { throw 'build failed' } }
catch { Write-Host "  skipped: $_ - run 'node connector/build.mjs' later to enable My computer" -ForegroundColor Yellow }

Step 'Checking Claude login'
if (-not (Test-Path (Join-Path $HOME '.claude\.credentials.json'))) {
    Write-Host 'Claude is not logged in on this PC. Run this, type /login, finish in the browser, then /exit:' -ForegroundColor Yellow
    Write-Host '  npx -y @anthropic-ai/claude-code'
    Write-Host 'The relay starts anyway; chats work as soon as you are logged in.'
} else { Write-Host '  logged in' }

Step 'Registering autostart (scheduled task ClaudeRelay) and starting'
& (Join-Path $PSScriptRoot 'install-autostart.ps1')
Start-ScheduledTask -TaskName ClaudeRelay
for ($i = 0; $i -lt 20 -and -not (Test-Path data\config.json); $i++) { Start-Sleep 1 }
Start-Sleep -Seconds 5
$config = Get-Content data\config.json -Raw -Encoding UTF8 | ConvertFrom-Json
if (Get-NetTCPConnection -LocalPort $config.port -State Listen -ErrorAction SilentlyContinue) { Write-Host '  relay is running' -ForegroundColor Green }
else { Write-Host '  relay not listening yet: see data\logs\server.err.log' -ForegroundColor Yellow }
Write-Host "`nManagement link (keep it to yourself, it is a password):" -ForegroundColor Green
Write-Host "  $($config.publicUrl)/?k=$($config.adminKey)"
Write-Host "On this computer:  http://localhost:$($config.port)/?k=$($config.adminKey)"
