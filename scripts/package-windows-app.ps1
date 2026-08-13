<#
.SYNOPSIS
Build double-clickable shortcuts for `dsh web` into `dist-windows\`.

.DESCRIPTION
The Windows counterpart of `pnpm run package:mac`, and deliberately much
smaller: Windows needs no bundle to make a program launchable, so this writes
two shortcuts over `scripts\windows\start-web.ps1` — one that shows the session
and one that stops it — carrying the checked-in icon.

The launcher itself is a plain script that runs from a checkout without this
step, so packaging is a convenience rather than a prerequisite. Pin the
resulting `DSH.lnk` to the taskbar or copy it to the desktop.

.PARAMETER Out
Directory receiving the shortcuts. Defaults to `dist-windows` in the checkout.

.PARAMETER Name
Base name of the launch shortcut. Defaults to `DSH`.
#>
[CmdletBinding()]
param(
  [string] $Out,
  [string] $Name = 'DSH'
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Launcher = Join-Path $RepoRoot 'scripts\windows\start-web.ps1'
$Icon = Join-Path $RepoRoot 'assets\windows-app-icon.ico'
if (-not $Out) { $Out = Join-Path $RepoRoot 'dist-windows' }

foreach ($required in @($Launcher, $Icon)) {
  if (-not (Test-Path -LiteralPath $required)) { throw "missing $required" }
}

New-Item -ItemType Directory -Force -Path $Out | Out-Null
$OutPath = (Resolve-Path -LiteralPath $Out).Path

<#
.SYNOPSIS
Write one shortcut over the launcher.
.PARAMETER Path
Absolute `.lnk` path to create.
.PARAMETER Arguments
Launcher arguments, appended after the script path.
.PARAMETER Description
Shortcut comment shown in the shell.
#>
function New-LauncherShortcut {
  param(
    [Parameter(Mandatory = $true)][string] $Path,
    [Parameter(Mandatory = $true)][AllowEmptyString()][string] $Arguments,
    [Parameter(Mandatory = $true)][string] $Description
  )
  $shell = New-Object -ComObject WScript.Shell
  try {
    $shortcut = $shell.CreateShortcut($Path)
    # Windows PowerShell is present on every supported Windows; targeting it
    # rather than pwsh keeps the shortcut working without a separate install.
    $shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Launcher`"$Arguments"
    $shortcut.WorkingDirectory = $RepoRoot
    $shortcut.IconLocation = $Icon
    $shortcut.Description = $Description
    # 7 is minimized: the launcher has no console output worth showing, and the
    # session appears as the browser's own app window.
    $shortcut.WindowStyle = 7
    $shortcut.Save()
  } finally {
    [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($shell)
  }
}

$launchPath = Join-Path $OutPath "$Name.lnk"
$stopPath = Join-Path $OutPath "Stop $Name.lnk"
New-LauncherShortcut -Path $launchPath -Arguments '' -Description 'Start or show the dsh web session'
New-LauncherShortcut -Path $stopPath -Arguments ' -Stop' -Description 'Stop the dsh web session'

Write-Host "launcher : $Launcher"
Write-Host "icon     : $Icon"
Write-Host "start    : $launchPath"
Write-Host "stop     : $stopPath"
Write-Host ''
Write-Host "Verify the launcher before using the shortcuts:"
Write-Host "  powershell -NoProfile -ExecutionPolicy Bypass -File `"$Launcher`" -Check"
