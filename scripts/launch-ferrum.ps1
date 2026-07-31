# What the desktop shortcut runs.
#
# Ferrum is a local engine plus a browser page, not a packaged desktop app, so "open Ferrum" means
# two things: make sure the engine is up, then point a browser at it. Doing that by hand means a
# terminal, a command, and remembering a port number — which is enough friction to make a tool feel
# like a project you maintain rather than a thing you use.
#
# The rules it follows:
#
#   NEVER start a second engine. Two engines on one database is how a SQLite file gets corrupted, and
#   the app already refuses to bind a taken port — but a launcher that tries anyway would leave the
#   user with a dead console and no page. If something is already answering, this just opens it.
#
#   NEVER leave a failure silent. The window is hidden, so a crash would otherwise look like a
#   shortcut that does nothing at all. Every exit path either opens the browser or says why it could
#   not, in a dialog, with the log.
#
#   The engine OUTLIVES this script. It is started as an independent process, so closing anything
#   this launcher owns does not take the engine down with it.
#
# Run by hand for diagnostics:
#   powershell -ExecutionPolicy Bypass -File scripts\launch-ferrum.ps1

$ErrorActionPreference = 'Stop'

$Root   = Split-Path -Parent $PSScriptRoot
$LogDir = Join-Path $env:LOCALAPPDATA 'ferrum'
# TWO files, deliberately. They were one, and the engine's stdout (appended by cmd) and this script's
# own lines (appended by PowerShell) raced on the same handle — the launcher's "opening the browser"
# line was simply lost, which made a successful launch look like a failed one in the log.
$LogFile    = Join-Path $LogDir 'launcher.log'
$EngineLog  = Join-Path $LogDir 'engine.log'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

# The engine log is truncated per launch rather than appended forever: it is a "why did it not start
# this time" file, and an unbounded one is both useless and permanently growing.
if (Test-Path $EngineLog) { Remove-Item $EngineLog -ErrorAction SilentlyContinue }

function Write-Log([string]$msg) {
    # Swallowing the error is the point, not laziness. With $ErrorActionPreference = 'Stop', a log
    # file held open by something else threw here, unwound into the catch, and put up a modal dialog
    # behind a hidden window — so the app silently refused to open because it could not write a line
    # about opening. Diagnostics must never be able to break the thing they are diagnosing.
    try {
        "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $msg" | Add-Content -Path $LogFile -Encoding utf8 -ErrorAction Stop
    } catch { }
}

function Show-Problem([string]$summary) {
    # A message box rather than a console write: the console is hidden, so a write would go nowhere.
    Add-Type -AssemblyName System.Windows.Forms
    # The ENGINE's log, not this script's. When a launch fails, what went wrong is almost always in
    # the engine's output — a missing node_modules, a port taken by something else, a corrupt
    # database — and showing only the launcher's own "starting..." line would tell nobody anything.
    $tail = if (Test-Path $EngineLog) { (Get-Content $EngineLog -Tail 15) -join "`n" } else { '(the engine produced no output)' }
    [System.Windows.Forms.MessageBox]::Show(
        "$summary`n`nEngine log: $EngineLog`nLauncher log: $LogFile`n`n$tail",
        'Ferrum could not start',
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Warning) | Out-Null
    exit 1
}

function Test-Port([int]$port) {
    # A connect attempt rather than Get-NetTCPConnection: this answers the question that actually
    # matters ("can I reach it") and needs no elevation.
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $wait = $client.BeginConnect('127.0.0.1', $port, $null, $null)
        if (-not $wait.AsyncWaitHandle.WaitOne(400)) { return $false }
        $client.EndConnect($wait)
        return $true
    } catch { return $false } finally { $client.Close() }
}

try {
    if (-not (Test-Path (Join-Path $Root 'package.json'))) {
        Show-Problem "Ferrum is not where this shortcut expects it:`n$Root`n`nIf you moved the project folder, re-create the shortcut."
    }

    # The port comes from .env when it is set there, so the shortcut cannot drift away from the
    # engine's actual configuration by hard-coding a number.
    $Port = 4317
    $envFile = Join-Path $Root '.env'
    if (Test-Path $envFile) {
        $line = Select-String -Path $envFile -Pattern '^\s*PORT\s*=\s*(\d+)' | Select-Object -First 1
        if ($line) { $Port = [int]$line.Matches[0].Groups[1].Value }
    }
    $Url = "http://127.0.0.1:$Port"

    if (Test-Port $Port) {
        Write-Log "Already running on $Port — opening $Url"
        Start-Process $Url
        exit 0
    }

    # The engine serves the built client from web/dist. Without it the page is a 404 and the app
    # looks broken rather than unbuilt, so build it once here instead.
    if (-not (Test-Path (Join-Path $Root 'web\dist\index.html'))) {
        Write-Log 'web/dist missing — building the client first (one time)'
        Push-Location $Root
        & cmd.exe /c "npm run web:build >> `"$EngineLog`" 2>&1"
        Pop-Location
        if (-not (Test-Path (Join-Path $Root 'web\dist\index.html'))) {
            Show-Problem 'The app could not be built. Node may not be installed, or `npm install` has not been run yet.'
        }
    }

    Write-Log "Starting the engine on $Port"
    # Through cmd so the redirection is cmd's job — PowerShell's own -RedirectStandardOutput cannot be
    # combined with -WindowStyle Hidden, and a visible console flashing up on every launch is exactly
    # the thing a shortcut is supposed to remove.
    Start-Process -FilePath 'cmd.exe' `
                  -ArgumentList '/c', "npm start >> `"$EngineLog`" 2>&1" `
                  -WorkingDirectory $Root `
                  -WindowStyle Hidden

    # Wait for it to actually answer rather than sleeping a fixed guess: a cold start compiles
    # TypeScript and can take several seconds, and opening the browser too early shows a refused
    # connection the user then has to reload past.
    $deadline = (Get-Date).AddSeconds(45)
    while ((Get-Date) -lt $deadline) {
        if (Test-Port $Port) {
            Write-Log "Up on $Port — opening $Url"
            Start-Process $Url
            exit 0
        }
        Start-Sleep -Milliseconds 400
    }

    Show-Problem "The engine did not come up on port $Port within 45 seconds."
}
catch {
    Write-Log "FAILED: $_"
    Show-Problem "Something went wrong starting Ferrum.`n`n$_"
}
