# Agent Note: the session a window shows belongs to that window

Status: implemented

English | [中文](2026-08-13-per-window-session-selection.zh.md)

## Problem

The Web client kept the current-Session selection in one `localStorage` cell, `dsh.sessions.current`, read once when `SessionRuntime` is constructed. `localStorage` is per origin, and every window of one browser profile shares it, so a second window on the same origin restored the first window's selection and opened the session it was already showing. Both windows then ran one conversation: a message sent in either appeared in both, and each kept writing the shared cell, so they also overwrote each other's idea of where they were.

The desktop application is where a user meets this. Its **New Window** opens another `BrowserWindow` on the same loopback origin in the same default partition, so what appeared was the previous window again — the report that started this work. Two browser tabs on `dsh web` had always behaved the same way; the desktop shell only made a one-keystroke path to it.

## Decision

The selection is per window, and the shell that opens a window says whether the window is a new one.

`createSnapshotStore`'s `persist` option takes a scope. `origin` is the previous behavior and stays the default for every other persisted store. `window` writes both `sessionStorage` and `localStorage` and reads the window's own cell first. `sessionStorage` is per top-level browsing context and survives reloads, renderer crashes, and navigating away and back within the same tab, which is the lifetime the selection wants; the shared cell degrades to a cold-start seed, so a window that has never selected anything starts where the browser left off and diverges from there. `dsh.sessions.current` is the one store that declares it.

`consumeWindowBoot` reads one address parameter, `new`, once per page load and strips it with `history.replaceState`. The client assembly reads it before constructing either domain service and hands the same answer to both: `SessionRuntime` drops the restored selection, and `WorkspaceRuntime.startInitialSelection` mints a session with `session.create` instead of calling `connectWorkspace`. That substitution is the whole point of the second half — `connectWorkspace` reuses the recent Workspace's blank session, which is exactly the session another window is likely sitting on, so blank reuse would put two windows back on one conversation the moment neither had typed anything yet.

The desktop shell loads the runtime address with that parameter for **New Window** only. The first window and a Dock activation load it plain and restore the last session, which is the behavior a person expects from reopening an application. `WindowHost` holds the request in a `WeakSet` and spends it on the window's first load of the harness UI, because a runtime restart re-routes every open window and each of those is the same window, not another new one.

Stripping the parameter on arrival is what makes a reload mean "show me this again". A directive left in the address bar would fire on every reload and mint a session each time.

## Alternatives considered

**A separate Electron session partition per window.** The shell could give each new window its own in-memory `partition`, isolating storage without touching the Web client. It fixes nothing a user would notice: with no persisted selection the new window falls through to the recent Workspace's blank session, which the first window is already showing, so the two still share a conversation. It also isolates everything else the window stores and leaves two browser tabs broken, since the bug is the Web surface's.

**Keeping the selection in `localStorage` and only adding the `new` parameter.** Simpler, and it fixes the reported symptom. It leaves the windows coupled afterwards: every window keeps writing the one cell, so a runtime restart — which re-routes each open window through a fresh page load — lands them all on whichever window last changed sessions.

**Moving the selection to `sessionStorage` alone.** Clean, and it drops cold-start restore: `sessionStorage` does not outlive the tab, so relaunching the application would land on a blank session instead of the conversation the user left. Keeping the shared cell as a seed costs one extra write per selection change and preserves that behavior.

**The shell creating the session over the API and passing its id.** Fully deterministic, and it makes the shell a harness client: `session.create` needs a Workspace, which means the shell would carry Workspace knowledge and a creation policy. The shell adds no harness capability by design; `new` states the intent and lets the Web client decide how a new session is made.

**Landing a new window on the New Session hero with no session at all.** No session is minted until the user sends something, so repeated ⌘N leaves nothing behind. It was rejected as the default because a window that shows an empty page is not what "new window" offers elsewhere; a window with no Workspace still lands there, which is the same fallback `startSession` uses.

## Consequences

Two windows of one profile hold two sessions and stop moving each other. Reopening the desktop application still restores the last session in its first window. The cost is that ⌘N always mints a session, so pressing it repeatedly without typing leaves blank sessions in the list — the price of guaranteeing the window is not showing what another window holds, and blank sessions are hidden from list surfaces.

Divergence rests on the origin. A runtime that comes back on a different port is a different origin with empty per-window storage, and every window there falls back to the shared seed — the windows converge again until each selects something. The desktop shell's local runtime reserves a loopback port per launch, so a restart is the case that hits it.

A plain second browser tab still lands on the seeded session, because nothing asked it for a new one. That is the browser's own convention for opening a second tab on an application, and the address parameter is available to anyone who wants otherwise.

## Testing

`store.client.spec.ts` pins the scope rule: window scope reads its own cell first, seeds from the shared one, writes both, and falls back to the shared cell alone where `sessionStorage` is absent — the node lane, where every other persisted store keeps its previous behavior unchanged. `window-boot.client.spec.ts` pins the parameter and its spending. `sessions-service.client.spec.ts` and `workspaces-service.client.spec.ts` pin the two halves of what a new window does: the restored selection is dropped even though it validates against the list, and the workspace's blank session is passed over for a fresh `session.create`.

`apps/web/tests/new-window-session.e2e.ts` is the assembled proof, and it needs two pages of **one** browser context — `browser.newPage` gives each page its own context, whose isolated storage would pass the scenario with the bug still in place. It opens a second window at `?new=1` over the real host, and asserts two different sessions, two sessions on the host, an address with the parameter spent, a reload that mints nothing, and a first window that never moved.

No gate covers the Electron shell's half; the desktop application has no CI gate at all ([desktop application Agent Note](../architecture/2026-08-13-electron-desktop-application.md)).
