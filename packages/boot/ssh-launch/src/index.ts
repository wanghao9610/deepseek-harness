/**
 * Launch planning for a harness runtime that serves from another host over SSH.
 *
 * The module owns three decisions and no process: which connection facts a
 * shell may store and hand to `ssh`, what argument vector starts the remote
 * runtime and forwards its loopback port back to the shell, and what a failed
 * launch means to the person who configured it. The shell that owns runtime
 * lifetime spawns the plan, allocates the loopback port, and applies its own
 * restart policy.
 *
 * Every value in a {@link SshTarget} reaches either an `ssh` argument or the
 * remote login shell, so {@link validateSshTarget} is the enforcement point:
 * it rejects the option-shaped and control-character values that would
 * otherwise become an `ssh` option or a second remote command.
 * @module @deepseek-ai/dsh-ssh-launch
 */

/** Loopback address the remote runtime binds and the forwarded port answers on. */
export const LOOPBACK_HOST = '127.0.0.1'

/** `dsh --profile` name a target boots when it names none. */
export const DEFAULT_PROFILE = 'web'

/** Launcher a host-provided target runs when it names none, resolved on the remote `PATH`. */
export const DEFAULT_REMOTE_COMMAND = 'dsh'

/** npm package a managed launcher is installed from. */
export const LAUNCHER_PACKAGE = '@deepseek-ai/dsh'

/** npm version or dist-tag a managed launcher installs when the target names none. */
export const DEFAULT_LAUNCHER_VERSION = 'latest'

/**
 * Server root under the remote account's home, when a connection names none.
 *
 * One directory is the whole footprint on a host: the installations the shell
 * puts there under `bin/`, and the runtime's own `DSH_HOME` beside them, so
 * removing this directory undoes every visit. Installations are scoped by the
 * version — and, for a transferred payload, by its digest — so two shells
 * asking for different ones do not overwrite each other, and so changing what a
 * connection asks for is what moves a host rather than a silent upgrade.
 */
export const DEFAULT_REMOTE_HOME = '.dsh-server'

/** Subdirectory of the server root holding one installation per requested launcher. */
export const REMOTE_BIN_DIRECTORY = 'bin'

/** Launcher an npm install leaves in an installation, relative to its root. */
export const INSTALLED_LAUNCHER_RELATIVE = 'node_modules/.bin/dsh'

/**
 * Launcher a transferred payload carries, relative to its root.
 *
 * A deployed closure has no `node_modules/.bin`: it is a dependency tree, not
 * an npm installation, so the package's own entry is what runs. It carries the
 * `#!/usr/bin/env node` line that makes it directly executable, and no Node of
 * its own — a payload replaces the registry, not the runtime under it.
 */
export const PAYLOAD_LAUNCHER_RELATIVE = 'node_modules/@deepseek-ai/dsh/lib/bin.js'

/**
 * Prefix the remote script puts on its own progress and diagnosis lines, so a
 * shell can tell them apart from the runtime's output.
 */
export const PROGRESS_PREFIX = 'dsh-remote: '

/**
 * Hex characters of a payload's digest that name it. Long enough that two
 * builds do not collide, short enough to read in a path; the builder that
 * writes the archive name and the shell that recomputes it share this.
 */
export const PAYLOAD_DIGEST_LENGTH = 12

/** Prefix the one line a host probe prints, which nothing else on the wire shares. */
const PROBE_PREFIX = 'dsh-probe '

/**
 * Exit statuses the provisioning preamble uses for the failures it can name
 * itself. `ssh` passes a remote command's status through unchanged, so these
 * reach the shell as the launch's own exit code.
 */
const PROVISION_EXIT = {
  /** No Node, or one older than the launcher supports. */
  node: 9,
  /** Node is present but npm is not. */
  npm: 10,
  /** The install itself failed. */
  install: 11,
  /** The install reported success but left no launcher. */
  missing: 12,
  /** The host has no tar, so a transferred payload cannot be unpacked. */
  tar: 13,
  /** Unpacking a transferred payload failed. */
  payload: 14,
} as const

/**
 * Seconds between the client's keepalive probes, and the number of unanswered
 * probes that ends the connection. A dropped link must surface as an `ssh`
 * exit the supervisor can restart, not as a window pointed at a forwarded port
 * nothing answers; these are passed as `-o` and therefore override whatever
 * the user's own `ssh_config` sets for this one connection.
 */
const KEEPALIVE_INTERVAL_SECONDS = 15
const KEEPALIVE_MAX_MISSED = 3

/** IANA dynamic range remote ports are drawn from. */
const FIRST_DYNAMIC_PORT = 49_152
const LAST_DYNAMIC_PORT = 65_535

/** Highest valid TCP port, which a stored target's `port` is checked against. */
const MAX_TCP_PORT = 65_535

/**
 * Profile and version names are file-system and command-line safe by
 * construction, which is also what lets the remote script interpolate a version
 * into a path without quoting it.
 */
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** C0 controls and DEL, which no hostname, path, or user name contains. */
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/

