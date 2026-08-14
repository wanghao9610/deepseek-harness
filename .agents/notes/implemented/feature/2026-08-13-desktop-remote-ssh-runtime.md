# Agent Note: The desktop shell serves its runtime from a remote host over SSH

Status: implemented

English | [中文](2026-08-13-desktop-remote-ssh-runtime.zh.md)

## Problem

The desktop shell supervised a runtime on the machine the window runs on, so an agent could only read files, run commands, and open terminals there. Working on another machine meant giving up the shell entirely — an SSH session and a terminal UI — or exposing the remote runtime's HTTP server to a network it has no authentication for.

Two shapes were available and neither is what people mean by remote development. Forwarding a port to a runtime someone started by hand leaves its lifetime, readiness, and failure diagnosis outside the application. Reimplementing the filesystem and subprocess seams over SSH would move the mutable world without moving the language servers, terminals, sandbox, or process supervision that the far side already has natively.

## Decision

The runtime serves either from this machine or from a host reached over SSH, and **which one is a property of the launch the supervisor is handed, not of the supervision.** `RuntimeSupervisor` prepares a launch per start rather than per supervisor, because a remote one occupies a fresh pair of ports every time and because the person may have chosen a different host since the last one.

A remote runtime is a complete harness on the far side. Nothing about files, commands, terminals, language servers, sessions, or credentials is adapted: the desktop application keeps the window, the connection list, and nothing else. One `ssh` session both starts that runtime and forwards its loopback port back, so the window loads an ordinary loopback origin and the API client, the boot surface, and the attention streams are unchanged.

`@deepseek-ai/dsh-ssh-launch` is a pure library under `packages/boot/`, next to the other launcher glue. It plans and validates; it starts no process. `apps/desktop` spawns the plan, allocates the loopback port, and owns restart pacing. The shell is where connecting lives because the Electron main process is not a Cordis context, and because a client plugin that chose which runtime to connect to would have to be served by the runtime it has not connected to yet.

### A connection belongs to a window

One runtime per connection in use, created when a window first asks for it, and each window shows what ITS connection is doing. The first arrangement had one runtime for the application: pointing any window at a host stopped the runtime every other window was watching and put them all on the same waiting screen, which is not what a second window is for. Windows on the same connection still share one runtime, so the ordinary case is unchanged.

Nothing is torn down when a window leaves a connection. A runtime another window still uses keeps serving, and one whose last window left has no window of its own — which is already what the idle rule measures, so it stops on the existing policy rather than on a rule about switching. The stored choice becomes the default for windows opened later, not a change to the ones open now.

### Waiting is not a dead end

Every waiting surface carries its own actions, and Escape presses Stop. A first connection installs a launcher on the host, which takes minutes; the surface first shipped with buttons only on failure, so that install had no exit but force-quitting.

Stopping reaches the work that runs before any process exists. Preparation — reading an archive, probing a host, sending a payload — is given the abort signal the supervisor owns, so cancelling ends the transfer rather than leaving it running behind a window that has moved on. A cancelled preparation reports as stopped rather than as a failure, because it is what the person asked for.

### What the launch owns

A `RuntimeLaunch` carries the command line and the three answers that differ between the two:

- **Where to reach the runtime.** A local one is reached at the address it printed. A remote one prints the address it bound on its own host, and only the forwarded port reaches the shell, so the launch maps it — and refuses any other address, since restarting cannot fix a runtime serving somewhere this machine cannot see. That refusal is fatal rather than another restart attempt.
- **How to stop it.** A local runtime is asked with `SIGTERM`. A remote one is asked by closing the `ssh` session's stdin: the remote script turns that into the same `SIGTERM` on the far side. Signalling `ssh` instead would leave the runtime orphaned, because sshd has already detached it from the channel.
- **What a failure means.** `ssh` reports every remote-side failure as its own exit status, so the diagnosis reads the output — a refused key, an unresolved host, a missing remote launcher — and the supervisor retains a bounded output tail for it.

### The remote script supervises in both directions

Neither direction can be recovered from the other, so the script the account's shell receives does both: it backgrounds the runtime, waits for it, and exits with its status, while a shell built-in read ends the runtime when stdin closes. The built-in matters — a helper process would keep holding the session's stdin after being killed, and the session would not close.

The caller therefore owes the script an open stdin for the life of the runtime; a launch whose stdin is `/dev/null` ends the runtime the moment it starts. That coupling is stated on the launch (`stdin: 'pipe'`, `stopsOnStdinEnd`) rather than left to a comment.

### One server root per connection

