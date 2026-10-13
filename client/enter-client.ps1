# Remote Enter client for Windows. No installs needed - runs on built-in PowerShell.
# Set $Server to your Coolify URL, then run start.bat.
#
# Match detection only looks at the screen. Teach it once: when a match pops,
# hover the mouse over the ACCEPT button and press F8, then move the mouse away.
# After that it watches that spot and notifies the web app when the button appears.

$Server = "https://accept.krenarahmeti.com"

$Threshold = 0.90      # how closely the screen must match the saved button (0-1)
$ShowScores = $false   # set to $true to print the match score every second (for tuning)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Net.Http
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @"
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

public static class ScreenWatch {
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vKey);
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);

    public static bool KeyDown(int vk) { return (GetAsyncKeyState(vk) & 0x8000) != 0; }

    public static Bitmap Grab(int x, int y, int w, int h) {
        var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(bmp)) g.CopyFromScreen(x, y, 0, 0, new Size(w, h));
        return bmp;
    }

    // RGB bytes of the bitmap, row by row.
    public static byte[] Pixels(Bitmap bmp) {
        var data = bmp.LockBits(new Rectangle(0, 0, bmp.Width, bmp.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        var raw = new byte[data.Stride * bmp.Height];
        Marshal.Copy(data.Scan0, raw, 0, raw.Length);
        bmp.UnlockBits(data);
        var px = new byte[bmp.Width * bmp.Height * 3];
        int k = 0;
        for (int y = 0; y < bmp.Height; y++) {
            for (int x = 0; x < bmp.Width; x++) {
                int i = y * data.Stride + x * 4;
                px[k++] = raw[i]; px[k++] = raw[i + 1]; px[k++] = raw[i + 2];
            }
        }
        return px;
    }

    // Normalized cross-correlation: 1 = same picture, ~0 = unrelated.
    public static double Match(byte[] a, byte[] b) {
        if (a.Length != b.Length || a.Length == 0) return 0;
        double ma = 0, mb = 0;
        for (int i = 0; i < a.Length; i++) { ma += a[i]; mb += b[i]; }
        ma /= a.Length; mb /= b.Length;
        double sab = 0, saa = 0, sbb = 0;
        for (int i = 0; i < a.Length; i++) {
            double da = a[i] - ma, db = b[i] - mb;
            sab += da * db; saa += da * da; sbb += db * db;
        }
        if (saa < 1 || sbb < 1) return 0;
        return sab / Math.Sqrt(saa * sbb);
    }
}
"@

# Use real pixel coordinates even with display scaling (125%, 150%, ...).
[ScreenWatch]::SetProcessDPIAware() | Out-Null

function Log($msg, $color = "Gray") {
    Write-Host "[$(Get-Date -Format HH:mm:ss)] $msg" -ForegroundColor $color
}

# Keep the same ID across restarts so you only paste it into the web app once.
# Delete client-id.txt to generate a new one.
$IdFile = Join-Path $PSScriptRoot "client-id.txt"
if (Test-Path $IdFile) {
    $Id = (Get-Content $IdFile -Raw).Trim()
} else {
    $Id = [guid]::NewGuid().ToString("N") + [guid]::NewGuid().ToString("N")
    Set-Content -Path $IdFile -Value $Id -NoNewline
}

# Saved picture of the Accept button. Delete calibration.json to redo it (or just press F8 again).
$CalFile = Join-Path $PSScriptRoot "calibration.json"
$CalPng = Join-Path $PSScriptRoot "calibration.png"
$Cal = $null
if (Test-Path $CalFile) {
    $c = Get-Content $CalFile -Raw | ConvertFrom-Json
    $Cal = @{ X = [int]$c.x; Y = [int]$c.y; W = [int]$c.w; H = [int]$c.h; Pixels = [Convert]::FromBase64String($c.pixels) }
}

function Calibrate {
    $p = New-Object ScreenWatch+POINT
    [ScreenWatch]::GetCursorPos([ref]$p) | Out-Null
    $w = 80; $h = 30
    $x = $p.X - [int]($w / 2); $y = $p.Y - [int]($h / 2)

    # Wait so the button is captured without the mouse-hover highlight.
    Log "Got position ($($p.X), $($p.Y)). Move the mouse OFF the button now..." Yellow
    Start-Sleep -Seconds 2

    $bmp = [ScreenWatch]::Grab($x, $y, $w, $h)
    $px = [ScreenWatch]::Pixels($bmp)
    $bmp.Save($CalPng, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()

    @{ x = $x; y = $y; w = $w; h = $h; pixels = [Convert]::ToBase64String($px) } |
        ConvertTo-Json | Set-Content -Path $CalFile
    [console]::Beep(880, 150)
    Log "Saved. Check calibration.png - it should show the Accept button." Green
    return @{ X = $x; Y = $y; W = $w; H = $h; Pixels = $px }
}

$Server = $Server.TrimEnd("/")
Write-Host ""
Write-Host "  Client ID: $Id" -ForegroundColor Cyan
Write-Host "  Open:      $Server/#$Id" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Enter will be sent to whichever window is focused. Ctrl+C to quit."
if ($Cal) {
    Write-Host "  Watching for the Accept button. Press F8 on the button to re-teach it."
} else {
    Write-Host "  Not set up for match detection yet: next time a match pops," -ForegroundColor Yellow
    Write-Host "  hover the ACCEPT button and press F8." -ForegroundColor Yellow
}
Write-Host ""

$http = New-Object System.Net.Http.HttpClient
$http.Timeout = [TimeSpan]::FromSeconds(30)

$pollTask = $null
$nextPollAt = [DateTime]::MinValue
$connected = $false
$f8WasDown = $false
$nextCheckAt = [DateTime]::MinValue
$readyShown = $false
$goneChecks = 0

while ($true) {
    $now = [DateTime]::Now

    # --- Long-poll the server for Enter presses ---
    if (-not $pollTask -and $now -ge $nextPollAt) {
        $pollTask = $http.GetStringAsync("$Server/api/poll?id=$Id")
    }
    if ($pollTask -and $pollTask.IsCompleted) {
        if ($pollTask.IsFaulted -or $pollTask.IsCanceled) {
            if ($connected) { Log "Connection lost, retrying..." Yellow }
            $connected = $false
            $nextPollAt = $now.AddSeconds(3)
        } else {
            if (-not $connected) { Log "Connected" Green }
            $connected = $true
            $r = $pollTask.Result | ConvertFrom-Json
            for ($i = 0; $i -lt [int]$r.press; $i++) {
                [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
                Log "Pressed Enter"
            }
        }
        $pollTask = $null
    }

    # --- F8: teach the Accept button ---
    $f8Down = [ScreenWatch]::KeyDown(0x77)
    if ($f8Down -and -not $f8WasDown) {
        try { $Cal = Calibrate } catch { Log "Capture failed: $($_.Exception.Message)" Red }
    }
    $f8WasDown = $f8Down

    # --- Watch the screen for the Accept button ---
    if ($Cal -and $now -ge $nextCheckAt) {
        $nextCheckAt = $now.AddSeconds(1)
        try {
            $bmp = [ScreenWatch]::Grab($Cal.X, $Cal.Y, $Cal.W, $Cal.H)
            $score = [ScreenWatch]::Match($Cal.Pixels, [ScreenWatch]::Pixels($bmp))
            $bmp.Dispose()
            if ($ShowScores) { Log ("Match score: {0:N2}" -f $score) DarkGray }

            if ($score -ge $Threshold) { $goneChecks = 0 } else { $goneChecks++ }

            if ($score -ge $Threshold -and -not $readyShown) {
                $readyShown = $true
                Log ("Match ready! (score {0:N2}) Notifying..." -f $score) Green
                $body = New-Object System.Net.Http.StringContent("{`"id`":`"$Id`"}", [Text.Encoding]::UTF8, "application/json")
                $http.PostAsync("$Server/api/ready", $body) | Out-Null
            } elseif ($readyShown -and $goneChecks -ge 2) {
                # Button gone for 2s: the pop is over, so the next one notifies again.
                $readyShown = $false
                Log "Accept button gone"
            }
        } catch {
            # Screen can't be captured while Windows is locked; just try again.
        }
    }

    Start-Sleep -Milliseconds 100
}
