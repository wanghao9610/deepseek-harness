# 终端前端

[English](tui.md) | 中文

[dsh-tui](../../packages/tui/tui) 的交互式终端表层。它只持有终端输入与呈现：agent、它的 session、工具、命令与用户提问接缝，都是其他每个表层所用的同一批服务。[`@deepseek-ai/dsh-tui-app`](../../packages/bundle/tui-app/README.md) 把它组合进 `dsh --profile tui`。

源码：[`packages/tui/tui/src/index.ts`](../../packages/tui/tui/src/index.ts)

## 终端本地扩展表面

`ctx.tui` 只在终端已挂载期间存在，它是另一个插件够到屏幕而不必够到 pi-tui 的方式。注入它的插件可以把一个 overlay——一个组件工厂加上受约束的布局选项——排进模型选择器与用户提问所用的同一个 FIFO 模态队列。该请求是调用方插件 fiber 的 effect，因此卸载该插件会在其清理落定前移除排队的 overlay 或关闭可见的 overlay。

overlay 收到的东西刻意很窄：视口、语义主题、显示文本转义、重绘、关闭，以及一个生命周期 signal。它绝不会收到 pi-tui 树、终端、焦点控制器或 overlay handle，因此没有插件能从前端手里夺走屏幕。overlay 状态只存在于当下：既不记录日志也不回放。

`ctx.tuiPrompt` 是编辑器上方状态行背后的注册表。插件注册一个具名取值，随自身状态变化设置它，前端便重新渲染引用它的提示词模板。这些取值是受信任的呈现片段，可以携带 ANSI，因为只有前端与 pi-tui 创建控制序列——凡是从模型、会话事件、工具呈现器或配置抵达屏幕的内容，都先经过 `displayText()`，它把 C0 与 C1 控制字符渲染为可见的 `\xNN`。

`ctx.tuiResumeHost` 的方向相反：提供它的是进程而非插件，前端在用户从 `/resume` 选中另一个会话时调用它。host 会销毁应用并替换进程，使恢复的会话运行在它自己的工作区目录中。不提供 host 的组合会让外部会话仍可选中，并报告它们无法原地恢复。

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
