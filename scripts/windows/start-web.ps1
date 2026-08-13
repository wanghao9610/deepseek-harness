<#
.SYNOPSIS
Start `dsh web` and show it in a dedicated browser window, or bring the window
of a session already running to the front.

.DESCRIPTION
The counterpart of the macOS bundle (docs/development.md), built around one
difference: Windows has no scripting interface for browser tabs, so this
launcher asks a Chromium-family browser for an app window (`--app=`) instead.
That window carries its own taskbar button, which makes Alt-Tab reach the
session directly and removes any need to hunt for a tab.

The launcher does not stay resident. It starts the server detached, waits for
the URL line, shows the window, and exits; `-Stop` ends that server. Run it
directly from a checkout — no packaging step is required — and use `-Check` to
print what it resolves without starting anything.

.PARAMETER Stop
Stop the running server instead of starting or showing one.

.PARAMETER Check
Print the resolved Node binary, entry, server state, browser, and window, then
exit without starting or stopping anything.

.PARAMETER Node
Node binary to run the entry under. Defaults to `node` on PATH.
#>
[CmdletBinding()]
param(
  [switch] $Stop,
  [switch] $Check,
  [string] $Node
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

# The repository root, two levels above this script, so a checkout runs without
# a packaging step and a moved checkout stays correct.
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Entry = Join-Path $RepoRoot 'apps\cli\lib\bin.js'
$Url = 'http://127.0.0.1:3080'
# Every session's document title ends in this; the leading part is the session
# name, so the window is matched by suffix and never by equality.
$WindowTitleSuffix = 'DeepSeek Harness'
$LogDir = Join-Path $env:LOCALAPPDATA 'DSH'
$Log = Join-Path $LogDir 'web.log'
$ErrorLog = Join-Path $LogDir 'web.err.log'

Add-Type -Namespace DshNative -Name Win32 -MemberDefinition @'
[DllImport("user32.dll")]
public static extern bool SetForegroundWindow(IntPtr handle);
[DllImport("user32.dll")]
public static extern bool ShowWindow(IntPtr handle, int command);
[DllImport("user32.dll")]
public static extern bool IsWindowVisible(IntPtr handle);
[DllImport("user32.dll", CharSet = CharSet.Unicode)]
public static extern int GetWindowTextW(IntPtr handle, System.Text.StringBuilder text, int count);
[DllImport("user32.dll", CharSet = CharSet.Unicode)]
public static extern int GetWindowTextLengthW(IntPtr handle);
public delegate bool EnumProc(IntPtr handle, IntPtr parameter);
[DllImport("user32.dll")]
public static extern bool EnumWindows(EnumProc callback, IntPtr parameter);
'@

<#
.SYNOPSIS
Find the visible top-level window whose title ends with the session suffix.
.OUTPUTS
The window handle, or [IntPtr]::Zero when no window matches.
#>
function Find-SessionWindow {
  $found = [IntPtr]::Zero
  $callback = [DshNative.Win32+EnumProc] {
    param([IntPtr] $handle, [IntPtr] $parameter)
    if (-not [DshNative.Win32]::IsWindowVisible($handle)) { return $true }
    $length = [DshNative.Win32]::GetWindowTextLengthW($handle)
    if ($length -le 0) { return $true }
    $buffer = New-Object System.Text.StringBuilder -ArgumentList ($length + 1)
    [void][DshNative.Win32]::GetWindowTextW($handle, $buffer, $buffer.Capacity)
    # Contains, not equality or suffix: the title is `<session> — DeepSeek
    # Harness` while a session is named and the bare suffix before that, and a
    # browser may decorate it further.
    if ($buffer.ToString().Contains($script:WindowTitleSuffix)) {
      $script:foundWindow = $handle
      return $false
    }
    return $true
  }
  $script:foundWindow = $found
  [void][DshNative.Win32]::EnumWindows($callback, [IntPtr]::Zero)
  return $script:foundWindow
}

<#
.SYNOPSIS
Bring a window to the front, restoring it when minimized.
.PARAMETER Handle
The window to raise.
#>
function Show-Window {
  param([IntPtr] $Handle)
  # 9 is SW_RESTORE: a minimized window ignores SetForegroundWindow alone.
  [void][DshNative.Win32]::ShowWindow($Handle, 9)
  [void][DshNative.Win32]::SetForegroundWindow($Handle)
}

<#
.SYNOPSIS
Resolve the browser that opens app windows, preferring the user's default.
.OUTPUTS
The browser executable path, or $null when no Chromium-family browser is found.
#>
function Get-AppWindowBrowser {
  # Chromium forks share the --app= flag; Firefox has no equivalent and is not
  # a candidate, so its default falls through to an ordinary tab.
  $chromiumProgIds = @('ChromeHTML', 'MSEdgeHTM', 'BraveHTML', 'VivaldiHTM', 'ChromiumHTM')
  $userChoice = 'HKCU:\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice'
  $candidates = New-Object System.Collections.Generic.List[string]
  try {
    $progId = (Get-ItemProperty -Path $userChoice -Name ProgId -ErrorAction Stop).ProgId
    if ($chromiumProgIds -contains $progId) { $candidates.Add($progId) }
  } catch {
    # No recorded default association; the ordered fallbacks below still apply.
  }
  foreach ($progId in $chromiumProgIds) {
    if (-not $candidates.Contains($progId)) { $candidates.Add($progId) }
  }
  foreach ($progId in $candidates) {
    try {
      $command = (Get-ItemProperty -Path "Registry::HKEY_CLASSES_ROOT\$progId\shell\open\command" -Name '(default)' -ErrorAction Stop).'(default)'
    } catch {
      continue
    }
    # The command is `"C:\...\chrome.exe" -- "%1"`; take the quoted program.
    if ($command -match '^\s*"([^"]+)"') {
      $path = $Matches[1]
      if (Test-Path -LiteralPath $path) { return $path }
    }
  }
  return $null
}

<#
.SYNOPSIS
Report whether the local server answers.
.OUTPUTS
$true when the URL responds.
#>
function Test-Server {
  try {
    $client = New-Object System.Net.Sockets.TcpClient
    $connect = $client.BeginConnect('127.0.0.1', 3080, $null, $null)
    $ok = $connect.AsyncWaitHandle.WaitOne(1000, $false)
    if ($ok) { $client.EndConnect($connect) }
    $client.Close()
    return $ok
  } catch {
    return $false
  }
}

<#
.SYNOPSIS
Find the running server process started from this checkout's entry.
.OUTPUTS
The process object, or $null when none is running.
#>
function Get-ServerProcess {
  # Matched on the command line rather than the image name: an unrelated Node
  # process must not be stopped, and a second checkout has its own entry path.
  # String containment, not -like, because a Windows path's backslashes and any
  # bracket in it are wildcard syntax to the operator.
  return Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine.Contains($Entry) } |
    Select-Object -First 1
}