/**
 * Where the remote launcher comes from.
 *
 * The three are exclusive. A host that already carries a launcher names it. A
 * host that can reach the npm registry lets the shell install one there. A host
 * that can reach nothing takes the payload this machine sends it — which is the
 * only option that works when the far side has no network at all, and the only
 * one whose bytes this machine chose.
 *
 * The last two ignore the account's `PATH` entirely, which is what makes them
 * work on a host whose login shell has none.
 */
export type RemoteLauncher =
  /** Run this command, which the host already provides. */
  | { kind: 'host'; command: string }
  /** Install from the registry, on the host, at this npm version or dist-tag. */
  | { kind: 'managed'; version?: string }
  /** Send this local server payload and run what it unpacks to. */
  | { kind: 'archive'; path: string }

/** A launcher with everything the plan needs decided. */
export type ResolvedRemoteLauncher =
  | { kind: 'host'; command: string }
  | { kind: 'managed'; version: string }
  /** `directory` names the installation under the server root's `bin/`. */
  | { kind: 'archive'; directory: string }

/**
 * What a server payload is, as the shell read it from the archive.
 *
 * The digest scopes the remote directory together with the version, so an
 * archive rebuilt at the same version lands beside the old one instead of
 * being mistaken for it.
 */
export interface ArchivePayload {
  /** Version the archive declares. */
  version: string
  /** Short content digest of the archive. */
  digest: string
  /** Platform the archive was built for, as `uname -s` spells it. */
  platform: string
  /** Architecture the archive was built for, as `uname -m` spells it. */
  arch: string
}

/** What a host answered when asked about itself and a payload. */
export interface HostProbe {
  /** Platform, as `uname -s` spells it. */
  platform: string
  /** Architecture, as `uname -m` spells it. */
  arch: string
  /** Whether the payload is already unpacked there. */
  present: boolean
}

/** What a plan needs beyond the stored connection. */
export interface LaunchInputs {
  /** The payload this launch installs, when the connection sends one. */
  payload?: ArchivePayload
}

/**
 * One configured host that can serve a harness runtime.
 *
 * Fields left out are answered by the user's own `ssh` configuration, which
 * stays authoritative for everything this record does not name.
 */
export interface SshTarget {
  /** Stable identifier minted by the shell that stores this target. */
  id: string
  /** Name shown in the shell's connection list. */
  label: string
  /** Destination: a hostname, an address, or a `~/.ssh/config` alias. */
  host: string
  /** Login user; omitted lets `ssh` resolve it. */
  user?: string
  /** Port sshd listens on; omitted lets `ssh` resolve it. */
  port?: number
  /** Private key passed as `-i`; omitted lets `ssh` resolve its own keys. */
  identityFile?: string
  /** `ProxyJump` waypoints, in `ssh`'s own order. */
  jumpHosts?: readonly string[]
  /** Where the launcher comes from; omitted lets the shell install and manage one. */
  launcher?: RemoteLauncher
  /**
   * Root on the host that everything about this connection lives under: the
   * installations the shell puts there, and the runtime's own `DSH_HOME`.
   * Absolute, or `~/`-prefixed for the account's home; omitted uses
   * `~/.dsh-server`.
   */
  remoteHome?: string
  /** Remote working directory, which becomes a new session's project directory. */
  remoteCwd?: string
  /** `dsh --profile` name the remote runtime boots. */
  profile?: string
  /**
   * Whether the remote launcher is resolved through a login shell.
   *
   * `ssh host <command>` runs a non-interactive shell whose `PATH` frequently
   * omits a user-level npm prefix, so the default recovers the `PATH` an
   * interactive session would have. A target naming an absolute launcher, or
   * one whose account refuses `-l`, turns it off.
   */
  loginShell?: boolean
}

/** A target with every optional decision made, so no default hides in a later step. */
export interface ResolvedSshTarget {
  /** Destination `ssh` connects to. */
  host: string
  /** Login user, when the target named one. */
  user: string | undefined
  /** sshd port, when the target named one. */
  port: number | undefined
  /** Identity file, when the target named one. */
  identityFile: string | undefined
  /** `ProxyJump` waypoints; empty when the target named none. */
  jumpHosts: readonly string[]
  /** Where the launcher comes from, with its version decided. */
  launcher: ResolvedRemoteLauncher
  /** Server root as a remote shell expression, quoted or `$HOME`-relative. */
  remoteHome: string
  /** Remote working directory, when the target named one. */
  remoteCwd: string | undefined
  /** Profile, defaulted to {@link DEFAULT_PROFILE}. */
  profile: string
  /** Whether the launcher resolves through a login shell; defaulted on. */
  loginShell: boolean
}

/** One rejected field, phrased for the person editing the connection. */
export interface SshTargetProblem {
  /** The field the problem is about. */
  field: keyof SshTarget
  /** What is wrong with it. */
  message: string
}

/** The two ports one launch occupies. */
export interface SshLaunchPorts {
  /** Loopback port on the shell's machine, which the window and API client reach. */
  local: number
  /** Port the runtime binds on the target host, forwarded to {@link SshLaunchPorts.local}. */
  remote: number
}

