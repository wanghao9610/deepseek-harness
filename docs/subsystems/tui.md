# Terminal front door

English | [中文](tui.zh.md)

The interactive terminal surface of [dsh-tui](../../packages/tui/tui). It owns terminal input and presentation only: the agent, its session, tools, commands, and the user-questions seam are the same services every other surface uses. [`@deepseek-ai/dsh-tui-app`](../../packages/bundle/tui-app/README.md) composes it into `dsh --profile tui`.

Source: [`packages/tui/tui/src/index.ts`](../../packages/tui/tui/src/index.ts)

## Terminal-local extension surface

`ctx.tui` exists only while a terminal is mounted, and it is how another plugin reaches the screen without reaching pi-tui. A plugin that injects it can queue an overlay — a component factory plus constrained layout options — into the same FIFO modal queue the model selector and user questions use. The request is an effect of the calling plugin's fiber, so unloading that plugin removes a queued overlay or closes a visible one before its cleanup settles.

What an overlay receives is deliberately narrow: the viewport, the semantic theme, display-text escaping, redraw, close, and a lifetime signal. It never receives the pi-tui tree, the terminal, the focus controller, or the overlay handle, so no plugin can take the screen away from the front door. Overlay state is live only: it is neither logged nor replayed.

`ctx.tuiPrompt` is the registry behind the status rows above the editor. A plugin registers a named value, sets it as its own state changes, and the front door re-renders the prompt template that references it. Values are trusted presentation fragments and may carry ANSI, because only the front door and pi-tui create control sequences — everything reaching the screen from a model, a session event, a tool presenter, or configuration passes through `displayText()` first, which renders C0 and C1 controls as visible `\xNN`.

`ctx.tuiResumeHost` runs the other way: the process, not a plugin, provides it, and the front door calls it when the user picks another session from `/resume`. The host disposes the app and replaces the process, so the resumed session runs in its own workspace directory. A composition that provides no host leaves foreign sessions selectable and reports that they are not resumable in place.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxtui--tuiextensionservice-abstract-seam"></a>

### `ctx.tui` — `TuiExtensionService` (abstract seam)

Optional terminal-local interaction service provided by one mounted TUI.

The concrete provider retains pi-tui, focus, and terminal lifecycle state. Plugins receive only effect-owned overlay sessions.

```ts cordis-catalog
/**
 * Queue an interactive overlay owned by the calling plugin fiber.
 *
 * The TUI displays one overlay at a time in FIFO order. Disposing the caller
 * removes a queued overlay or closes an active one before plugin teardown
 * settles. This live presentation is neither logged nor replayed.
 *
 * @param request - component factory, layout constraints, and cancellation.
 * @returns the effect-owned overlay session.
 * @throws when the TUI has begun shutting down.
 */
abstract openOverlay(request: TuiOverlayRequest): TuiOverlaySession
```

Source: [`packages/tui/tui/src/index.ts:222`](../../packages/tui/tui/src/index.ts)

<a id="ctxtuiprompt--tuipromptservice"></a>

### `ctx.tuiPrompt` — `TuiPromptService`

Context-global mutable values interpolated by TUI theme prompt templates. A registration, mutation, or disposal schedules one coalesced notification to the renderer subscribed with TuiPromptService.subscribe, so a value that changes on its own schedule (not only in response to a UI event) still redraws. Notification is a direct in-service callback, not a Cordis event.

```ts cordis-catalog
/**
 * Register one globally unique template value under the calling Cordis effect.
 * @param name - Lowercase slash-separated template name.
 * @param initialValue - Initial trusted ANSI-capable fragment.
 * @returns A mutable handle whose disposal unregisters the name.
 */
register(name: string, initialValue?: string): TuiPromptValueHandle

/**
 * Read a registered fragment without evaluating plugin code.
 * @param name - Exact registered template name.
 * @returns The current fragment, or `undefined` when unknown or unavailable.
 */
get(name: string): string | undefined

/**
 * Observe registration and value changes. The listener runs after a coalesced
 * microtask following any burst of mutations; the renderer re-reads current
 * values on that callback. The subscription is owned by the calling Cordis
 * effect, so it is removed when the subscriber's fiber disposes; the returned
 * disposer removes it early. Listener failures are contained — a synchronous
 * throw or a rejected returned promise cannot starve the other observers.
 * @param listener - Invoked once per coalesced change burst. Delivery does
 *   not wait on a returned promise; its rejection is only observed and logged,
 *   never left unhandled, so an async listener cannot order later observers.
 * @returns A disposer that removes the subscription.
 */
subscribe(listener: () => unknown): TuiPromptUnsubscribe
```

Source: [`packages/tui/tui/src/prompt.ts:104`](../../packages/tui/tui/src/prompt.ts)

<a id="ctxtuiresumehost--tuiresumehost"></a>

### `ctx.tuiResumeHost` — `TuiResumeHost`

Process-lifecycle owner used by the shipped CLI for an atomic resume handoff.

```ts cordis-catalog
/**
 * Dispose the current app and replace it with a runtime for `sessionId` in
 * `cwd`. Success does not return. A host may reject before it commits
 * teardown; after commit it owns fatal reporting and process exit.
 * @param sessionId - validated persisted session selected by the user.
 * @param cwd - the selected session's own workspace, which the replacement
 *   process must run in: process cwd, not the restored session header, is what
 *   filesystem and shell tools resolve against. It may differ from the current
 *   workspace, so a host that cannot enter it must reject before committing
 *   teardown.
 * @returns a promise that never fulfills; it rejects when the host declines
 *   before committing teardown, and after that point the host owns fatal
 *   reporting and process exit.
 */
handoff(sessionId: SessionId, cwd: string): Promise<never>
```

Types: [SessionId](core.md)

Source: [`packages/tui/tui/src/runtime.ts:13`](../../packages/tui/tui/src/runtime.ts)
<!-- END GENERATED cordis-surface -->