<#
.SYNOPSIS
Resolve the Node binary the entry runs under.
.OUTPUTS
The executable path.
#>
function Resolve-Node {
  if ($Node) {
    if (-not (Test-Path -LiteralPath $Node)) { throw "-Node $Node does not exist" }
    return (Resolve-Path -LiteralPath $Node).Path
  }
  $command = Get-Command node -CommandType Application -ErrorAction SilentlyContinue
  if (-not $command) { throw 'no node.exe on PATH; install Node or pass -Node <path>' }
  return $command.Source
}

<#
.SYNOPSIS
Report a failure where a hidden launcher can still be seen.
.PARAMETER Message
The text to show.
#>
function Show-Failure {
  param([Parameter(Mandatory = $true)][string] $Message)
  Write-Host $Message
  # The shortcut runs this script with no console, so a written message reaches
  # nobody; the dialog is the only channel a double-click has.
  try {
    Add-Type -AssemblyName PresentationFramework
    [void][System.Windows.MessageBox]::Show($Message, 'DSH')
  } catch {
    # No desktop or no WPF assembly: the console line above is then the report.
  }
}

try {

if ($Stop) {
  $server = Get-ServerProcess
  if (-not $server) {
    Write-Host 'dsh web: not running'
    exit 0
  }
  Stop-Process -Id $server.ProcessId -Force
  Write-Host "dsh web: stopped (pid $($server.ProcessId))"
  exit 0
}

if ($Check) {
  Write-Host "repo root : $RepoRoot"
  Write-Host "entry     : $Entry ($(if (Test-Path -LiteralPath $Entry) { 'present' } else { 'MISSING — run pnpm run build' }))"
  try { Write-Host "node      : $(Resolve-Node)" } catch { Write-Host "node      : $_" }
  Write-Host "log       : $Log"
  Write-Host "server    : $(if (Test-Server) { 'answering' } else { 'not answering' })"
  $server = Get-ServerProcess
  Write-Host "process   : $(if ($server) { "pid $($server.ProcessId)" } else { 'none' })"
  $browser = Get-AppWindowBrowser
  Write-Host "browser   : $(if ($browser) { $browser } else { 'no Chromium-family browser — will open an ordinary tab' })"
  $window = Find-SessionWindow
  Write-Host "window    : $(if ($window -ne [IntPtr]::Zero) { "found (handle $window)" } else { "none titled '*$WindowTitleSuffix'" })"
  exit 0
}

# A session already running owns the port; this run is only here to surface it.
if (Test-Server) {
  $window = Find-SessionWindow
  if ($window -ne [IntPtr]::Zero) {
    Show-Window $window
    exit 0
  }
  # Serving with no window: the user closed it, so open a new one below.
} else {
  if (-not (Test-Path -LiteralPath $Entry)) {
    throw "missing $Entry — run 'pnpm run build' in $RepoRoot first"
  }
  $nodePath = Resolve-Node
  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
  Set-Content -LiteralPath $Log -Value '' -Encoding UTF8
  # One pre-quoted argument string, because Start-Process joins an argument
  # array on spaces without quoting and a checkout path may contain one.
  # -NoNewWindow rather than -WindowStyle, which redirection cannot combine
  # with; the launcher itself already runs without a visible console.
  Start-Process -FilePath $nodePath -ArgumentList "`"$Entry`" web" `
    -WorkingDirectory $HOME -NoNewWindow `
    -RedirectStandardOutput $Log -RedirectStandardError $ErrorLog | Out-Null

  # The URL line is the readiness signal: the web bundle prints it only after
  # its Loader tree settles, so a sibling failure never opens a dead window.
  $deadline = (Get-Date).AddSeconds(60)
  $ready = $false
  while ((Get-Date) -lt $deadline) {
    if ((Test-Path -LiteralPath $Log) -and ((Get-Content -LiteralPath $Log -Raw -ErrorAction SilentlyContinue) -match 'dsh web: (\S+)')) {
      $Url = $Matches[1]
      $ready = $true
      break
    }
    Start-Sleep -Milliseconds 200
  }
  if (-not $ready) { throw "dsh web did not start within 60s; see $Log and $ErrorLog" }
}

$browser = Get-AppWindowBrowser
if ($browser) {
  Start-Process -FilePath $browser -ArgumentList "--app=$Url" | Out-Null
} else {
  Start-Process $Url | Out-Null
}

} catch {
  Show-Failure "$_"
  exit 1
}
