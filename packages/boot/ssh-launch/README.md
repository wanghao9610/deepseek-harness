# `@deepseek-ai/dsh-ssh-launch`

English | [中文](README.zh.md)

Launch planning for a harness runtime that serves from another host over SSH. A pure library: it registers nothing on a Cordis context and starts no process. The shell that owns runtime lifetime — [`apps/desktop`](../../../apps/desktop/README.md) today — spawns the plan, allocates the loopback port, and applies its own restart policy.

The package owns three decisions:

| Decision | Export |
|---|---|
| What a stored connection may contain | `SshTarget`, `RemoteLauncher`, `validateSshTarget`, `readSshTargets`, `resolveSshTarget` |
| What `ssh` is asked to do with it | `planSshLaunch`, `planPayloadProbe`, `planPayloadTransfer`, `remoteCommandLine`, `quoteRemoteArgument`, `pickRemotePort` |
| What the result means | `verifyForwardedUrl`, `readHostProbe`, `describePayloadMismatch`, `readProgress`, `diagnoseSshFailure` |

## Validation is the enforcement point

Every field of an `SshTarget` reaches either an `ssh` argument or the remote login shell, and both a settings file and a form are boundaries a person can write. `validateSshTarget` therefore refuses what would change the meaning of the command rather than its arguments: a host, user, or jump host beginning with `-`, which `ssh` reads as an option — `ProxyCommand` among them, which executes on the shell's own machine — and control characters anywhere. `readSshTargets` applies the same rule when recovering a stored list, discarding an entry this build cannot use instead of failing the whole list.

Values that survive validation are still quoted: `remoteCommandLine` puts every configured word through `quoteRemoteArgument`, because sshd hands the account's shell one string rather than an argument vector.

## The `ssh` command line

`planSshLaunch(target, ports)` returns `{command, args, localOrigin}` for one session that both starts the runtime and forwards its loopback port back:

| Option | Why |
|---|---|
| `BatchMode=yes` | A desktop shell has no terminal to answer a prompt on. A connection needing one fails with a diagnosis instead of waiting forever, which also means the host must accept an ssh-agent identity or an unencrypted key file. |
| `ExitOnForwardFailure=yes` | A forward that did not bind would otherwise leave a healthy-looking session in front of a port nothing answers. |
| `ServerAliveInterval` / `ServerAliveCountMax` | A dropped link surfaces as an `ssh` exit the supervisor can restart. Passed as `-o`, so they override the user's own `ssh_config` for this one connection. |
| `-T` | The runtime's stdout carries the readiness line and its log; a pty would rewrite both. |
| `-L` | The forward the window and the API client reach. |

Everything the target does not name — user, port, identity, jump hosts — is left to the user's own `ssh` configuration, which stays authoritative.

## The remote script

`remoteCommandLine` emits a script that supervises the runtime from the far side in both directions, because neither can be recovered from the other: killing the local `ssh` does not reach a runtime sshd already detached from the channel, and a runtime that exits on its own would leave `ssh` connected to a session serving nothing. It backgrounds the runtime, waits for it, and exits with its status; a shell built-in read — not a helper process, which would keep holding the session's stdin after being killed — ends the runtime when stdin closes.

That watchdog reads from a duplicate of the session's stdin rather than from stdin itself. A shell with job control off gives every asynchronous command `/dev/null` for stdin *before* its explicit redirections, so a watchdog reading fd 0 sees end-of-file the instant it starts and kills the runtime it was meant to outlive — on `sh` and `bash`, though not on `zsh`.

**The caller owes this script an open stdin for the life of the runtime.** Closing it is the graceful stop and reaches the runtime as the `SIGTERM` that runs its own disposal; a launch whose stdin is `/dev/null` ends the runtime the moment it starts.

By default the script resolves the launcher through a login shell, because `ssh host <command>` runs a non-interactive shell whose `PATH` frequently omits a user-level npm prefix. A target naming an absolute launcher can turn that off.

## The server root

One directory on the host holds everything a connection touches, so removing it undoes every visit:

```
~/.dsh-server/            the server root, exported to the runtime as DSH_HOME
  bin/<version>/          an installation from the registry
  bin/<version>-<digest>/ an installation from a payload this machine sent
  sessions/ storages/     what the runtime itself writes
```

A connection can name another root — absolute, or `~/`-prefixed — and that one root moves the installations and the data together. The path is built on the far side because only the far side knows where `$HOME` is.

## Where the launcher comes from

`RemoteLauncher` is exclusive, and the three cover what a host can reach:

