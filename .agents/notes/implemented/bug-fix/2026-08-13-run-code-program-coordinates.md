# Agent Note: run_code failures speak the program's coordinates

Status: implemented

English | [中文](2026-08-13-run-code-program-coordinates.zh.md)

## Problem

A `run_code` exception reached the model as V8's raw stack for the dynamically constructed function the program runs as, and both halves of every frame in it were about something other than the program.

The line number counted three synthesized lines that precede the model's first one: V8's `async function anonymous(<params>` header, its `) {` line, and the worker's own `'use strict';` directive. A failure on the program's line 2 was therefore reported at line 5. The host is careful here — the type-strip wrapper is position-preserving precisely so the body slices back out with the model's own line and column — and the worker then shifted every line by three. A model self-correcting from that reads the wrong statement, and the longer the program, the more plausible the wrong line looks.

The location half named the worker file's absolute path on the host disk. In the packaged desktop application that is `/Applications/DeepSeek Harness.app/Contents/Resources/backend/node_modules/@deepseek-ai/dsh-code-runtime-worker-thread/lib/worker.cjs`, so every exception diagnostic told the model where the harness is installed and nothing it could act on.

The case that surfaced it: `const [selfMod] = await tools.glob({ pattern: … })` on the program's second line, where `glob` answers `{ root, paths }` rather than an array, produced `TypeError: (intermediate value) is not iterable\n    at eval (eval at runWorkerMain (/Applications/…/worker.cjs:887:31), <anonymous>:5:19)`.

A program rejected by the type-strip was worse: it reported no location whatsoever. `stripTypeScriptTypes` throws with the wrapped line, a source window, and a caret column in its `stack`, and the host kept only `error.message` — so a malformed object literal read as `Unexpected token \`{\`. Expected identifier, string literal, numeric literal or [ for the computed key` and nothing else, from a program of any length.

## Decision

The worker bootstrap restates the thrown error's stack in the program's coordinates before the diagnostic crosses the port. `normalizeProgramStack` keeps everything before the first frame verbatim — the message, including a multi-line one — rewrites each frame V8 attributed to the compiled program as `program:<line>:<column>`, and drops every other frame: this file, Node internals, and the host paths they name. V8's name for the program's own top-level frame is `eval`, which renders bare (`at program:2:19`); any other name keeps its identifier and `async` prefix (`at async step (program:2:3)`).

`programHeaderLines` measures the shift instead of assuming it, by locating the body verbatim inside `Function.prototype.toString()` of the very function that was constructed and counting the lines before it plus the directive's own. V8's header rendering is not a contract anyone owes us, and the arithmetic runs only on the failure path.

A body that never compiled reports its message with no location at all: the constructed function does not exist, so nothing relates a reported line to a written one, and inventing one would be worse than omitting it.

The host translates the strip rejection on the same terms. `programSyntaxLocation` reads the stripper's leading `:<line>` marker and the caret line that underlines the offending span, subtracts the strip wrapper's own line count — derived from the wrapper text, not restated — and renders `program:<line>:<column>`; the diagnostic keeps the error's name so a parse failure reads like any other. Two cases yield no location rather than a wrong one: a diagnostic with no line marker, and a line outside the program, which is where an unterminated program lands because the parser reaches the brace the wrapper appended. A missing caret still reports the line alone.

`program-location.ts` owns both the `program:<line>:<column>` rendering and that recovery, because the two failure paths run in different processes — the parse on the host, the throw in the worker — and a model reading one after the other must not meet two vocabularies.

`CodeRunFailure`'s `'exception'` kind carries the obligation at the seam — the message states the failure in the program's own coordinates and names no implementation file or host path — so a future backend translates its own traceback rather than repeating the leak.

## Verification

`normalizeProgramStack` and `programHeaderLines` are pure and unit-tested directly: the real packaged-application stack maps to `at program:2:19`, a multi-line message keeps both lines, method and awaited frames keep their names, and an unmeasurable header drops every frame. `programHeaderLines` asserts the property rather than the constant — skipping the measured count lands exactly on the model's first line — so a change in V8's header rendering cannot pass as correct.

The in-process `runWorkerMain` suite replays the originating case: destructuring a tool's object answer reports exactly `TypeError: (intermediate value) is not iterable\n    at program:2:17`, and `return (` reports a one-line `SyntaxError`. A real-worker test pins a named helper and the top level together (`at first (program:2:40)`, `at program:3:8`) through the spawned isolate, where the frames the filter drops are the actual worker file's.

The parse path is pinned through `runtime.run()` against the real stripper: the malformed object literal reports `at program:2:56`, `enum E { A }` reports `at program:1:1`, and `const x = (` reports a single message line. `programSyntaxLocation`'s own suite covers the caret column, a caret-less diagnostic, both out-of-program lines, and a diagnostic with no marker.

## Alternatives considered

**Subtract a hardcoded three lines.** Rejected: the constant is V8's to change and ours to be wrong about, and a wrong offset is invisible — every reported line stays plausible. Measuring costs one `indexOf` when a program has already failed.

**Compile with `vm.compileFunction`, giving the program a `filename` and `lineOffset`.** Rejected: V8 would attribute the program's own frames correctly, but the harness frames and their host paths still ride the same stack, so the filter is needed either way; getting an async body out of it also means wrapping the program in a second function, which changes the execution path to buy what the filter already delivers.

**Normalize in `dsh-tools`, where the diagnostic is rendered.** Rejected: the header size is knowable only where the function was constructed, and the seam states that a failure message is already model-ready — a consumer repairing it would make every other consumer repair it too.

**Keep the harness frames for debugging.** Rejected: the model is the only reader of this text, the frames name nothing it can act on, and the host's own logs are where a harness bug is diagnosed.

**Quote the offending source line into the message, or forward the stripper's source window as it stands.** Rejected: the model has its program text in the same turn, the excerpt competes with the captured output for the same bounded byte budget, and the stripper's window shows the wrapper line the model never wrote next to its own code.

**Clamp an out-of-program line to the program's last line.** Rejected: it would turn "the parser ran off the end" into a confident claim about a specific statement, which is exactly the failure mode this Agent Note exists to remove.

## Consequences

A failed program now points at the statement the model wrote, so the next attempt edits that line instead of a line three below it, and no diagnostic carries the install location. A rejection raised inside a binding arrives as its message plus whichever program frames awaited it — the worker frames that created it are gone. The `'exception'` kind is the only failure whose message is translated; budgets, aborts, and substrate deaths already spoke in their own terms.

Two shapes stay deliberately locationless: a diagnostic that names a line outside the program, and a body the worker could not construct. Both are honest gaps rather than a nearest-line guess, and both keep the message that says what the parser wanted.
