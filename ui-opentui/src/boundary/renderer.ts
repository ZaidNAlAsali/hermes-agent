/**
 * Renderer lifecycle — the Effect-side resource boundary (spec v4 §3.1).
 *
 * `acquireRelease(createCliRenderer)` so the renderer is always destroyed on
 * scope exit; a `Deferred` resolved on the renderer's "destroy" event lets the
 * entry block until the user quits. Mirrors opencode `app.tsx:177` /
 * `:185-225`.
 *
 * No throw / try-catch here: acquisition failure surfaces as a typed
 * `RendererError` via `Effect.tryPromise`'s `catch`.
 */
import { createCliRenderer, type CliRenderer, type KeyEvent, type Selection } from '@opentui/core'
import { Deferred, Effect } from 'effect'

import { RendererError } from './errors.ts'
import { installFfiCoordSafety } from './ffiSafe.ts'
import { getLog } from './log.ts'

// Node-FFI seam: clamp negative draw coordinates BEFORE the u32 FFI marshaling
// (see ffiSafe.ts — scrolled-out <diff> line backgrounds crashed the render loop).
installFfiCoordSafety()

/**
 * The text a finished selection copies: the RENDERED text the user highlighted,
 * verbatim (`getSelectedText()` does correct same-line merging). Markdown markers
 * are concealed in the pretty render, so a partial selection cannot recover source —
 * this copies exactly what was highlighted (the `/copy` command gives full source).
 * Total by construction — a copy must NEVER throw out of an input/event handler
 * (that would tear down the render loop).
 */
function selectionCopyText(selection: Selection): string {
  try {
    return selection.getSelectedText()
  } catch (cause) {
    getLog().warn('copy', 'getSelectedText failed', { cause: String(cause) })
    return ''
  }
}

export interface RendererOptions {
  /** Mouse tracking on/off (from decoded display config). */
  readonly mouse: boolean
  /** When true, a blocking prompt owns Ctrl+C (cancel) — the global quit is suppressed (gotcha §8 #6). */
  readonly isBlocked?: () => boolean
  /**
   * Ctrl+C handler (item 11). When set, it OWNS Ctrl+C while not blocked — the
   * entry's state machine decides interrupt-the-turn vs quit. When omitted, the
   * default is an immediate `renderer.destroy()` (quit).
   */
  readonly onCtrlC?: () => void
  /**
   * Copy a mouse selection (item 1). When there's a live selection, Ctrl+C copies
   * it (this callback) instead of interrupting/quitting — opencode's selection
   * key precedence (`app.tsx:388`). Receives the rendered text the user highlighted.
   */
  readonly onCopySelection?: (text: string) => void
}

/**
 * Acquire a CliRenderer inside the current scope and register its release.
 * Returns the renderer plus a Deferred that resolves when the renderer is
 * destroyed (user quit) — `await` it to keep the entry alive.
 */
export const acquireRenderer = Effect.fn('Renderer.acquire')(function* (options: RendererOptions) {
  const renderer = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        createCliRenderer({
          // Root canvas: TRANSPARENT by default — the terminal's own background
          // shows through (do not paint a "default dark" canvas; glitch hated
          // it). A skin's explicit ui_bg lands reactively via the header's
          // theme effect (view/header.tsx setBackgroundColor).
          // scrollbox clips growing output → no terminal-scrollback corruption (gotcha §8 #2).
          externalOutputMode: 'passthrough',
          targetFps: 60,
          // prompts own Ctrl+C → deny/cancel (gotcha §8 #6); the global quit is gated on !blocked.
          exitOnCtrlC: false,
          // OpenTUI's default exitSignals include SIGPIPE + SIGBUS, and its handler
          // calls renderer.destroy() — so a broken clipboard pipe (writeClipboard
          // spawning xclip/wl-copy that dies) raises SIGPIPE and QUITS THE TUI on
          // copy. SIGPIPE/SIGBUS are not shutdown intents; restrict to the genuine
          // termination signals so a stray pipe error can never tear down the UI.
          exitSignals: ['SIGINT', 'SIGTERM', 'SIGQUIT', 'SIGHUP'],
          useKittyKeyboard: {},
          useMouse: options.mouse
        }),
      catch: cause => new RendererError({ cause })
    }),
    renderer => Effect.sync(() => destroyRenderer(renderer))
  )

  const shutdown = yield* Deferred.make<void>()
  renderer.once('destroy', () => {
    Deferred.doneUnsafe(shutdown, Effect.void)
  })

  // Global quit on Ctrl+C. `exitOnCtrlC:false` hands Ctrl+C to us as a key event
  // (not SIGINT), so destroying here fires 'destroy' → resolves `shutdown` → the
  // entry scope closes → finalizers run: renderer teardown + the gateway layer's
  // `client.stop()` EOFs the Python child's stdin so it exits (no orphan). When a
  // blocking prompt is up, it owns Ctrl+C (→ deny/cancel) so we suppress the quit
  // (gotcha §8 #6) — the prompt's own handler sends the cancel reply.
  const isBlocked = options.isBlocked ?? (() => false)
  renderer.keyInput.on('keypress', (key: KeyEvent) => {
    if (!(key.ctrl && key.name === 'c') || renderer.isDestroyed) return
    // Copy a live mouse selection first (item 1) — takes precedence over the
    // interrupt/quit machine and over a blocking prompt's cancel.
    if (options.onCopySelection) {
      const selection = renderer.getSelection()
      const text = selection ? selectionCopyText(selection) : ''
      if (text) {
        options.onCopySelection(text)
        renderer.clearSelection()
        return
      }
    }
    if (isBlocked()) return // a blocking prompt owns Ctrl+C (→ deny/cancel)
    if (options.onCtrlC) options.onCtrlC()
    else renderer.destroy()
  })

  // Copy-on-select (item 1 parity with free-code/Ink): the renderer's "selection"
  // event fires ONCE when a free-form mouse selection COMPLETES (drag finish);
  // auto-copy the spanned selectable text. Unlike the Ctrl+C path above we do NOT
  // clearSelection() — the highlight persists so the user sees what was copied and
  // Ctrl+C still works on it. `writeClipboard` is idempotent, so both paths writing
  // the same text is harmless (no double-write bug). `CliRenderer extends
  // EventEmitter`, so `on('selection', …)` is untyped → annotate `selection`.
  const onCopy = options.onCopySelection
  if (onCopy) {
    renderer.on('selection', (selection: Selection) => {
      const text = selectionCopyText(selection)
      if (text) onCopy(text)
    })
  }

  return { renderer, shutdown } as const
})

/** Best-effort renderer teardown; never throws out of the finalizer. */
function destroyRenderer(renderer: CliRenderer): void {
  try {
    if (!renderer.isDestroyed) renderer.destroy()
  } catch {
    // teardown is best-effort; a failed destroy must not mask the real exit cause.
  }
}
