# Remote Enter client for Windows. No installs needed - runs on built-in PowerShell.
# Set $Server to your Coolify URL, then run start.bat.

$Server = "https://your-app.example.com"

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms

# Keep the same ID across restarts so you only paste it into the web app once.
# Delete client-id.txt to generate a new one.
$IdFile = Join-Path $PSScriptRoot "client-id.txt"
if (Test-Path $IdFile) {
    $Id = (Get-Content $IdFile -Raw).Trim()
} else {
    $Id = [guid]::NewGuid().ToString("N") + [guid]::NewGuid().ToString("N")
    Set-Content -Path $IdFile -Value $Id -NoNewline
}

$Server = $Server.TrimEnd("/")
Write-Host ""
Write-Host "  Client ID: $Id" -ForegroundColor Cyan
Write-Host "  Open:      $Server/#$Id" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Enter will be sent to whichever window is focused. Ctrl+C to quit."
Write-Host ""

$connected = $false
while ($true) {
    try {
        $r = Invoke-RestMethod -Uri "$Server/api/poll?id=$Id" -TimeoutSec 30
        if (-not $connected) {
            Write-Host "[$(Get-Date -Format HH:mm:ss)] Connected" -ForegroundColor Green
            $connected = $true
        }
        for ($i = 0; $i -lt [int]$r.press; $i++) {
            [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
            Write-Host "[$(Get-Date -Format HH:mm:ss)] Pressed Enter"
        }
    } catch {
        if ($connected) {
            Write-Host "[$(Get-Date -Format HH:mm:ss)] Connection lost, retrying..." -ForegroundColor Yellow
            $connected = $false
        }
        Start-Sleep -Seconds 3
    }
}
