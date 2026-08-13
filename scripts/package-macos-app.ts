/**
 * Build a double-clickable macOS `.app` (and a `.dmg` holding it) that starts
 * `dsh web` and opens the browser at the URL the app prints.
 *
 * The bundle is unsigned and NOT self-contained: its launcher runs this
 * checkout's built `apps/cli/lib/bin.js` under the Node binary resolved at
 * build time. Both paths are baked in, so moving the checkout or removing that
 * Node installation breaks an already-built bundle — rebuild it. Gatekeeper
 * does not intercept a locally built bundle; a bundle copied through the DMG to
 * another machine carries a quarantine flag, cleared with
 * `xattr -dr com.apple.quarantine <app>`.
 *
 * Usage: `pnpm run package:mac [-- --no-dmg] [--out <dir>] [--name <AppName>]
 * [--node <path>] [--icon <path.icns|path.png>]`
 */

import { spawnSync } from 'node:child_process'
import { chmod, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, delimiter, extname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const root = resolve(import.meta.dirname, '..')

/** Built launcher the bundle runs; absent until `pnpm run build`. */
const CLI_ENTRY = 'apps/cli/lib/bin.js'
/** Built frontend the web bundle resolves through `@deepseek-ai/dsh-web-frontend`. */
const FRONTEND_ENTRY = 'apps/web/dist/index.html'
/** Manifest the bundle's version fields are read from. */
const CLI_MANIFEST = 'apps/cli/package.json'
/** Where the bundle and disk image land when `--out` is omitted. */
const DEFAULT_OUTPUT = 'dist-macos'
/** Bundle name (without `.app`) when `--name` is omitted. */
const DEFAULT_APP_NAME = 'DSH'
/**
 * Icon artwork used when `--icon` is omitted: the harness whale on the Big Sur
 * icon grid. Rendered from the `.svg` beside it, and committed because
 * `sips`/`iconutil` read PNG but no macOS system tool rasterizes SVG.
 */
const DEFAULT_ICON = 'assets/macos-app-icon.png'
/** Reverse-DNS bundle id; unsigned, so it only has to be stable and unique. */
const BUNDLE_ID = 'ai.deepseek.dsh.web'
/** The bundle executable's filename, which is also the app's process name. */
const EXECUTABLE_NAME = 'dsh-web'
/** The launch script, run by the executable from `Contents/Resources`. */
const SCRIPT_NAME = 'start-web'
/**
 * Browsers sharing Chrome's scripting dictionary, asked in this order for a tab
 * already showing the app. Safari has its own dictionary and its own script;
 * Firefox exposes no tab API at all and only ever gets a fresh tab.
 *
 * Bundle ids, never display names: naming an application that is not installed
 * sends AppleScript looking for it and blocks on a chooser dialog, while an
 * absent bundle id fails immediately.
 */
const CHROMIUM_BROWSER_IDS = [
  'com.google.Chrome',
  'com.microsoft.edgemac',
  'com.brave.Browser',
  'com.vivaldi.Vivaldi',
  'org.chromium.Chromium',
]
/** The URL `dsh web` serves when no `--port` is given. */
const DEFAULT_URL = 'http://127.0.0.1:3080'
/** Icon sizes an `.icns` carries; each is emitted at 1x and 2x. */
const ICON_SIZES = [16, 32, 128, 256, 512]

/** Stands in for one `'` inside a single-quoted shell string: close, escape, reopen. */
const SHELL_QUOTE_ESCAPE = String.raw`'\''`

/**
 * Quote a value for safe interpolation into the generated shell launcher.
 * @param value - the raw string.
 * @returns the single-quoted form.
 */
function shellQuote(value: string): string {
  return `'${value.replaceAll('\'', SHELL_QUOTE_ESCAPE)}'`
}

/**
 * Escape a value for a plist `<string>` body.
 * @param value - the raw string.
 * @returns the escaped form.
 */
function plistEscape(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/**
 * Run a build tool, failing loud with its captured output.
 * @param command - executable name.
 * @param args - arguments, verbatim.
 */
function run(command: string, args: readonly string[]): void {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} exited ${String(result.status)}\n${result.stdout}${result.stderr}`)
  }
}

/**
 * The Node path to bake into the launcher: a `PATH` entry that resolves to the
 * running binary, falling back to that binary's own location.
 *
 * `process.execPath` is already resolved through its symlinks, so under
 * Homebrew or a version manager it names a version-stamped directory that the
 * next upgrade deletes — leaving a bundle that dies before it can report why.
 * The `PATH` alias survives that upgrade. It can then point at a different
 * Node major, whose ABI a previously installed `node-pty` will not match, but
 * that failure is loud and `pnpm install` fixes it, while the deleted path is
 * silent. `--node` pins an exact binary instead.
 * @returns the absolute Node path.
 */
function stableNodePath(): string {
  const real = realpathSync(process.execPath)
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (directory === '') continue
    const candidate = join(directory, 'node')
    try {
      if (realpathSync(candidate) === real) return candidate
    } catch {
      // A PATH entry need not exist or hold a `node`; the next candidate decides.
    }
  }
  return process.execPath
}

/**
 * Refresh the LaunchServices record for a rebuilt bundle, which is otherwise
 * served from its cached `Info.plist` at the same path. Best effort: a stale
 * Finder name or icon does not make the bundle less runnable, and the support
 * tool's location is not a documented interface.
 * @param appPath - the built `.app`.
 */
function registerBundle(appPath: string): void {
  const lsregister = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
  const result = spawnSync(lsregister, ['-f', appPath], { encoding: 'utf8' })
  if (result.error !== undefined || result.status !== 0) {
    console.warn(`warning: could not refresh the LaunchServices record for ${appPath}`)
  }
}

/**
 * The bundle's `Info.plist`.
 * @param appName - bundle name without the `.app` suffix.
 * @param version - version string for both version fields.
 * @param agent - mark the bundle as an agent, which has no Dock tile.
 * @returns the plist document.
 */
function infoPlist(appName: string, version: string, agent: boolean): string {
  const entries: [string, string][] = [
    ['CFBundleName', appName],
    ['CFBundleDisplayName', appName],
    ['CFBundleIdentifier', BUNDLE_ID],
    ['CFBundleExecutable', EXECUTABLE_NAME],
    ['CFBundlePackageType', 'APPL'],
    ['CFBundleInfoDictionaryVersion', '6.0'],
    ['CFBundleVersion', version],
    ['CFBundleShortVersionString', version],
    ['LSMinimumSystemVersion', '13.0'],
    ['CFBundleIconFile', 'icon'],
  ]
  const body = entries
    .map(([key, value]) => `  <key>${key}</key>\n  <string>${plistEscape(value)}</string>`)
    .join('\n')
  const agentEntry = agent ? '  <key>LSUIElement</key>\n  <true/>\n' : ''
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${body}
${agentEntry}  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
`
}

/**
 * The launch script: reuse an already-serving instance, otherwise start
 * `dsh web`, open the URL it prints, and stay in the foreground for as long as
 * the server runs, so whoever supervises it can stop the server by stopping it.
 *
 * Finder launches inherit neither the login shell's `PATH` nor its working
 * directory, so the Node binary and the entry are absolute and the launcher
 * moves to the home directory before starting. Bash 3.2 is the system shell —
 * the script stays within it.
 * @param nodePath - absolute Node binary the entry runs under.
 * @param appName - bundle name, used in the failure alert and log path.
 * @returns the launcher script.
 */
function launcherScript(nodePath: string, appName: string): string {
  return `#!/bin/bash
# Generated by scripts/package-macos-app.ts — edits are overwritten.
set -uo pipefail

NODE=${shellQuote(nodePath)}
ENTRY=${shellQuote(join(root, CLI_ENTRY))}
URL=${shellQuote(DEFAULT_URL)}
APP=${shellQuote(appName)}
LOG_DIR="$HOME/Library/Logs/$APP"
LOG="$LOG_DIR/web.log"

alert() {
  /usr/bin/osascript -e "display alert \\"$APP\\" message \\"$1\\" as critical" >/dev/null 2>&1 || true
}

# Resolved from this script's own location, so the bundle stays movable: the
# path holds in both layouts, whether the script sits in Resources beside the
# helpers or in MacOS as the executable itself.
RESOURCES="$(cd "$(dirname "$0")/../Resources" && pwd)"
CHROMIUM_BROWSER_IDS=(${CHROMIUM_BROWSER_IDS.map(shellQuote).join(' ')})

# Raise the tab already showing the app instead of stacking up new ones. Only
# browsers that are already running are asked, so this never starts one, and an
# unmatched URL falls through to a fresh tab in the default browser.
focus_or_open() {
  local target="$1"
  local browser
  for browser in "\${CHROMIUM_BROWSER_IDS[@]}"; do
    if /usr/bin/osascript "$RESOURCES/focus-chromium.applescript" "$browser" "$target" 2>/dev/null | /usr/bin/grep -q '^focused$'; then
      return 0
    fi
  done
  if /usr/bin/osascript "$RESOURCES/focus-safari.applescript" "$target" 2>/dev/null | /usr/bin/grep -q '^focused$'; then
    return 0
  fi
  /usr/bin/open "$target"
}

mkdir -p "$LOG_DIR"
cd "$HOME" || exit 1

# An instance already serving owns the port; this run is only here to surface it.
if /usr/bin/curl -fsS --max-time 1 -o /dev/null "$URL"; then
  focus_or_open "$URL"
  exit 0
fi

if [ ! -x "$NODE" ]; then
  alert "No Node binary at $NODE. Reinstall Node, or rebuild this app with 'pnpm run package:mac'."
  exit 1
fi

if [ ! -f "$ENTRY" ]; then
  alert "Missing $ENTRY. Run 'pnpm run build' in the checkout, then rebuild this app."
  exit 1
fi

: > "$LOG"
"$NODE" "$ENTRY" web >>"$LOG" 2>&1 &
child=$!
trap 'kill "$child" 2>/dev/null; wait "$child" 2>/dev/null; exit 0' TERM INT

# The URL line is the readiness signal: the bundle prints it only after its
# Loader tree settles, so a sibling failure never opens a tab on a dead app.
url=""
attempt=0
while [ "$attempt" -lt 600 ]; do
  if ! kill -0 "$child" 2>/dev/null; then break; fi
  line=$(/usr/bin/grep -m1 -o 'dsh web: [^ ]*' "$LOG" 2>/dev/null)
  if [ -n "$line" ]; then url="\${line#dsh web: }"; break; fi
  sleep 0.1
  attempt=$((attempt + 1))
done

if [ -z "$url" ]; then
  alert "dsh web did not start. See $LOG"
  wait "$child" 2>/dev/null
  exit 1
fi

focus_or_open "$url"
wait "$child"
`
}

/**
 * AppleScript that focuses an existing tab in a Chromium-family browser.
 *
 * Only a browser that is already running is asked: a `tell` block otherwise
 * launches it, and a Dock click must not start a browser the user had closed.
 * The `using terms from` block compiles against Chrome's dictionary but runs
 * against whichever browser was addressed, so a machine without Chrome fails to
 * compile this script — the caller treats that like any other miss.
 * @returns the AppleScript source, taking the browser bundle id and URL prefix.
 */
function chromiumFocusScript(): string {
  return `on run argv
\tset browserId to item 1 of argv
\tset prefix to item 2 of argv
\ttry
\t\tif not (application id browserId is running) then return "none"
\ton error
\t\treturn "none"
\tend try
\ttell application id browserId
\t\tusing terms from application "Google Chrome"
\t\t\trepeat with theWindow in windows
\t\t\t\tset tabIndex to 0
\t\t\t\trepeat with theTab in tabs of theWindow
\t\t\t\t\tset tabIndex to tabIndex + 1
\t\t\t\t\ttry
\t\t\t\t\t\tif (URL of theTab as text) starts with prefix then
\t\t\t\t\t\t\tset active tab index of theWindow to tabIndex
\t\t\t\t\t\t\tset index of theWindow to 1
\t\t\t\t\t\t\tactivate
\t\t\t\t\t\t\treturn "focused"
\t\t\t\t\t\tend if
\t\t\t\t\tend try
\t\t\t\tend repeat
\t\t\tend repeat
\t\tend using terms from
\tend tell
\treturn "none"
end run
`
}

/**
 * AppleScript that focuses an existing Safari tab.
 *
 * A blank tab carries no URL, so each comparison is guarded rather than the
 * loop: one unreadable tab must not end the search.
 * @returns the AppleScript source, taking the URL prefix.
 */
function safariFocusScript(): string {
  return `on run argv
\tset prefix to item 1 of argv
\tif not (application id "com.apple.Safari" is running) then return "none"
\ttell application id "com.apple.Safari"
\t\trepeat with theWindow in windows
\t\t\trepeat with theTab in tabs of theWindow
\t\t\t\ttry
\t\t\t\t\tif (URL of theTab as text) starts with prefix then
\t\t\t\t\t\tset current tab of theWindow to theTab
\t\t\t\t\t\tset index of theWindow to 1
\t\t\t\t\t\tactivate
\t\t\t\t\t\treturn "focused"
\t\t\t\t\tend if
\t\t\t\tend try
\t\t\tend repeat
\t\tend repeat
\tend tell
\treturn "none"
end run
`
}

/**
 * The bundle executable: a Cocoa shim that runs the launch script.
 *
 * LaunchServices bounces the Dock tile until the bundle executable checks in
 * with the window server, and reports a launch timeout when it never does. A
 * shell script cannot check in — only a process that starts an `NSApplication`
 * can — so the script runs as this shim's child instead of as the executable
 * itself. The shim also gives the app the lifetime a Dock tile implies: Quit
 * reaches the script, and the app exits on its own when the script does.
 * @returns the Swift source, which must be compiled as `main.swift`.
 */
function shimSource(): string {
  return `import AppKit

/// Runs the bundle's launch script and ties the app's lifetime to it.
final class LauncherDelegate: NSObject, NSApplicationDelegate {
  private let script: String
  private var child: Process?

  init(script: String) {
    self.script = script
  }

  private func spawn() throws -> Process {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/bash")
    process.arguments = [script]
    try process.run()
    return process
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    guard let process = try? spawn() else {
      NSApp.terminate(nil)
      return
    }
    // The script serves until it is stopped, so its exit — clean or not — is
    // the end of the app, not the start of an idle Dock tile.
    process.terminationHandler = { _ in
      DispatchQueue.main.async { NSApp.terminate(nil) }
    }
    child = process
  }

  /// Clicking the Dock tile re-runs the script, whose already-serving branch
  /// brings the browser tab forward without starting a second server.
  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
    _ = try? spawn()
    return true
  }

  func applicationWillTerminate(_ notification: Notification) {
    guard let process = child, process.isRunning else { return }
    process.terminate()
    // The script traps SIGTERM to stop the server it started; leaving before
    // that handler finishes would orphan the server holding the port.
    let deadline = Date().addingTimeInterval(5)
    while process.isRunning && Date() < deadline {
      usleep(50_000)
    }
  }
}

guard let resources = Bundle.main.resourceURL else { exit(1) }
let application = NSApplication.shared
application.setActivationPolicy(.regular)
// NSApplication holds its delegate weakly; this binding is the strong reference.
let delegate = LauncherDelegate(script: resources.appendingPathComponent(${JSON.stringify(SCRIPT_NAME)}).path)
application.delegate = delegate
application.run()
`
}

/**
 * Compile the Cocoa shim into the bundle.
 * @param destination - the executable path to write.
 * @returns whether a Swift compiler was available to build it.
 */
async function compileShim(destination: string): Promise<boolean> {
  if (spawnSync('swiftc', ['--version'], { encoding: 'utf8' }).status !== 0) return false
  const staging = await mkdtemp(join(tmpdir(), 'dsh-shim-'))
  try {
    // Top-level statements are only legal in a file with this name.
    const source = join(staging, 'main.swift')
    await writeFile(source, shimSource())
    run('swiftc', ['-O', '-o', destination, source])
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
  return true
}

/**
 * Write `Resources/icon.icns` from an `.icns` (copied) or a square `.png`
 * (rendered to an iconset by `sips`, packed by `iconutil`).
 * @param source - the `--icon` path.
 * @param resources - the bundle's `Resources` directory.
 */
async function writeIcon(source: string, resources: string): Promise<void> {
  if (!existsSync(source)) throw new Error(`icon artwork ${source} does not exist`)
  const destination = join(resources, 'icon.icns')
  if (extname(source).toLowerCase() === '.icns') {
    await cp(source, destination)
    return
  }
  if (extname(source).toLowerCase() !== '.png') {
    throw new Error(`--icon takes a .icns or .png file, received ${basename(source)}`)
  }
  const staging = await mkdtemp(join(tmpdir(), 'dsh-icon-'))
  const iconset = join(staging, 'icon.iconset')
  try {
    await mkdir(iconset)
    for (const size of ICON_SIZES) {
      for (const scale of [1, 2]) {
        const pixels = size * scale
        const name = scale === 1 ? `icon_${String(size)}x${String(size)}.png` : `icon_${String(size)}x${String(size)}@2x.png`
        run('sips', ['-z', String(pixels), String(pixels), source, '--out', join(iconset, name)])
      }
    }
    run('iconutil', ['-c', 'icns', iconset, '-o', destination])
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

/**
 * Pack the bundle into a compressed disk image with the drag-to-install
 * layout (the app beside an `/Applications` symlink).
 * @param appPath - the built `.app`.
 * @param appName - volume name and image basename.
 * @param outputDir - directory receiving the image.
 * @returns the image path.
 */
async function createDmg(appPath: string, appName: string, outputDir: string): Promise<string> {
  const staging = await mkdtemp(join(tmpdir(), 'dsh-dmg-'))
  const dmgPath = join(outputDir, `${appName}.dmg`)
  try {
    await cp(appPath, join(staging, basename(appPath)), { recursive: true, verbatimSymlinks: true })
    await symlink('/Applications', join(staging, 'Applications'))
    run('hdiutil', ['create', '-volname', appName, '-srcfolder', staging, '-ov', '-format', 'UDZO', '-quiet', dmgPath])
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
  return dmgPath
}

/** Build the bundle named by the flags, and the disk image unless `--no-dmg`. */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      out: { type: 'string' },
      name: { type: 'string' },
      node: { type: 'string' },
      icon: { type: 'string' },
      dmg: { type: 'boolean', default: true },
    },
    allowPositionals: false,
  })

  if (process.platform !== 'darwin') throw new Error(`package:mac builds on macOS only, ran on ${process.platform}`)

  for (const required of [CLI_ENTRY, FRONTEND_ENTRY]) {
    if (!existsSync(join(root, required))) throw new Error(`missing ${required} — run 'pnpm run build' first`)
  }

  const appName = values.name ?? DEFAULT_APP_NAME
  const nodePath = values.node === undefined ? stableNodePath() : resolve(values.node)
  if (!existsSync(nodePath)) throw new Error(`--node ${nodePath} does not exist`)

  const outputDir = resolve(root, values.out ?? DEFAULT_OUTPUT)
  const appPath = join(outputDir, `${appName}.app`)
  const contents = join(appPath, 'Contents')
  const resources = join(contents, 'Resources')

  await rm(appPath, { recursive: true, force: true })
  await mkdir(join(contents, 'MacOS'), { recursive: true })
  await mkdir(resources, { recursive: true })

  const iconPath = values.icon === undefined ? join(root, DEFAULT_ICON) : resolve(values.icon)
  await writeIcon(iconPath, resources)

  const manifest = JSON.parse(await readFile(join(root, CLI_MANIFEST), 'utf8')) as { version?: unknown }
  const version = typeof manifest.version === 'string' ? manifest.version : '0.0.0'

  const executable = join(contents, 'MacOS', EXECUTABLE_NAME)
  const shimmed = await compileShim(executable)
  // Without the shim the script is the executable, and only an agent bundle
  // spares it the Dock tile LaunchServices would bounce waiting for a check-in
  // it cannot perform. That costs the Dock icon and its Quit item, so the app
  // is then stopped from Activity Monitor.
  const script = shimmed ? join(resources, SCRIPT_NAME) : executable
  await writeFile(script, launcherScript(nodePath, appName))
  await chmod(script, 0o755)
  await writeFile(join(resources, 'focus-chromium.applescript'), chromiumFocusScript())
  await writeFile(join(resources, 'focus-safari.applescript'), safariFocusScript())
  if (!shimmed) console.warn('warning: no swiftc found — building an agent bundle with no Dock icon')

  await writeFile(join(contents, 'Info.plist'), infoPlist(appName, version, !shimmed))
  await writeFile(join(contents, 'PkgInfo'), 'APPL????')

  registerBundle(appPath)

  console.log(`app:  ${appPath}`)
  console.log(`node: ${nodePath}`)
  console.log(`entry: ${join(root, CLI_ENTRY)}`)
  if (values.dmg) console.log(`dmg:  ${await createDmg(appPath, appName, outputDir)}`)
}

await main()