Everything a connection touches on the host lives under one root — `~/.dsh-server` unless the connection names another. Installations sit in `bin/`, scoped by what the connection asked for, and the root is exported as the runtime's `DSH_HOME`, so sessions, storages, settings, and presets land beside them. Removing that one directory undoes every visit, which is the property the layout exists for.

### The host does not have to have a launcher, or a registry

A connection either names a launcher the host already provides, lets the shell install one from npm, or sends one this machine holds; the three are exclusive, and naming none gets the registry installation. A `PATH` lookup that quietly finds the wrong `dsh` is worse than a copy the shell owns, and a managed launcher ignores the account's `PATH` entirely, which is what makes it work on a host whose non-interactive login shell has none.

The install is a preamble on the same remote script rather than a separate session, so provisioning and launching are one authentication and one connection, and a failure in either arrives through the one path the supervisor already handles. **A present launcher is the whole check**: the directory is scoped by the requested version, so a later connection needs no registry and no network, and nothing upgrades on its own — changing the version a connection asks for is what moves that host. Version names are validated to a path-safe alphabet, which is what lets the script interpolate one into a path without quoting; the path is derived on the far side because only the far side knows where `$HOME` is.

**A host with no network takes a payload instead.** The registry install cannot serve an air-gapped host, so a connection can point at a local archive that the shell streams into an `ssh` which unpacks it — nothing staged on either machine, and the same connection options as every other command to that host.

That path carries a constraint the registry path does not: **a payload runs only on the platform it was built for.** The closure it carries includes compiled native modules, `node-pty` among them, which `dsh-subprocess-local` imports statically at module load — so a payload built elsewhere is a runtime that does not start at all, not one that starts degraded. The shell therefore asks the host what it is before sending anything, in the same round trip that asks whether the payload is already there, and refuses a mismatch. Building a payload is `pnpm run package:remote-server`, which labels what it built rather than accepting a target: the machine it runs on is the only platform it can produce.

A payload replaces the registry, not Node. It carries no runtime of its own, so the launch keeps the same Node check the registry path uses. Its launcher is the package entry rather than `node_modules/.bin/dsh`: a deployed closure is a dependency tree, not an npm installation, and has no bin directory at all.

The version defaults to the `latest` dist-tag rather than to the shell's own version. Pinning the shell's version would be the stronger guarantee and is what VS Code does with its server commit, but this shell's version is not guaranteed to be published — `0.1.0-rc.5` shipped while the registry held `rc.3` and `rc.6` — and a default that resolves to a version that does not exist is a feature that never works. Skew is also cheaper here than it looks: the browser loads the whole UI from the remote runtime, so the only local-to-remote contract is the readiness line, the profile flags, and the two event downlinks the shell subscribes to.

Installing takes minutes, so the preamble announces its steps with a prefix the shell reads into the boot surface, and names its own failures — no Node, a Node too old, no npm, a failed install, an install that left no launcher — as exit statuses. Those are the only failures whose meaning does not have to be recovered from output text.

### Validation is the enforcement point

Every field of a connection reaches an `ssh` argument or the remote login shell, and both the settings file and the form are boundaries a person writes. Validation refuses what would change the meaning of the command rather than its arguments: a host, user, or jump host beginning with `-`, which `ssh` reads as an option — `ProxyCommand` among them, which executes on the shell's own machine — and control characters anywhere. Values that survive are still quoted, because sshd hands the shell one string rather than an argument vector.

`BatchMode=yes` is part of the same posture: a windowed shell has no terminal to answer a prompt on, so a connection needing one fails with a diagnosis instead of waiting forever. The cost is that password and passphrase authentication are unavailable.

### Two facts the forward buys

The remote runtime sees an SSH launch, so its adaptive directory picker resolves to the in-app browser rather than trying to open a chooser on an unattended machine. And requests arrive at the remote `/api` from `127.0.0.1`, which is what keeps the privileged methods — directory picking, settings, credentials, preset authoring — reachable at all: they are loopback-only until a real authentication layer exists. Both follow from tunnelling rather than binding a network interface, which is also the only posture the web server documents as safe.

## Alternatives considered

**Implement `ctx.fs` and `ctx.subprocess` over SSH, keeping the harness local.** Rejected: it moves the mutable world without moving what the far side already has natively, and every capability above those seams pays adapter cost — remote PID and foreground-group inspection, `MaxSessions` pressure from one channel per language server and terminal, and no reconnect for live handles. The [portable execution-world decision](../architecture/2026-07-28-portable-execution-world-consumers.md) owns that seam; running the whole harness on the far side is the deployment model it explicitly leaves out, and it is the cheaper one when the host can run `dsh`.

**Make connecting a client plugin.** Rejected as unbuildable in this arrangement: client plugin bundles are served by the runtime over HTTP, so a plugin that chose which runtime to connect to would have to be served by the runtime it has not reached yet. VS Code resolves this with a UI/workspace extension split; this client has no such split, and inventing one is a larger change than the feature.

