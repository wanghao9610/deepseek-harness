# Agent Note: The harness-source section requires a real checkout

Status: implemented

English | [中文](2026-08-13-harness-source-section-requires-a-real-checkout.zh.md)

## Problem

The `harness:source` prompt section told every model that "The DeepSeek Harness implementation checkout is at `<path>`" and invited it to read that path to inspect or extend DSH. The path came from counting four directory levels up from the calling bundle's own module: correct for `packages/bundle/web-app/{src,lib}/` in this workspace, and wrong everywhere else.

An installed package sits at `node_modules/@deepseek-ai/dsh-web-app/lib/`, so the same four levels land on the install root. In the packaged desktop application that root is `<app>/Contents/Resources/backend/`, which holds `node_modules` and a generated dependency manifest — no `packages/` tree, no sources. The prompt therefore named a checkout that does not exist, in a section ordered ahead of the persona, on every request.

The cost is a model that acts on the claim. Asked how presets compose plugins, DeepSeek V4 wrote repository-relative paths (`packages/preset/src`) into `grep`; the search root does not exist, ripgrep exits 2, and `SEARCH_FAILED` ends the whole `run_code` program including the calls that would have succeeded. The [workdir distinction](2026-07-30-source-checkout-workdir-distinction.md) fixed what the section says about a checkout that is there; it left unchecked whether one is there at all.

## Decision

`resolveHarnessCheckout(moduleUrl)` in `dsh-app-boot` finds the checkout by walking the caller module's directory chain to the workspace root manifest, `@deepseek-ai/dsh-root`, and returns `undefined` when no ancestor carries it. The `dsh-web-app` and `dsh-tui-app` bundles pass its result straight to `addHarnessSourceSection`, which registers nothing for `undefined` — the same silent no-op it already had for a tree without a `systemPrompt` service.

The marker is the root manifest name rather than a `pnpm-workspace.yaml` or `packages/` probe, because dsh installed into an unrelated pnpm monorepo would satisfy those and claim that repository as the harness checkout.

A walk replaces the level count outright: the two layouts differ in depth, so no fixed count is right for both, and the walk stays correct if a package moves within the workspace. `addHarnessSourceSection` keeps taking an explicit root, so a composition that knows its checkout another way can still name one.

An installed application says nothing about a checkout. It has no readable sources to offer, and stating their absence would invite the model to hunt for them.

## Verification

`dsh-app-boot` unit tests resolve this workspace from the test module's own URL and assert the returned root contains `packages/boot/app-boot/package.json`, so renaming the root manifest fails loudly instead of silently dropping the section; a temp `node_modules/@deepseek-ai/<pkg>/lib/` tree with absent, unparsable, non-object, and foreign-named manifests on the way up resolves to `undefined`. A separate test asserts that an `undefined` root registers no section. The `dsh-web-app` and `dsh-tui-app` composition tests continue to observe the section from source.

## Alternatives considered

**Keep the path and describe it as an installed package tree.** Rejected: the model gains nothing actionable from compiled `lib/` output it was told is the implementation, and a second path near the top of the prompt is another candidate for the working directory the [workdir distinction](2026-07-30-source-checkout-workdir-distinction.md) had to rule out.

**Probe for `packages/` or `pnpm-workspace.yaml`.** Rejected: an install inside any pnpm monorepo matches, and the harness would announce a stranger's repository as its own source.

**Have each bundle test the resolved root before calling.** Rejected: the same conditional in every caller, with each bundle's uncovered false branch, for a rule the section owner can enforce once.

**Let the desktop application configure the checkout path.** Rejected: it does not have one to configure, and a config field would make a fact about the running code's location into a deployment choice.

## Consequences

A developer running from source keeps the section unchanged. Installed surfaces lose it, so a model asked about DSH internals there has no source path at all and must ask the user or work from the session workspace — which is what its situation actually is. The walk adds a handful of small manifest reads when the section is registered, once per surface mount.

Pointing an installed surface at the implementation it does ship — the `node_modules` package tree, with its type declarations and READMEs — remains open, and needs its own wording before a model is sent there.