/** One command to run against a host, ready to spawn. */
export interface SshCommandPlan {
  /** The OpenSSH client. */
  command: string
  /** Complete argument vector: options, destination, then the remote command. */
  args: readonly string[]
}

/** A complete launch, ready to spawn. */
export interface SshLaunchPlan {
  /** The OpenSSH client. */
  command: string
  /** Complete argument vector: options, destination, then the remote command. */
  args: readonly string[]
  /** Origin the shell reaches the forwarded runtime on. */
  localOrigin: string
}

/** What the runtime's own readiness line means for a forwarded launch. */
export type ForwardedUrlOutcome =
  /** The runtime bound the forwarded port; reach it here. */
  | { status: 'forwarded'; origin: string }
  /** The runtime bound something else, so the forward reaches nothing it serves. */
  | { status: 'unexpected'; reason: string }

/**
 * Whether one value is a plain object this module may read fields from.
 * @param value - any decoded value.
 * @returns true for a non-null, non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Whether text is safe to place in an argument vector and a remote command.
 *
 * Control characters cannot occur in a hostname, path, or user name, and they
 * make both `ssh`'s diagnostics and this module's own quoting unreadable.
 * @param value - candidate text.
 * @returns true when the text is non-empty and free of control characters.
 */
function isPlainText(value: string): boolean {
  return value.length > 0 && !CONTROL_CHARACTER.test(value)
}

/**
 * Whether text may be handed to `ssh` as a destination-shaped word.
 *
 * A leading `-` is refused because `ssh` reads it as an option, and options
 * such as `ProxyCommand` execute a command on the shell's own machine.
 * @param value - candidate text.
 * @returns true when the text is plain and cannot be read as an option.
 */
function isDestinationWord(value: string): boolean {
  return isPlainText(value) && !value.startsWith('-') && !/\s/.test(value)
}

/**
 * Whether text names a directory on the remote host this module can express.
 *
 * Absolute or `~/`-prefixed only: a relative path would resolve against
 * whatever directory sshd happened to start the shell in.
 * @param value - candidate path.
 * @returns true when the path is plain and anchored.
 */
function isRemotePath(value: string): boolean {
  return isPlainText(value) && (value.startsWith('/') || value.startsWith('~/'))
}

/**
 * Check one draft connection before it is stored or launched.
 * @param draft - the fields the person entered, in any state of completeness.
 * @returns every problem found, in field order; empty when the draft is a usable target.
 */
export function validateSshTarget(draft: Partial<SshTarget>): readonly SshTargetProblem[] {
  const problems: SshTargetProblem[] = []
  const add = (field: keyof SshTarget, message: string): void => { problems.push({ field, message }) }

  if (draft.id === undefined || !isPlainText(draft.id) || /\s/.test(draft.id)) {
    add('id', 'the connection needs an identifier without spaces')
  }
  if (draft.label === undefined || draft.label.trim().length === 0 || !isPlainText(draft.label)) {
    add('label', 'give the connection a name')
  }
  if (draft.host === undefined || !isDestinationWord(draft.host)) {
    add('host', 'enter a host name, address, or ssh config alias; it cannot start with "-"')
  }
  if (draft.user !== undefined && !isDestinationWord(draft.user)) {
    add('user', 'the user name cannot contain spaces or start with "-"')
  }
  if (draft.port !== undefined && (!Number.isInteger(draft.port) || draft.port < 1 || draft.port > MAX_TCP_PORT)) {
    add('port', `the SSH port must be a whole number between 1 and ${String(MAX_TCP_PORT)}`)
  }
  if (draft.identityFile !== undefined && !isPlainText(draft.identityFile)) {
    add('identityFile', 'enter the path of a private key file, or leave it empty')
  }
  if (draft.jumpHosts !== undefined && draft.jumpHosts.some(hop => !isDestinationWord(hop))) {
    add('jumpHosts', 'each jump host must be a host name without spaces')
  }
  if (draft.launcher !== undefined) {
    if (draft.launcher.kind === 'host' && !isPlainText(draft.launcher.command)) {
      add('launcher', 'enter the dsh command or its absolute path on the remote host')
    }
    if (draft.launcher.kind === 'managed'
      && draft.launcher.version !== undefined
      && !NAME_PATTERN.test(draft.launcher.version)) {
      add('launcher', 'enter an npm version or dist-tag, such as "latest"')
    }
    if (draft.launcher.kind === 'archive' && !isPlainText(draft.launcher.path)) {
      add('launcher', 'choose the server payload built for this host')
    }
  }
  if (draft.remoteHome !== undefined && !isRemotePath(draft.remoteHome)) {
    add('remoteHome', 'enter an absolute directory on the remote host, or one starting with "~/"')
  }
  if (draft.remoteCwd !== undefined && !isPlainText(draft.remoteCwd)) {
    add('remoteCwd', 'enter a directory on the remote host, or leave it empty')
  }
  if (draft.profile !== undefined && !NAME_PATTERN.test(draft.profile)) {
    add('profile', 'a profile name uses letters, digits, dots, dashes, and underscores')
  }
  return problems
}

