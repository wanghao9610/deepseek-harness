/**
 * Worker-side execution logic, written as plain functions over an injected port so the unit
 * suite can run every line IN-PROCESS against a fake port (a real worker thread is a separate
 * V8 isolate the coverage provider cannot observe).
 * @module @deepseek-ai/dsh-code-runtime-worker-thread/src/bootstrap
 */

import { inspect } from 'node:util'
import type { DoneMessage, ReplyMessage, WorkerBootData, WorkerToHost } from './protocol.ts'
import { jsonStringBytesUpTo, jsonValueBytesUpTo, truncateJsonStringBytes } from './output-json.ts'
import { programLocation } from './program-location.ts'
import { decodeWorkerJson, encodeWorkerJson, snapshotCodeJsonValue } from './worker-json.ts'

const CapturedError = Error
const capturedObjectCreate = Object.create
const capturedObjectDefineProperty = Object.defineProperty

/** Define one public binding-error field without consulting mutable globals or descriptor prototypes. */
function defineBindingErrorField(error: Error, key: string, value: string): void {
  const attributes = capturedObjectCreate(null) as PropertyDescriptor
  attributes.enumerable = true
  attributes.value = value
  capturedObjectDefineProperty(error, key, attributes)
}

/** The port API the bootstrap needs — satisfied by `parentPort` and by the tests' fake. */
export interface BootstrapPort {
  postMessage(message: WorkerToHost): void
  on(event: 'message', listener: (message: ReplyMessage) => void): void
}

/**
 * A writable stream's `write` slot, as the bootstrap patches it (see
 * {@link captureStreamWrites}). Method-typed so the real
 * `process.stdout`/`process.stderr` (narrower chunk parameters) remain
 * assignable.
 */
export interface PatchableStream {
  write(chunk: unknown, ...rest: unknown[]): boolean
}

/**
 * Ordered text capture under the shared outer JSON-byte budget, delivered to
 * a sink as each item lands (the real sink streams text over the port eagerly,
 * so captured output survives a mid-run termination). It includes the log
 * array syntax and string escaping in its accounting. Once exhausted it emits
 * the fitting prefix and reports the limit once; the host turns that condition
 * into an explicit `output-limit` run failure.
 */
export class LogBuffer {
  private bytes = 2 // JSON serialization of the empty logs array: []
  private entries = 0
  private truncated = false
  // Explicit fields, not constructor parameter properties: this module loads
  // under Node's native strip-only mode, which rejects non-erasable syntax —
  // and parameter properties are non-erasable.
  private readonly sink: (text: string) => void
  private readonly onLimit: () => void
  private readonly maxBytes: number

  constructor(maxBytes: number, sink: (text: string) => void, onLimit: () => void = () => {}) {
    this.maxBytes = maxBytes
    this.sink = sink
    this.onLimit = onLimit
  }

  /**
   * Emit text to the sink, charging it against the budget (drops + marks once exhausted).
   * @param text - the captured text to deliver.
   */
  push(text: string): void {
    if (this.truncated) return
    const separatorBytes = this.entries > 0 ? 1 : 0
    const availableBytes = this.maxBytes - this.bytes - separatorBytes
    const stringBytes = jsonStringBytesUpTo(text, availableBytes)
    if (stringBytes === undefined) {
      this.truncated = true
      const prefix = truncateJsonStringBytes(text, availableBytes)
      if (prefix.length > 0) {
        const prefixBytes = jsonStringBytesUpTo(prefix, availableBytes)
        /* v8 ignore next -- truncateJsonStringBytes guarantees the returned prefix fits. */
        if (prefixBytes === undefined) throw new CapturedError('worker output ledger produced an oversized log prefix')
        this.bytes += prefixBytes + separatorBytes
        this.entries += 1
        this.sink(prefix)
      }
      this.onLimit()
      return
    }
    this.bytes += stringBytes + separatorBytes
    this.entries += 1
    this.sink(text)
  }

  /** Remaining exact JSON-byte budget for the completion value or failure message. */
  remainingOutputBytes(): number {
    return this.maxBytes - this.bytes
  }
}

/** The five console methods the shim captures, in the seam's level vocabulary. */
const CONSOLE_LEVELS = ['log', 'info', 'warn', 'error', 'debug'] as const

