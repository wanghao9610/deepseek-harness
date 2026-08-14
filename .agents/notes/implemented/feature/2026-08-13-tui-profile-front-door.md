# Agent Note: The interactive terminal as a dsh profile

Status: implemented

English | [中文](2026-08-13-tui-profile-front-door.zh.md)

## Problem

`dsh` shipped two installable surfaces — `web` and `headless` — and no interactive terminal. The full-screen TUI package had been [removed with the legacy entry points](../../archived/feature/2026-07-17-dedicated-full-screen-tui-front-door.md) when profiles replaced the old `--config` launcher, on the expectation that an out-of-tree app would carry it. That left the product's most-used shape of coding agent outside the repository: no shipped interactive front door, no terminal transcript under the snapshot gate, and no in-tree consumer for the tool-presentation, question, resume, or model-selection surfaces the core registers for it.

Restoring the old wiring verbatim was not available. The launcher no longer owns app flags, session identity, or per-surface config: [apps own their command lines](../architecture/2026-08-06-app-owned-command-line.md), and [profiles compose bundles](../architecture/2026-08-05-profile-plugin-bundles.md). The removed CLI entry parsed `--resume` itself and pushed identity in through `ctx.provide` before the Loader ran, a channel that no longer exists for a bundle-composed app.

## Decision

DeepSeek Harness ships the interactive terminal as the `tui` profile: [`@deepseek-ai/dsh-tui`](../../../../packages/tui/tui/README.md) is the front-door plugin, and [`@deepseek-ai/dsh-tui-app`](../../../../packages/bundle/tui-app/README.md) is the bundle that composes it over `dsh-base`. `dsh --profile tui` auto-initializes from the shipped template exactly like `web` and `headless`.

The front-door package keeps the boundary the original decision drew: terminal input and presentation only, over the same agent, session, tool, command, and user-question services every other surface uses, with a hard TTY requirement rather than a silent line-oriented fallback. It now lives in [`packages/tui/`](../../../../packages/tui/README.md) rather than the retired `ui/` group; that group names the terminal half of the GUI, parallel to `client/` and `host/`.

### Invocation values reach rows as config, not host slots

`tui-startup` injects `cmdlineArgs`, parses `--resume [session]`, resolves this invocation's exact `SessionId`, and provides `tuiStartup`. Every row that depends on the invocation injects that service and reads it from a lazy `!!js` expression: `agent-loop` binds `main` to the resolved identity, `session-query-sqlite` opens the process-local `/resume` index, and the `tui` row renders that same id. `MAIN_SESSION_ID_KEY` and `CONFIGURED_AGENT_IDENTITIES_KEY` are therefore unused by this composition — identity is ordinary patchable config that a later layer can read but not silently drop, because a patch replacing the `agent-loop` row's config also replaces the expression that supplied it.

`--resume` without an id enters with a fresh session and lets the UI's own selector perform the switch, because only the mounted front door knows the persisted corpus. Only an explicit id binds the boot identity. There is deliberately no `--continue`: picking the newest session in this workspace needs a corpus query, and the startup plugin runs before any session service exists, so the flag would have to lie about what it does.

### One ordering edge, expressed as a dependency

`tui-app` publishes the optional host slots the front door reads through `ctx.get` — the in-place resume handoff and the exit line — and the `tui` row injects `tuiGoodbyeMessage`, the last of them. Loader mounts siblings concurrently, so without that injection the front door could take over the terminal before the handoff existed and silently lose in-place `/resume`. Naming the real value as a dependency orders the two rows without inventing a marker service.

### The startup banner carries the official mark

The banner draws the DeepSeek mark above `DEEPSEEK HARNESS`, rasterized from the shipped `assets/deepseek-color.svg` — the same icon the deepseek.com wordmark carries — at three fixed tiers with a printable-ASCII twin for terminals that cannot be trusted with block-drawing characters. Terminal width picks the tier and a row budget of a third of the viewport drops to a smaller mark, then out entirely, so a short terminal still opens on conversation. The rasters are static assets: nothing is generated at runtime, and the mark takes the brand ink on truecolor terminals and the theme's accent role otherwise.

## Verification

The package's 240 direct behavior tests and its committed terminal-state snapshots both run in-tree again, and every golden now records the banner mark. `packages/tui/*/tests/**/*.snapshot.ts` joins the keyless snapshot lane, which replays through a headless xterm rather than a subprocess.

Three behaviors changed with the core and were updated with their tests rather than preserved: steering enters the durable log as an ordinary `user/message` and renders with the same `You` header as any other prompt; a turn's cancellation cause reaches the transcript through `turn/end`'s `aborted` reason instead of a separate `disposed` kind; and the attached session-reference snapshot rides the prompt's own `agent/pre-step` admission instead of the removed `agent/prompt-submit` waterfall, so a rejecting listener drops prompt and snapshot together.

## Alternatives considered

- **Push identity through `ctx.provide` before the Loader runs, as the removed launcher did** — rejected: a bundle-composed app has no pre-Loader hook of its own, and reintroducing one would make every profile's launcher carry surface-specific knowledge again, which is exactly what the app-owned command line removed.
- **Keep the TUI out of tree and depend on the published package** — rejected: the terminal transcript is a product surface the snapshot gate must cover, and an out-of-tree consumer cannot be updated in the same change as the core APIs it renders. The three behavior changes above would each have shipped as a silent break.
- **Give `tui-app` a marker service purely to order the `tui` row after it** — rejected: the ordering need is real but a contentless service hides what is actually depended on. Injecting the exit line names the value whose absence would break the surface.
- **Redraw the mark as hand-tuned ASCII art** — rejected: a redrawn contour is a second source of truth for brand identity. Rasterizing the shipped icon keeps the terminal mark and the website mark the same drawing.

## Consequences

- `dsh --profile tui` is an installable interactive coding agent with the resume selector, model selector, slash commands, question dialogs, tool cards, plan strip, and file/session `@` references the package already implemented.
- The editor's frame and fixed-width prompt prefixes are why `pi-tui` is now source-vendored as `@deepseek-ai/tui` under [`vendor/tui/`](../../../../vendor/tui/README.md). A pnpm `patchedDependencies` patch reaches only this workspace, so the packed `@deepseek-ai/dsh-tui` resolved a pristine `0.80.7` whose `Editor.setPrompt` is undefined and threw on its first render — verified against a real packed install before the vendoring. The vendored copy publishes with the harness, so consumers get those APIs; the cost is that a pi-tui upgrade must re-apply local modification 19 in [`vendor/README.md`](../../../../vendor/README.md).
- The three core-API changes above are now pinned by an in-tree consumer: a future change to inbox notifications, turn-end reasons, or step admission fails the TUI suite instead of an external repository.
- Every terminal-state golden includes the banner mark, so a change to the raster tiers or their selection is a reviewable diff across the whole snapshot set rather than a silent visual change.