**Let the person pick a remote port, or discover a free one first.** Rejected: nothing can prove a remote port is free before the runtime binds it, and a discovery round-trip would only narrow the race. Drawing from the dynamic range and treating a collision as a retryable launch failure reuses the path that already handles a local collision.

**Force a pty so the remote runtime dies with the session.** Rejected: a pty rewrites the stream that carries the readiness line and the log. The stdin watchdog gets the same outcome without touching the output.

**Signal `ssh` for a graceful stop.** Rejected: it ends the carrier, not the runtime, and leaves a full harness resident on the far side after every disconnect.

**Pin the managed launcher to the shell's own version.** Rejected as a default because the shell's version is not guaranteed to be published, and a default that resolves to a missing version is a feature that never works. A connection can still pin any version, which is the same mechanism without the broken default.

**Provision in a separate `ssh` session before the launch.** Rejected because it doubles the authentication and the failure surface for one connection, and splits a diagnosis the supervisor already knows how to report. A preamble on the same script gets one session and one path.

**Refresh a managed installation on every connection.** Rejected because it makes a working host depend on the registry and the network every time it is used, to deliver an upgrade nobody asked for at that moment. Scoping the directory by version makes upgrading an explicit edit and leaves an installed host usable offline.

**Copy the desktop application's own embedded closure to the host.** Rejected as the general answer, and kept as the constraint on the one that shipped: that closure is built for the shell's platform, and a mac shell reaching a Linux host is the common case. A payload built for the host is what works, which is why the builder labels its platform and the shell refuses a mismatch.

**Build the payload on the shell's machine at connect time.** Rejected because the packaged application ships no Node and no package manager — that self-containment is the point of the packaging — so it cannot produce a closure for anything, least of all another platform. The payload is a build artifact a person produces once.

**Detect the host and pick the transport automatically.** Rejected because the two transports differ in what a person must prepare, not only in speed: falling back from the registry to a payload would need an archive nobody built. The connection says which one it uses, and each failure names what to change.

## Consequences

Remote development costs one library and one branch in the shell. Every harness capability on the far side is the one that ships, so a fix to terminals, language servers, or the sandbox needs no remote counterpart, and the window, notifications, Dock badge, and memory policy keep working unchanged.

The shell now depends on an OpenSSH client, and on a host that either carries a launcher or can install one, which means Node 22.19 or newer and npm. Authentication is agent- or key-file-only. The memory policy no longer measures the runtime when it is remote — the child is the `ssh` session, whose resident memory says nothing about the harness — so only the idle rule applies to it.

One failure mode remains outside the shell's reach: the stdin watchdog fires when sshd closes the channel, which needs sshd to notice the client is gone. `ClientAliveInterval` is disabled by default, so a link cut without a TCP FIN can leave the remote runtime waiting until TCP keepalive expires.

## Testing

Package tests pin the validation rules — including the option-shaped and control-character rejections, the path-safe version alphabet, and a server root that is neither absolute nor `~/`-prefixed — the argument vector, all three forms of the remote script, the probe and transfer plans, the forwarded-address mapping, the progress reader, and each diagnosis. Desktop tests drive the supervisor against a stand-in carrier that reports an address and ends when its stdin closes, using the real remote launch with its command line replaced: they prove the window is sent to the forwarded port, that the stop closes stdin rather than signalling, that a slow start shows what it is doing and stops showing it once the runtime serves, and that an address this machine cannot reach fails without restarting. The boot surface is rendered in jsdom against the same payload the shell sends it.

The remote script itself was exercised through a login shell, against a real launcher rather than a stand-in, on both provisioning paths: a host with no installation runs the npm install and emits the progress the shell reads, a provisioned host skips it and boots the real runtime, closing stdin stops it with no process left behind, and a runtime that exits on its own propagates its status. The payload path was exercised against an archive `package:remote-server` produced: the manifest and digest read back, the probe reports the host and refuses a foreign platform, the transfer unpacks and renames, and the unpacked runtime serves and stops.

**Running the script under more than one shell is part of that, not an extra.** The watchdog first shipped reading fd 0 directly, which works under `zsh` and fails under `sh` and `bash`: a shell with job control off gives an asynchronous command `/dev/null` for stdin before its explicit redirections, so the watchdog read end-of-file at once and killed the runtime it was meant to outlive. Keeping the session's stdin on a duplicated descriptor is the fix, and every shell a remote account is likely to have is where it is checked.

No CI gate covers this, for the reason the desktop application already documents: exercising the shell needs a windowing session, and a real connection needs a second host.