/**
 * A `console` replacement whose five leveled methods render their arguments
 * `util.inspect`-style (matching real console formatting closely enough for
 * a model to recognize its own output) into the buffer. Only these five
 * exist — the program gets a deliberately small console, not Node's full
 * console API.
 * @param logs - the buffer every rendered line is pushed into.
 * @returns the five-method console object handed to the program.
 */
export function makeConsoleShim(logs: LogBuffer): Record<(typeof CONSOLE_LEVELS)[number], (...args: unknown[]) => void> {
  const render = (args: unknown[]): string =>
    args.map(arg => typeof arg === 'string' ? arg : inspect(arg, INSPECT_OPTIONS)).join(' ')
  const shim = Object.create(null) as Record<(typeof CONSOLE_LEVELS)[number], (...args: unknown[]) => void>
  for (const level of CONSOLE_LEVELS) {
    shim[level] = (...args: unknown[]) => { logs.push(render(args)) }
  }
  return shim
}

/**
 * Redirect a stream's `write` into the log buffer (the program-visible
 * `process.stdout`/`process.stderr` in the real worker), so raw writes land in emission order
 * alongside console output instead of racing down a pipe. It preserves Node's optional callback
 * contract: the callback runs asynchronously after admission, even when the log budget drops
 * the write.
 *
 * @param logs - the buffer captured writes are pushed into.
 * @param stream - the stream whose `write` slot is patched.
 * @returns the restore function (the in-process tests un-patch; the real
 *   worker never needs to).
 */
export function captureStreamWrites(logs: LogBuffer, stream: PatchableStream): () => void {
  // The slot's VALUE is stored for restore and reassigned — never invoked
  // detached, so the unbound-method concern does not apply.
  // oxlint-disable-next-line typescript/unbound-method
  const original = stream.write
  stream.write = (chunk: unknown, ...rest: unknown[]): boolean => {
    logs.push(typeof chunk === 'string' ? chunk : String(chunk))
    // Node's optional-encoding shape: the callback is whichever of the next
    // two positions holds a function (a non-function there is the encoding).
    const callback = [rest[0], rest[1]].find(
      (arg): arg is (error?: Error | null) => void => typeof arg === 'function',
    )
    if (callback) queueMicrotask(() => { callback(null) })
    return true
  }
  return () => { stream.write = original }
}

/** Bounded inspect options: deep enough to be useful, bounded so a pathological value cannot explode the rendering. */
const INSPECT_OPTIONS = { depth: 4, maxArrayLength: 100, maxStringLength: 10_000 } as const

/**
 * Prepare the program's completion value for the done message. Only lossless
 * JSON crosses, and a value that does not fit the remaining combined outer
 * budget reports `output-limit`; the host revalidates hostile traffic and
 * remains authoritative for native pipe writes the worker cannot observe.
 *
 * @param value - the program's completion value.
 * @param remainingOutputBytes - exact bytes left after captured logs.
 * @param maxOutputBytes - the configured cap named in an overflow diagnostic.
 * @returns the done-message fragment: `{}` for `undefined`, else a flat wire `{ value }`.
 */
export function prepareCompletion(
  value: unknown,
  remainingOutputBytes: number,
  maxOutputBytes: number = remainingOutputBytes,
): Omit<DoneMessage, 'type'> {
  if (value === undefined) return {}
  let snapshot: ReturnType<typeof snapshotCodeJsonValue>
  try {
    snapshot = snapshotCodeJsonValue(value)
  } catch {
    snapshot = undefined
  }
  if (snapshot === undefined) {
    return prepareFailure(
      'invalid-output',
      'program completion must be lossless JSON',
      remainingOutputBytes,
      maxOutputBytes,
    )
  }
  if (jsonValueBytesUpTo(snapshot, remainingOutputBytes) === undefined) {
    return outputLimit(maxOutputBytes)
  }
  return { value: encodeWorkerJson(snapshot) }
}

/** Build the fixed overflow fragment without carrying rejected variable bytes. */
function outputLimit(maxOutputBytes: number): Omit<DoneMessage, 'type'> {
  return { error: { kind: 'output-limit', message: `outer output exceeded ${maxOutputBytes} bytes` } }
}