| Launcher | For a host that | Installs to |
|---|---|---|
| `{kind: 'managed', version?}` | can reach the npm registry | `bin/<version>` |
| `{kind: 'archive', path}` | can reach nothing — the payload comes from this machine | `bin/<version>-<digest>` |
| `{kind: 'host', command}` | already carries a launcher | — |

A target that names none gets a managed installation: a host already carrying one is the exception, and a `PATH` lookup that quietly finds the wrong `dsh` is worse than an installation the shell owns. Both installed forms ignore the account's `PATH` entirely, which is what makes them work on a host whose login shell has none.

A registry install is a preamble on the same script, so provisioning and launching are one `ssh` session and one authentication:

```sh
dsh_dir="$dsh_home/bin/<version>"
dsh_launcher="$dsh_dir/node_modules/.bin/dsh"
if [ ! -x "$dsh_launcher" ]; then …node and npm checks… npm install --prefix "$dsh_dir" …; fi
```

**A present launcher is the whole check.** A later connection needs no registry and no network, and nothing upgrades on its own: the directory is scoped by what the connection asked for, so changing that is what moves a host. Version and digest names are validated to a path-safe alphabet, which is what lets the script interpolate one into a path without quoting it.

The preamble announces its steps with the `dsh-remote: ` prefix `readProgress` reads, because installing takes minutes and a shell showing nothing looks stalled. It also names its own failures — no Node, a Node too old, no npm, a failed install, an install that left no launcher, no tar, a payload that did not unpack — as exit statuses `diagnoseSshFailure` reads directly, since those are the only failures whose meaning does not have to be recovered from the output.

## Sending a payload to a host with no network

The shell reads what the archive says it is, asks the host one question, and streams the archive into an `ssh` that unpacks it. Nothing is staged on either machine.

`planPayloadProbe` asks that one question and gets both answers on one round trip: what the host is, and whether it already carries this payload. The first is not a formality — **a payload runs only on the platform it was built for.** The closure it carries includes compiled modules the runtime imports at boot, so a payload built elsewhere is a runtime that cannot start rather than one that starts degraded; `describePayloadMismatch` turns that into a refusal before any bytes move. Build the payload on a machine matching the host: `pnpm run package:remote-server`.

`planPayloadTransfer` unpacks beside the destination and renames into place, so an interrupted transfer leaves nothing a later probe would mistake for a complete installation. A payload carries no Node of its own — it replaces the registry, not the runtime under it — so the launch still refuses a host whose Node is too old. Its launcher is the package entry, `node_modules/@deepseek-ai/dsh/lib/bin.js`: a deployed closure is a dependency tree, not an npm installation, and has no `node_modules/.bin`.
## The two ports

The shell allocates the local end by binding it, which it can do on its own machine. Nothing can prove a remote port is free before the runtime binds it, so `pickRemotePort` draws from the IANA dynamic range and a collision is a launch failure the caller retries with a fresh pick — the same path that handles a local collision.

The remote runtime reports the address it bound on its own host, and only the forwarded port reaches the shell. `verifyForwardedUrl` refuses any other address rather than pointing a window at a port serving something else.

## Model Experience

None, as this library plans a process launch for a shell that runs outside any harness context; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **No interactive authentication.** `BatchMode=yes` is what keeps a failed connection from hanging a windowed shell forever, and it rules out password, keyboard-interactive, and encrypted-key prompts. A shell that wants those must own a prompt surface and drop the option for that connection.
- **A silently dropped link can outlive the remote runtime.** The stdin watchdog fires when sshd closes the channel, which needs sshd to notice the client is gone: `ClientAliveInterval` is disabled by default, so a link cut without a TCP FIN can leave the remote runtime waiting until TCP keepalive expires.
- **The profile is not exposed to a form.** A shell serving a window requires a profile that serves HTTP, so `profile` stays a stored field rather than a choice a person makes while adding a host.
- **A registry installation needs npm on the host.** A host with no Node, a Node older than the launcher supports, or no npm is refused with a diagnosis rather than provisioned another way; a payload is the answer for a host that has Node but no registry.
- **A payload is platform-locked and produced elsewhere.** It carries compiled modules, so one built on macOS cannot serve a Linux host, and this package builds none: `pnpm run package:remote-server` produces one for the machine it runs on.
- **No installation is upgraded in place.** What the connection asks for scopes the directory, so a host stays on what it first installed until the connection asks for something else. A dist-tag that has moved since — `latest` among them — does not move the host.
- **OpenSSH only.** The plan is an OpenSSH client command line; another client's options are not translated.
