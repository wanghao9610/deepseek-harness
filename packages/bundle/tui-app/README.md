# `@deepseek-ai/dsh-tui-app`

English | [中文](README.zh.md)

The interactive terminal bundle: the `tui` patch layer over [`dsh-base`](../base/README.md) plus the runtime glue plugin behind `dsh --profile tui`. The [profile front-door Agent Note](../../../.agents/notes/implemented/feature/2026-08-13-tui-profile-front-door.md) owns the composition decision; [`@deepseek-ai/dsh-tui`](../../tui/tui/README.md) owns terminal presentation and input.

```sh
dsh --profile tui                          # a fresh session in this directory
dsh --profile tui --resume                 # pick a session to resume from the list
dsh --profile tui --resume <session-id>    # resume that exact session
```

The profile auto-initializes on first use from the shipped template, so nothing needs installing first. The invoking directory is the workspace: the session `cwd`, relative paths, and workspace instructions all resolve from it. Sessions themselves live under the Harness home, so `/resume` reaches every workspace and resuming enters the selected session's own directory.

## What the patch adds

Over the shared base this layer configures the terminal persona, binds `agent-loop`'s `main` agent to this invocation, pins `fs-sandbox` to the process directory, and opens the `/resume` search index. It inserts Code Mode's worker-thread runtime, session references, the storage stack behind cached `/resume` titles, tmux and wall-clock context, the terminal front door with its prompt-value registry, and the model-facing `ask_user_question` tool whose keyboard UI the front door provides.

Row-by-row values are in the generated [config catalog](../../../docs/config-catalog.md); `dsh --profile tui --dump-config` prints the tree your machine actually boots.

## Command line

`tui-startup` owns this app's flags ([app-owned command line](../../../.agents/notes/implemented/architecture/2026-08-06-app-owned-command-line.md)) and publishes them as the `tuiStartup` service. Rows read the parsed invocation from lazy `!!js` expressions, so `dsh --profile tui --help` provides nothing, starts no agent, and never takes over the terminal.

`--resume` with an id binds that exact session at boot and fails loud when its log is missing. `--resume` without a value starts a fresh session and leaves the switch to the front door's own selector, which is the half that knows the persisted corpus.

## Config

| Key | Default | Meaning |
|---|---|---|
| `goodbye` | required | Line printed once the terminal is released on exit; the command that returns to this session |
| `queryIndexPath` | required | Absolute path of this process's disposable `/resume` search index, removed on disposal |
| `surfaceContext` | `true` | Register the harness-source and terminal-surface prompt sections |

## Model Experience

### Harness-source and terminal-surface context

#### What the model sees

When `surfaceContext` is true and this package runs from the repository checkout, the `harness:source` section identifies the on-disk Harness implementation without claiming it is the working directory; an installed copy has no checkout to read, so the section is absent rather than naming a path that holds no sources. The `app:terminal-surface` section (order −98) orients the model to the interactive terminal: replies render as Markdown, each tool call renders as its own card alongside the current plan, and the user can interrupt a turn, steer it mid-run, and answer questions — so asking beats guessing when a choice is theirs. When it is false, neither section is registered; a composition whose user is not at this terminal must turn it off, because the orientation text would otherwise be false.

#### Token effect

One source line and one prompt paragraph per session, about 90 tokens together; constant per process. The inserted `ask_user_question` row adds its own schema to the tool catalog, which [`dsh-tool-ask-user`](../../interaction/tool-ask-user/README.md) owns.

#### KV Cache effect

Both sections sit near the system prompt's head and are fixed for the life of the process, so they never invalidate the cache across turns.

## Known Limitations and Deferred Work

- **The resume handoff needs `process.execve`.** In-place `/resume` replaces this process so the resumed session runs in its own workspace. Where Node does not expose `execve` (Windows, and any build without it), the glue provides no handoff and the front door reports that the session is selectable but not resumable in place. Resuming there means exiting and rerunning with `--resume <id>`.
- **There is no `--continue`.** Reopening the most recent session in this workspace without picking one needs a corpus query, and the startup plugin runs before any session service exists. The honest place for it is the front door, which already scans candidates for its selector: a config flag telling it to auto-select the newest current-workspace row on mount. Until then, `--resume` opens the selector.