/** Admit one bounded failure message or replace it with the fixed overflow diagnostic. */
function prepareFailure(
  kind: 'exception' | 'invalid-output',
  message: string,
  remainingOutputBytes: number,
  maxOutputBytes: number,
): Omit<DoneMessage, 'type'> {
  if (jsonStringBytesUpTo(message, remainingOutputBytes) === undefined) return outputLimit(maxOutputBytes)
  return { error: { kind, message } }
}

/**
 * The strict-mode directive the program body opens with. It occupies the
 * body's first line, so the model's line 1 is the body's line 2.
 */
const PROGRAM_DIRECTIVE = "'use strict';\n"

/** Any rendered stack frame, in V8's fixed `<indent>at ` form. */
const STACK_FRAME = /^\s+at /

/**
 * One frame in code the `Function` constructor compiled:
 * `    at <name> (eval at <worker frame>, <anonymous>:<line>:<column>)`. The
 * embedded worker frame names this file's absolute path on the host disk, and
 * the `<anonymous>` line counts V8's synthesized header, so neither half is
 * what the model wrote.
 */
const PROGRAM_FRAME = /^\s*at (.+?) \(eval at .+, <anonymous>:(\d+):(\d+)\)$/

/** V8's name for the program's own top-level frame (a user function cannot take it: `eval` is not a bindable strict-mode name). */
const TOP_LEVEL_FRAME = 'eval'

/** The prefix V8 puts on an awaited frame's name, preserved ahead of the rewritten location. */
const ASYNC_PREFIX = 'async '

/**
 * Count the synthesized lines that precede the model's first program line:
 * V8's dynamic-function header plus {@link PROGRAM_DIRECTIVE}. Measured from
 * the constructed function instead of assumed, so a change in how V8 renders
 * that header cannot silently shift every location the model reads.
 * @param source - `Function.prototype.toString()` of the constructed program.
 * @param body - the exact body text passed to the constructor.
 * @returns the leading line count, or `undefined` when the body is absent from
 *   the source (nothing then relates a reported line to a written one).
 */
export function programHeaderLines(source: string, body: string): number | undefined {
  const bodyStart = source.indexOf(body)
  if (bodyStart < 0) return undefined
  const linesBeforeBody = source.slice(0, bodyStart).split('\n').length - 1
  return linesBeforeBody + PROGRAM_DIRECTIVE.split('\n').length - 1
}

/**
 * Restate one thrown error's stack in the program's own coordinates: each
 * frame V8 attributed to the compiled program becomes
 * `program:<line>:<column>` counted from the model's first line, and every
 * other frame — this file, Node internals, and the host paths they name — is
 * dropped. The model reads the line it wrote and learns nothing about where
 * the harness lives on disk. The message is everything before the first frame,
 * kept verbatim.
 * @param stack - the raw `Error.prototype.stack` text.
 * @param headerLines - synthesized lines preceding the program's line 1
 *   ({@link programHeaderLines}); `undefined` drops every frame, because no
 *   location can then be stated in the model's coordinates.
 * @returns the message followed by the surviving rewritten frames.
 */
export function normalizeProgramStack(stack: string, headerLines: number | undefined): string {
  const lines = stack.split('\n')
  const firstFrame = lines.findIndex(line => STACK_FRAME.test(line))
  if (firstFrame < 0) return stack
  const rendered = lines.slice(0, firstFrame)
  if (headerLines === undefined) return rendered.join('\n')
  for (const line of lines.slice(firstFrame)) {
    const frame = PROGRAM_FRAME.exec(line)
    if (frame?.[1] === undefined || frame[2] === undefined || frame[3] === undefined) continue
    const programLine = Number(frame[2]) - headerLines
    if (programLine < 1) continue
    const prefix = frame[1].startsWith(ASYNC_PREFIX) ? ASYNC_PREFIX : ''
    const name = frame[1].slice(prefix.length)
    const location = programLocation(programLine, Number(frame[3]))
    rendered.push(name === TOP_LEVEL_FRAME
      ? `    at ${prefix}${location}`
      : `    at ${prefix}${name} (${location})`)
  }
  return rendered.join('\n')
}

/**
 * Prepare a thrown program value without sending an unbounded stack or
 * string across the worker port.
 * @param error - the value thrown by the program.
 * @param headerLines - synthesized lines preceding the program's line 1, for
 *   {@link normalizeProgramStack}.
 * @param remainingOutputBytes - exact bytes left after captured logs.
 * @param maxOutputBytes - the configured cap named in an overflow diagnostic.
 * @returns a bounded exception or fixed output-limit fragment.
 */
