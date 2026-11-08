# Registers the scheduled task "ClaudeRelay": runs watchdog.ps1 at logon and every hour after that.
# Remove it with: Unregister-ScheduledTask -TaskName ClaudeRelay -Confirm:$false
$ErrorActionPreference = 'Stop'
$watchdog = Join-Path $PSScriptRoot 'watchdog.ps1'
$user = "$env:USERDOMAIN\$env:USERNAME"

# powershell.exe -WindowStyle Hidden still flashes a console for a moment (the window exists before PowerShell
# hides it). conhost.exe --headless gives PowerShell a console that never has a window, so nothing flashes.
$psArgs = "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$watchdog`""
$conhost = Join-Path $env:SystemRoot 'System32\conhost.exe'
if ([Environment]::OSVersion.Version.Build -ge 18362 -and (Test-Path $conhost)) {
    $action = New-ScheduledTaskAction -Execute $conhost -Argument "--headless powershell.exe $psArgs" -WorkingDirectory $PSScriptRoot
} else {
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $psArgs -WorkingDirectory $PSScriptRoot
}
$atLogon = New-ScheduledTaskTrigger -AtLogOn -User $user
$hourly = New-ScheduledTaskTrigger -Once -At (Get-Date).Date -RepetitionInterval (New-TimeSpan -Hours 1)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName 'ClaudeRelay' -Action $action -Trigger @($atLogon, $hourly) -Settings $settings `
    -Principal $principal -Description 'Claude Relay: keep relay server and Cloudflare Tunnel running' -Force | Out-Null
Write-Host 'Scheduled task ClaudeRelay registered (at logon + every hour).'