/**
 * Recover a stored launcher choice.
 * @param value - the stored value, in whatever shape it was written.
 * @returns the choice it names, or `undefined` when it names none this build serves.
 */
function readLauncher(value: unknown): RemoteLauncher | undefined {
  if (!isRecord(value)) return undefined
  if (value.kind === 'host') {
    const command = typeof value.command === 'string' ? value.command : ''
    return { kind: 'host', command }
  }
  if (value.kind === 'archive') {
    const path = typeof value.path === 'string' ? value.path : ''
    return { kind: 'archive', path }
  }
  if (value.kind !== 'managed') return undefined
  const version = typeof value.version === 'string' && value.version.length > 0 ? value.version : undefined
  return { kind: 'managed', ...version !== undefined && { version } }
}

/**
 * Read one optional text field from a stored record.
 * @param record - the stored object.
 * @param key - the field to read.
 * @returns the text when present and non-empty, otherwise `undefined`.
 */
function readText(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Recover the connections a shell stored, discarding entries this build cannot
 * use. The settings file is a durable boundary a person also edits by hand, so
 * one damaged entry must not cost the whole list.
 * @param value - the decoded stored value, in whatever shape it was written.
 * @returns the entries that pass {@link validateSshTarget}, in stored order.
 */
export function readSshTargets(value: unknown): readonly SshTarget[] {
  if (!Array.isArray(value)) return []
  const targets: SshTarget[] = []
  for (const entry of value) {
    if (!isRecord(entry)) continue
    const jumpHosts = Array.isArray(entry.jumpHosts)
      ? entry.jumpHosts.filter((hop): hop is string => typeof hop === 'string')
      : []
    const id = readText(entry, 'id')
    const label = readText(entry, 'label')
    const host = readText(entry, 'host')
    const user = readText(entry, 'user')
    const identityFile = readText(entry, 'identityFile')
    const launcher = readLauncher(entry.launcher)
    const remoteHome = readText(entry, 'remoteHome')
    const remoteCwd = readText(entry, 'remoteCwd')
    const profile = readText(entry, 'profile')
    const candidate: Partial<SshTarget> = {
      ...id !== undefined && { id },
      ...label !== undefined && { label },
      ...host !== undefined && { host },
      ...user !== undefined && { user },
      ...typeof entry.port === 'number' && { port: entry.port },
      ...identityFile !== undefined && { identityFile },
      ...jumpHosts.length > 0 && { jumpHosts },
      ...launcher !== undefined && { launcher },
      ...remoteHome !== undefined && { remoteHome },
      ...remoteCwd !== undefined && { remoteCwd },
      ...profile !== undefined && { profile },
      ...typeof entry.loginShell === 'boolean' && { loginShell: entry.loginShell },
    }
    if (validateSshTarget(candidate).length === 0) targets.push(candidate as SshTarget)
  }
  return targets
}

/**
 * Decide where the launcher comes from.
 *
 * A target that names nothing gets a managed installation: a host that already
 * carries a launcher is the exception, not the common case, and a `PATH` lookup
 * that quietly finds the wrong one is worse than an installation the shell owns.
 * @param launcher - the stored choice, when the target made one.
 * @returns the choice with its version decided.
 */
function resolveLauncher(
  launcher: RemoteLauncher | undefined,
  payload: ArchivePayload | undefined,
): ResolvedRemoteLauncher {
  if (launcher === undefined) return { kind: 'managed', version: DEFAULT_LAUNCHER_VERSION }
  if (launcher.kind === 'host') return launcher
  if (launcher.kind === 'managed') {
    return { kind: 'managed', version: launcher.version ?? DEFAULT_LAUNCHER_VERSION }
  }
  if (payload === undefined) {
    throw new Error('ssh-launch: a connection that sends a server payload cannot be planned without reading it first')
  }
  return { kind: 'archive', directory: `${payload.version}-${payload.digest}` }
}

/**
 * Turn the configured server root into the remote shell expression that names it.
 * @param remoteHome - the configured root, when the target named one.
 * @returns a quoted absolute path, or a `$HOME`-relative expression.
 */
function resolveRemoteHome(remoteHome: string | undefined): string {
  if (remoteHome === undefined) return `"$HOME/${DEFAULT_REMOTE_HOME}"`
  return remoteHome.startsWith('~/')
    ? `"$HOME/"${quoteRemoteArgument(remoteHome.slice(2))}`
    : quoteRemoteArgument(remoteHome)
}

/**
 * Make every optional decision a target left open.
 * @param target - a validated connection.
 * @param inputs - what the plan needs beyond the connection, such as the payload it sends.
 * @returns the same connection with no decision deferred to a later step.
 */
export function resolveSshTarget(target: SshTarget, inputs: LaunchInputs = {}): ResolvedSshTarget {
  return {
    host: target.host,
    user: target.user,
    port: target.port,
    identityFile: target.identityFile,
    jumpHosts: target.jumpHosts ?? [],
    launcher: resolveLauncher(target.launcher, inputs.payload),
    remoteHome: resolveRemoteHome(target.remoteHome),
    remoteCwd: target.remoteCwd,
    profile: target.profile ?? DEFAULT_PROFILE,
    loginShell: target.loginShell ?? true,
  }
}

/**
 * Quote one argument for the remote login shell, which receives the command as
 * one string rather than an argument vector.
 * @param value - exact text to preserve.
 * @returns a single shell word that interpolates nothing.
 */
export function quoteRemoteArgument(value: string): string {
  return `'${value.replaceAll('\'', '\'\\\'\'')}'`
}

/**
 * Build the script lines that refuse a host whose Node cannot run the launcher.
 *
 * Both provisioning paths need it: an installation is JavaScript, and so is a
 * transferred payload, so each still runs on the host's own Node.
 * @returns the lines to run before either kind of installation is used.
 */
function nodeCheckLines(): readonly string[] {
  return [
    `command -v node >/dev/null 2>&1 || { echo ${quoteRemoteArgument(`${PROGRESS_PREFIX}this host has no node`)} >&2; exit ${String(PROVISION_EXIT.node)}; }`,
    `node -e 'const v=process.versions.node.split(".").map(Number);process.exit((v[0]===22&&v[1]>=19)||v[0]>=24?0:1)' || { echo ${quoteRemoteArgument(`${PROGRESS_PREFIX}the node on this host is too old`)} >&2; exit ${String(PROVISION_EXIT.node)}; }`,
  ]
}

/**
 * Build the script lines that establish the server root and `$dsh_launcher`.
 *
 * The server root is exported as `DSH_HOME`, so every durable thing the remote
 * runtime writes — sessions, storages, settings, presets — lands under the one
 * directory this connection owns, beside the installations in `bin/`.
 *
 * A managed installation happens on first use and is never touched again: a
 * present launcher is the whole check, so a later connection needs no registry
 * and no network, and moving a host to another version is what the person
 * changes rather than something that happens to them. A transferred payload is
 * already unpacked by the time this runs, because only the shell can send it.
 *
 * Paths are derived on the far side because only the far side knows where
 * `$HOME` is; a version or digest needs no quoting there because both are
 * validated to a path-safe alphabet before they get here.
 * @param target - the resolved connection.
 * @returns the lines to run before the runtime starts.
 */
function launcherPreamble(target: ResolvedSshTarget): readonly string[] {
  const root = [
    `dsh_home=${target.remoteHome}`,
    'export DSH_HOME="$dsh_home"',
  ]
  const { launcher } = target
  if (launcher.kind === 'host') {
    return [...root, `dsh_launcher=${quoteRemoteArgument(launcher.command)}`]
  }
  if (launcher.kind === 'archive') {
    return [
      ...root,
      `dsh_dir="$dsh_home/${REMOTE_BIN_DIRECTORY}/${launcher.directory}"`,
      `dsh_launcher="$dsh_dir/${PAYLOAD_LAUNCHER_RELATIVE}"`,
      `[ -x "$dsh_launcher" ] || { echo ${quoteRemoteArgument(`${PROGRESS_PREFIX}the transferred server payload is missing`)} >&2; exit ${String(PROVISION_EXIT.payload)}; }`,
      ...nodeCheckLines(),
    ]
  }
  const spec = `${LAUNCHER_PACKAGE}@${launcher.version}`
  return [
    ...root,
    `dsh_dir="$dsh_home/${REMOTE_BIN_DIRECTORY}/${launcher.version}"`,
    `dsh_launcher="$dsh_dir/${INSTALLED_LAUNCHER_RELATIVE}"`,
    'if [ ! -x "$dsh_launcher" ]; then',
    ...nodeCheckLines().map(line => `  ${line}`),
    `  command -v npm >/dev/null 2>&1 || { echo ${quoteRemoteArgument(`${PROGRESS_PREFIX}this host has no npm`)} >&2; exit ${String(PROVISION_EXIT.npm)}; }`,
    `  echo ${quoteRemoteArgument(`${PROGRESS_PREFIX}installing ${spec}`)} >&2`,
    `  mkdir -p "$dsh_dir" || exit ${String(PROVISION_EXIT.install)}`,
    `  npm install --prefix "$dsh_dir" --no-save --no-audit --no-fund --loglevel=error ${quoteRemoteArgument(spec)} || exit ${String(PROVISION_EXIT.install)}`,
    `  [ -x "$dsh_launcher" ] || exit ${String(PROVISION_EXIT.missing)}`,
    `  echo ${quoteRemoteArgument(`${PROGRESS_PREFIX}installed ${spec}`)} >&2`,
    'fi',
  ]
}

/**
 * Build the one command string sshd hands to the account's shell.
 *
 * The script supervises the runtime from the remote side in both directions,
 * because neither end can be recovered from the other: killing the local `ssh`
 * does not reach a remote process that sshd already detached from the channel,
 * and a runtime that exits on its own would otherwise leave `ssh` connected to
 * a session serving nothing.
 *
 * The caller therefore owes this script an open stdin for the life of the
 * runtime. Closing that stdin is the graceful stop — it reaches the runtime as
 * the `SIGTERM` that runs its own disposal — and a launch whose stdin is
 * `/dev/null` ends the runtime the moment it starts.
 * @param target - the resolved connection.
 * @param remotePort - the port the runtime binds on the target host.
 * @returns the remote script, quoted so every configured value stays literal.
 */
export function remoteCommandLine(target: ResolvedSshTarget, remotePort: number): string {
  const argv = [
    '--profile', target.profile,
    '--host', LOOPBACK_HOST,
    '--port', String(remotePort),
  ]
  const script = [
    ...launcherPreamble(target),
    ...target.remoteCwd === undefined ? [] : [`cd ${quoteRemoteArgument(target.remoteCwd)} || exit 1`],
    // A shell with job control off gives every asynchronous command /dev/null
    // for stdin BEFORE its explicit redirections, so the watchdog below would
    // read end-of-file the instant it started and kill the runtime it was
    // meant to outlive. Keeping the session's stdin on another descriptor is
    // what survives that: the explicit redirection wins over the default.
    'exec 3<&0',
    `"$dsh_launcher" ${argv.map(quoteRemoteArgument).join(' ')} &`,
    'dsh_runtime=$!',
    // A shell built-in read rather than a helper process: killing this subshell
    // must release the session's stdin, which a reparented `cat` would hold.
    '{ while read -r dsh_ignored; do :; done; kill -TERM "$dsh_runtime" 2>/dev/null; } <&3 &',
    'dsh_watchdog=$!',
    'wait "$dsh_runtime"',
    'dsh_status=$?',
    'kill -TERM "$dsh_watchdog" 2>/dev/null',
    'exit "$dsh_status"',
  ].join('\n')
  // `${SHELL:-/bin/sh}` rather than `$SHELL`: sshd sets SHELL from the account,
  // but a forced-command or restricted account may not, and an empty program
  // name would fail with a diagnostic about nothing.
  return target.loginShell
    ? `exec "\${SHELL:-/bin/sh}" -lc ${quoteRemoteArgument(script)}`
    : script
}

/**
 * Build the connection options every command to this host shares.
 * @param resolved - the resolved connection.
 * @returns the `ssh` options, without a destination or a command.
 */
function connectionOptions(resolved: ResolvedSshTarget): readonly string[] {
  return [
    // The shell has no terminal to answer a prompt on, so a connection that
    // needs one must fail with a diagnosis instead of waiting forever.
    '-o', 'BatchMode=yes',
    // A forward that did not bind would otherwise leave a healthy-looking ssh
    // session in front of a port nothing answers.
    '-o', 'ExitOnForwardFailure=yes',
    '-o', `ServerAliveInterval=${String(KEEPALIVE_INTERVAL_SECONDS)}`,
    '-o', `ServerAliveCountMax=${String(KEEPALIVE_MAX_MISSED)}`,
    // No remote terminal: the runtime's stdout carries the readiness line and
    // its log, a payload arrives on stdin, and a pty would rewrite both.
    '-T',
    ...resolved.port === undefined ? [] : ['-p', String(resolved.port)],
    ...resolved.user === undefined ? [] : ['-l', resolved.user],
    ...resolved.identityFile === undefined ? [] : ['-i', resolved.identityFile],
    ...resolved.jumpHosts.length === 0 ? [] : ['-J', resolved.jumpHosts.join(',')],
  ]
}

/**
 * Build the script lines that name the server root and one installation in it.
 * @param resolved - the resolved connection, whose launcher sends a payload.
 * @returns the lines establishing `$dsh_home`, `$dsh_dir`, and `$dsh_launcher`.
 */
function launcherRoot(resolved: ResolvedSshTarget): readonly string[] {
  if (resolved.launcher.kind !== 'archive') {
    throw new Error('ssh-launch: only a connection that sends a server payload has one to transfer')
  }
  return [
    `dsh_home=${resolved.remoteHome}`,
    `dsh_dir="$dsh_home/${REMOTE_BIN_DIRECTORY}/${resolved.launcher.directory}"`,
    `dsh_launcher="$dsh_dir/${PAYLOAD_LAUNCHER_RELATIVE}"`,
  ]
}

/**
 * Plan one launch of the runtime on a remote host.
 * @param target - a validated connection.
 * @param ports - the local and remote ports this launch occupies.
 * @param inputs - what the plan needs beyond the connection, such as the payload it sends.
 * @returns the executable, its complete argument vector, and the origin to reach the runtime on.
 */
export function planSshLaunch(
  target: SshTarget,
  ports: SshLaunchPorts,
  inputs: LaunchInputs = {},
): SshLaunchPlan {
  const resolved = resolveSshTarget(target, inputs)
  const args = [
    ...connectionOptions(resolved),
    '-L', `${LOOPBACK_HOST}:${String(ports.local)}:${LOOPBACK_HOST}:${String(ports.remote)}`,
    resolved.host,
    remoteCommandLine(resolved, ports.remote),
  ]
  return { command: 'ssh', args, localOrigin: `http://${LOOPBACK_HOST}:${String(ports.local)}` }
}

/**
 * Plan the one question the shell asks a host before sending it a payload.
 *
 * Both answers come back on one line and one round trip: what the host is, and
 * whether it already carries this payload. The first is what keeps a payload
 * built for one platform off a host that is another — the closure carries
 * compiled native modules the runtime imports at boot, so a mismatch is a
 * runtime that cannot start rather than one that starts degraded. The second is
 * what keeps a host that already has it from paying for the transfer again.
 * @param target - a validated connection whose launcher sends a payload.
 * @param payload - the payload the shell read.
 * @returns a command that prints one {@link readHostProbe} line.
 */
export function planPayloadProbe(target: SshTarget, payload: ArchivePayload): SshCommandPlan {
  const resolved = resolveSshTarget(target, { payload })
  return {
    command: 'ssh',
    args: [
      ...connectionOptions(resolved),
      resolved.host,
      [
        ...launcherRoot(resolved),
        `printf ${quoteRemoteArgument(`${PROBE_PREFIX}%s %s %s\n`)} "$(uname -s)" "$(uname -m)" "$([ -x "$dsh_launcher" ] && echo present || echo absent)"`,
      ].join('\n'),
    ],
  }
}

/**
 * Read what a host answered.
 * @param output - everything the probe printed.
 * @returns the host's platform, architecture, and whether it carries the payload;
 * `undefined` when it answered nothing this module understands.
 */
export function readHostProbe(output: string): HostProbe | undefined {
  for (const line of output.split('\n')) {
    const start = line.indexOf(PROBE_PREFIX)
    if (start === -1) continue
    const [platform, arch, presence] = line.slice(start + PROBE_PREFIX.length).trim().split(' ')
    if (platform === undefined || arch === undefined || presence === undefined) continue
    return { platform, arch, present: presence === 'present' }
  }
  return undefined
}

/**
 * Check a payload against the host that would run it.
 * @param payload - the payload the shell read.
 * @param host - what the host answered.
 * @returns why the payload cannot run there, or `undefined` when it can.
 */
export function describePayloadMismatch(payload: ArchivePayload, host: HostProbe): string | undefined {
  if (payload.platform === host.platform && payload.arch === host.arch) return undefined
  return `this server payload was built for ${payload.platform} ${payload.arch}, and the host is ${host.platform} ${host.arch}; a payload carries compiled modules, so build one on a ${host.platform} ${host.arch} machine`
}

/**
 * Plan the transfer of a payload this machine sends.
 *
 * The caller writes the archive to the command's stdin; nothing is staged on
 * either side. Unpacking happens beside the destination and is renamed into
 * place, so an interrupted transfer leaves no directory a later probe would
 * mistake for a complete installation.
 * @param target - a validated connection whose launcher sends a payload.
 * @param payload - the payload the shell read.
 * @returns a command that consumes the archive on its stdin.
 */
export function planPayloadTransfer(target: SshTarget, payload: ArchivePayload): SshCommandPlan {
  const resolved = resolveSshTarget(target, { payload })
  return {
    command: 'ssh',
    args: [
      ...connectionOptions(resolved),
      resolved.host,
      [
        ...launcherRoot(resolved),
        `command -v tar >/dev/null 2>&1 || { echo ${quoteRemoteArgument(`${PROGRESS_PREFIX}this host has no tar`)} >&2; exit ${String(PROVISION_EXIT.tar)}; }`,
        'dsh_partial="$dsh_dir.partial"',
        `rm -rf "$dsh_partial" || exit ${String(PROVISION_EXIT.payload)}`,
        `mkdir -p "$dsh_partial" || exit ${String(PROVISION_EXIT.payload)}`,
        `tar -xzf - -C "$dsh_partial" || exit ${String(PROVISION_EXIT.payload)}`,
        `[ -x "$dsh_partial/${PAYLOAD_LAUNCHER_RELATIVE}" ] || exit ${String(PROVISION_EXIT.payload)}`,
        `rm -rf "$dsh_dir" || exit ${String(PROVISION_EXIT.payload)}`,
        `mv "$dsh_partial" "$dsh_dir" || exit ${String(PROVISION_EXIT.payload)}`,
      ].join('\n'),
    ],
  }
}

/**
 * Decide what the runtime's readiness line means for a forwarded launch.
 *
 * The remote runtime reports the address it bound on its own host. Only the
 * forwarded port reaches the shell, so a runtime that bound anything else is
 * serving somewhere this shell cannot see and must not be shown as ready.
 * @param reported - the URL the runtime printed.
 * @param ports - the ports this launch planned.
 * @returns the local origin to use, or why the reported address is unusable.
 */
export function verifyForwardedUrl(reported: string, ports: SshLaunchPorts): ForwardedUrlOutcome {
  let parsed: URL
  try {
    parsed = new URL(reported)
  } catch {
    // Not a URL at all: the readiness line matched something else entirely.
    return { status: 'unexpected', reason: `the remote runtime reported "${reported}", which is not a URL` }
  }
  if (parsed.port !== String(ports.remote)) {
    return {
      status: 'unexpected',
      reason: `the remote runtime is serving on port ${parsed.port === '' ? 'the protocol default' : parsed.port}, but port ${String(ports.remote)} is the one forwarded to this machine`,
    }
  }
  return { status: 'forwarded', origin: `http://${LOOPBACK_HOST}:${String(ports.local)}` }
}

/**
 * Read the newest progress note out of one chunk of launch output.
 *
 * The remote script announces the steps only it can see — a host being
 * provisioned takes long enough that a shell showing nothing looks stalled.
 * @param chunk - decoded output from the launch, in arrival order.
 * @returns the note, or `undefined` when the chunk carries none.
 */
export function readProgress(chunk: string): string | undefined {
  let note: string | undefined
  for (const line of chunk.split('\n')) {
    const start = line.indexOf(PROGRESS_PREFIX)
    if (start !== -1) note = line.slice(start + PROGRESS_PREFIX.length).trim()
  }
  return note === undefined || note.length === 0 ? undefined : note
}

/**
 * Turn a failed launch into the sentence the person who configured it needs.
 *
 * `ssh` reports every remote-side failure as its own exit status, so the
 * output text — not the code alone — carries which layer failed.
 * @param outcome - how the launch ended and what it printed.
 * @param outcome.exitCode - process exit code, or `null` when a signal ended it.
 * @param outcome.output - the combined output the launch produced.
 * @returns one sentence naming the layer that failed and what to change.
 */
export function diagnoseSshFailure(outcome: { exitCode: number | null; output: string }): string {
  const output = outcome.output
  // The provisioning preamble names its own failures, and its exit statuses are
  // the only ones whose meaning does not have to be read out of the output.
  switch (outcome.exitCode) {
    case PROVISION_EXIT.node:
      return `the host cannot run ${LAUNCHER_PACKAGE}: install Node 22.19 or newer (or 24 and newer) there, or point the connection at a dsh the host already provides`
    case PROVISION_EXIT.npm:
      return `the host has Node but no npm, so the shell cannot install ${LAUNCHER_PACKAGE}; install npm there, or point the connection at a dsh the host already provides`
    case PROVISION_EXIT.install:
      return `installing ${LAUNCHER_PACKAGE} on the host failed; the runtime log holds what npm reported, and a version that does not exist is the common cause`
    case PROVISION_EXIT.missing:
      return `installing ${LAUNCHER_PACKAGE} on the host left no launcher; the runtime log holds what npm reported`
    case PROVISION_EXIT.tar:
      return 'the host has no tar, so it cannot unpack a server payload; install tar there, or point the connection at a dsh the host already provides'
    case PROVISION_EXIT.payload:
      return 'the server payload did not unpack on the host; check that the archive is a server payload and that its directory is writable'
    default:
      break
  }
  if (/Host key verification failed/i.test(output)) {
    return 'the host key changed or is unknown; connect once with ssh in a terminal to record it, then try again'
  }
  if (/Permission denied|publickey|Too many authentication failures/i.test(output)) {
    return 'the host refused the key; this shell cannot answer a password or passphrase prompt, so the connection needs an ssh-agent identity or an unencrypted key file'
  }
  if (/Could not resolve hostname|Name or service not known/i.test(output)) {
    return 'the host name did not resolve; check the address or the ssh config alias'
  }
  if (/Connection refused|Connection timed out|No route to host|Operation timed out/i.test(output)) {
    return 'the host did not accept an SSH connection; check that it is reachable and that sshd is running'
  }
  if (/cannot listen to port|bind: Address already in use|Address already in use/i.test(output)) {
    return 'the forwarded port was already taken; the next attempt picks another one'
  }
  if (/command not found|No such file or directory/i.test(output) || outcome.exitCode === 127) {
    return 'the remote host has no dsh launcher on its PATH; install dsh there, or set the connection\'s remote command to its absolute path'
  }
  if (outcome.exitCode === 255) {
    return 'ssh could not establish the connection; the runtime log holds what it reported'
  }
  return 'the remote runtime stopped; the runtime log holds what it reported'
}

/**
 * Pick a remote port for one launch.
 *
 * The local end of the forward is allocated by binding it, which the shell can
 * do on its own machine; nothing can prove the same for the target host before
 * the runtime binds there, so a remote collision is a launch failure the caller
 * retries with a fresh pick rather than a condition to check for.
 * @param random - source of one value in `[0, 1)`.
 * @returns a port in the IANA dynamic range.
 */
export function pickRemotePort(random: () => number): number {
  return FIRST_DYNAMIC_PORT + Math.floor(random() * (LAST_DYNAMIC_PORT - FIRST_DYNAMIC_PORT + 1))
}