export function prepareException(
  error: unknown,
  headerLines: number | undefined,
  remainingOutputBytes: number,
  maxOutputBytes: number = remainingOutputBytes,
): Omit<DoneMessage, 'type'> {
  let message: string
  try {
    const detail: unknown = error instanceof CapturedError ? error.stack ?? error.message : error
    message = typeof detail === 'string' ? detail : String(detail)
    // A thrown non-Error carries no frames to rewrite, and its text is the
    // program's own value: pass it through untouched.
    if (error instanceof CapturedError) message = normalizeProgramStack(message, headerLines)
  } catch {
    message = 'program threw an unrenderable value'
  }
  return prepareFailure('exception', message, remainingOutputBytes, maxOutputBytes)
}

/** One awaited binding call's settlement handles, keyed by call id in the pending map. */
export interface PendingCall {
  resolve(value: unknown): void
  reject(error: Error): void
}

/** Constructor type for one program-visible binding rejection class. */
export type BindingErrorConstructor = new (memberName: string, message: string) => Error

/**
 * Materialize the real error constructor declared by one namespace.
 * @param descriptor - program-global class name and member-name property.
 * @returns the constructor injected into the program and used for rejections.
 */
function makeBindingErrorClass(
  descriptor: { name: string; memberNameProperty: string },
): BindingErrorConstructor {
  return class BindingCallError extends CapturedError {
    constructor(memberName: string, message: string) {
      super(message)
      defineBindingErrorField(this, 'name', descriptor.name)
      defineBindingErrorField(this, descriptor.memberNameProperty, memberName)
    }
  }
}

/** Create the namespace-specific rejection for one failed binding call. */
function bindingFailure(errorClass: BindingErrorConstructor | undefined, memberName: string, message: string): Error {
  return errorClass ? new errorClass(memberName, message) : new CapturedError(message)
}

/**
 * Build each declared error class once so calls and `instanceof` share constructor identity.
 * @param data - binding namespace declarations from the boot payload.
 * @returns constructors keyed by their owning namespace global.
 */
export function makeBindingErrorClasses(
  data: Pick<WorkerBootData, 'namespaces'>,
): Map<string, BindingErrorConstructor> {
  const classes = new Map<string, BindingErrorConstructor>()
  for (const namespace of data.namespaces) {
    if (namespace.errorClass) classes.set(namespace.global, makeBindingErrorClass(namespace.errorClass))
  }
  return classes
}

/**
 * Route host replies into the pending-call map: each reply settles its call
 * at most once, and a reply for an unknown id (stray, or a duplicate answer
 * to an id already settled) is ignored. Shared wiring between
 * {@link runWorkerMain} and the tests that exercise {@link makeNamespaces}
 * standalone.
 * @param port - the port whose `message` events carry the replies.
 * @param pending - the id-keyed map of unsettled binding calls.
 */
export function wireReplies(port: BootstrapPort, pending: Map<number, PendingCall>): void {
  port.on('message', (message: ReplyMessage) => {
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    if (message.ok) {
      const value = decodeWorkerJson(message.value)
      if (value === undefined) entry.reject(new CapturedError('binding resolution must be lossless JSON'))
      else entry.resolve(value)
    } else {
      entry.reject(new CapturedError(message.message))
    }
  })
}

/**
 * Build the binding namespace objects the program sees: one null-prototype global per
 * namespace, each declared name an own enumerable async function that bridges over the port
 * (`__proto__`/`constructor`/`toString` are ordinary keys, never prototype collisions).
 * Lossy arguments reject before posting; clone failures and host failure
 * replies reject only the corresponding call.
 *
 * @param data - the boot payload's namespace declarations (globals + names).
 * @param port - the port binding calls are posted to.
 * @param pending - the id-keyed map each posted call parks its handles in.
 * @param nextId - the shared mutable id counter (worker-issued correlation ids).
 * @param errorClasses - per-namespace constructors shared with program globals.
 * @returns one namespace object per declaration, in declaration order.
 */
export function makeNamespaces(
  data: Pick<WorkerBootData, 'namespaces'>,
  port: BootstrapPort,
  pending: Map<number, PendingCall>,
  nextId: { value: number },
  errorClasses: Map<string, BindingErrorConstructor> = makeBindingErrorClasses(data),
): Record<string, unknown>[] {
  return data.namespaces.map(({ global, names }) => {
    const errorClass = errorClasses.get(global)
    const namespace = Object.create(null) as Record<string, unknown>
    for (const name of names) {
      Object.defineProperty(namespace, name, {
        enumerable: true,
        value: (args: unknown): Promise<unknown> => {
          let detached: ReturnType<typeof snapshotCodeJsonValue>
          try {
            detached = snapshotCodeJsonValue(args)
          } catch {
            detached = undefined
          }
          if (detached === undefined) {
            return Promise.reject(bindingFailure(errorClass, name, 'binding arguments must be lossless JSON'))
          }
          return new Promise((resolve, reject) => {
            const id = nextId.value++
            pending.set(id, {
              resolve,
              reject: (error) => {
                reject(bindingFailure(errorClass, name, error.message))
              },
            })
            try {
              port.postMessage({ type: 'call', id, global, name, args: encodeWorkerJson(detached) })
            } catch (error: unknown) {
              pending.delete(id)
              const message = `binding arguments must be structured-cloneable: ${error instanceof CapturedError ? error.message : String(error)}`
              reject(bindingFailure(errorClass, name, message))
            }
          })
        },
      })
    }
    return namespace
  })
}

/**
 * Run one strict async-function body, allowing top-level `await` and `return`, and post exactly
 * one terminal {@link DoneMessage}; a thrown program error becomes its `error` field.
 * @param port - host message port or test double.
 * @param data - the boot payload the host sent.
 * @param streams - stdout/stderr objects captured as program logs.
 * @returns after posting the done message.
 */
export async function runWorkerMain(
  port: BootstrapPort,
  data: WorkerBootData,
  streams: { stdout: PatchableStream; stderr: PatchableStream },
): Promise<void> {
  const logs = new LogBuffer(
    data.maxOutputBytes,
    (text) => { port.postMessage({ type: 'log', text }) },
    () => { port.postMessage({ type: 'output-limit' }) },
  )
  captureStreamWrites(logs, streams.stdout)
  captureStreamWrites(logs, streams.stderr)

  const pending = new Map<number, PendingCall>()
  wireReplies(port, pending)

  const nextId = { value: 1 }
  const errorClasses = makeBindingErrorClasses(data)
  const namespaces = makeNamespaces(data, port, pending, nextId, errorClasses)
  const errorClassParameters: string[] = []
  const errorClassValues: BindingErrorConstructor[] = []
  for (const namespace of data.namespaces) {
    if (!namespace.errorClass) continue
    errorClassParameters.push(namespace.errorClass.name)
    const errorClass = errorClasses.get(namespace.global)
    /* v8 ignore next -- makeBindingErrorClasses covers every declaration in the same data. */
    if (!errorClass) throw new CapturedError(`missing binding error class for ${namespace.global}`)
    errorClassValues.push(errorClass)
  }
  const consoleShim = makeConsoleShim(logs)

  let done: DoneMessage
  const body = `${PROGRAM_DIRECTIVE}${data.code}`
  // Kept outside the try so a failure can be located in the program's own
  // coordinates; a body that does not compile leaves it undefined, and such a
  // failure has no program frames to locate.
  let fn: ((...fnArgs: unknown[]) => Promise<unknown>) | undefined
  try {
    // The async function constructor, reached through an instance because
    // `AsyncFunction` is not a global. The program body is strict-mode.
    /* v8 ignore next -- the arrow exists only to reach the AsyncFunction constructor; it is never invoked. */
    const AsyncFunction = (async () => {}).constructor as new (...args: string[]) => (...fnArgs: unknown[]) => Promise<unknown>
    fn = new AsyncFunction(
      ...data.namespaces.map(namespace => namespace.global),
      ...errorClassParameters,
      'console',
      body,
    )
    const value = await fn(...namespaces, ...errorClassValues, consoleShim)
    done = {
      type: 'done',
      ...prepareCompletion(value, logs.remainingOutputBytes(), data.maxOutputBytes),
    }
  } catch (error: unknown) {
    done = {
      type: 'done',
      ...prepareException(
        error,
        fn === undefined ? undefined : programHeaderLines(fn.toString(), body),
        logs.remainingOutputBytes(),
        data.maxOutputBytes,
      ),
    }
  }
  port.postMessage(done)
}
