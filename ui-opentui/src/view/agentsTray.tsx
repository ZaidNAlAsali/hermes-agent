/**
 * AgentsTray — the background-agents tray docked below the composer (Epic 2.7).
 *
 * Collapsed (unfocused): one muted, always-honest line — `⚡ N agents running —
 * ↓ to inspect`. Nothing at all when no agent is running (no stolen transcript
 * height). Expanded (focused): one row per RUNNING subagent (status not
 * complete/failed) showing status · goal · elapsed-ish · last activity line,
 * with a themed highlight on the selection.
 *
 * Focus routing (the hard part): the tray takes NATIVE focus (its root box is
 * focusable) — `focusRenderable` blurs the composer textarea for us, and
 * focusing the textarea back blurs the box, whose BLURRED event is the single
 * collapse trigger. The composer hands focus over via `onFocusDown` (Down on an
 * EMPTY composer, no dropdown — see composer.tsx); while the tray is focused:
 *   - Up/Down move the selection (composer's history handler is gated on the
 *     textarea being focused, so it stays out of the way);
 *   - Enter opens the agents dashboard preselected on the row (the dashboard
 *     replaces the input zone, unmounting the tray → destroy → blur → collapse);
 *   - Esc returns focus to the composer (`onExit` → the composer's focus());
 *   - a printable key is NOT handled here — the composer's reclaim rule focuses
 *     the textarea and inserts the char, and the resulting blur collapses us.
 * The `defaultPrevented` guard keeps the very Down that focused the tray (the
 * composer preventDefaults it) from also moving the selection.
 */
import { RenderableEvents, type BoxRenderable } from '@opentui/core'
import { useKeyboard } from '@opentui/solid'
import { createEffect, createMemo, createSignal, For, Show } from 'solid-js'

import type { SubagentInfo } from '../logic/store.ts'
import { elapsedSeconds, useElapsedTick } from './elapsed.ts'
import { useTheme } from './theme.tsx'

/** What the App binds to hand the tray keyboard focus (composer Down). */
export interface AgentsTrayApi {
  /** Try to take focus; false when ineligible (no running agents / not mounted). */
  focusTray: () => boolean
}

/** Terminal subagent statuses — everything the wire can end a branch with.
 *  `complete` is the store's fallback mapping for a status-less
 *  `subagent.complete`; the LIVE gateway sends the payload status verbatim from
 *  delegate_tool: `completed` / `failed` / `error` / `timeout` / `interrupted`. */
const TERMINAL_STATUSES = new Set(['complete', 'completed', 'failed', 'error', 'timeout', 'interrupted'])

/** Tray membership: a subagent still doing work. */
export function isTrayAgent(sa: SubagentInfo): boolean {
  return !TERMINAL_STATUSES.has(sa.status)
}

/** `m:ss` for the row's elapsed-ish counter. */
function fmtElapsed(secs: number): string {
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`
}

/** Keep a row's activity tail to one line's worth. */
function truncate(s: string, max = 48): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function statusColor(status: string, theme: ReturnType<typeof useTheme>): string {
  const c = theme().color
  if (status === 'tool' || status === 'working') return c.accent
  if (status.includes('error')) return c.error
  return c.warn
}

export function AgentsTray(props: {
  subagents: SubagentInfo[]
  /** Enter on a row — open that agent in the dashboard. */
  onOpen: (id: string) => void
  /** Esc (or the tray emptying while focused) — give focus back to the composer. */
  onExit?: (() => void) | undefined
  /** Receives the focus-handoff API once (the App wires it to the composer's Down). */
  bind?: ((api: AgentsTrayApi) => void) | undefined
}) {
  const running = createMemo(() => props.subagents.filter(isTrayAgent))
  const [focused, setFocused] = createSignal(false)
  const [sel, setSel] = createSignal(0)
  // Clamp against a shrinking list (an agent above the selection completing).
  const selected = () => Math.min(sel(), Math.max(0, running().length - 1))
  let boxRef: BoxRenderable | undefined

  // First-seen wall clock per agent id — the subagent stream carries no start
  // timestamp, so "elapsed-ish" is time since the tray first saw the agent.
  // Non-reactive Map; rows repaint via the shared 1s tick while expanded.
  const firstSeen = new Map<string, number>()
  createEffect(() => {
    for (const sa of running()) if (!firstSeen.has(sa.id)) firstSeen.set(sa.id, Date.now())
  })

  const attach = (el: BoxRenderable) => {
    boxRef = el
    // The single collapse trigger: native focus left the box (printable-key
    // reclaim by the composer, an overlay opening, or unmount-destroy).
    el.on(RenderableEvents.BLURRED, () => setFocused(false))
  }

  props.bind?.({
    focusTray: () => {
      if (running().length === 0 || !boxRef) return false
      setSel(0)
      setFocused(true)
      boxRef.focus()
      return true
    }
  })

  // The last running agent finished while the tray was focused: the box is about
  // to unmount — hand focus back to the composer instead of leaving it nowhere.
  createEffect(() => {
    if (focused() && running().length === 0) {
      setFocused(false)
      props.onExit?.()
    }
  })

  useKeyboard(key => {
    // defaultPrevented: the Down that HANDED us focus was consumed by the composer.
    if (!focused() || key.defaultPrevented) return
    if (key.name === 'up') {
      setSel(Math.max(0, selected() - 1))
      key.preventDefault()
    } else if (key.name === 'down') {
      setSel(Math.min(running().length - 1, selected() + 1))
      key.preventDefault()
    } else if (key.name === 'return') {
      const sa = running()[selected()]
      if (sa) props.onOpen(sa.id) // dashboard replaces the input zone → unmount → blur → collapse
      key.preventDefault()
    } else if (key.name === 'escape') {
      boxRef?.blur()
      setFocused(false)
      props.onExit?.()
      // A tray-exit Esc is CONSUMED — without this, a composer remount can
      // register its handler after ours and the same keystroke would arm the
      // Esc+Esc prompt-history double-press (Epic 5 review caveat).
      key.preventDefault()
    }
  })

  // Collapsed = NOTHING under the composer (P4 input-density fold, glitch
  // 2026-06-13): the running count moved to the status bar's `⚡ N` chip, so the
  // tray no longer keeps a persistent line here. The box stays mounted + focusable
  // so composer-Down still hands focus over and EXPANDS it into the rows.
  return (
    <Show when={running().length > 0}>
      <box ref={attach} focusable style={{ flexDirection: 'column', flexShrink: 0 }}>
        <Show when={focused()}>
          <TrayRows agents={running()} selected={selected()} firstSeen={firstSeen} />
        </Show>
      </box>
    </Show>
  )
}

/** The expanded rows — split out so the 1s elapsed tick is only subscribed while
 *  the tray is focused (the `<Show>` scope owns the subscription's onCleanup). */
function TrayRows(props: { agents: SubagentInfo[]; selected: number; firstSeen: Map<string, number> }) {
  const theme = useTheme()
  const tick = useElapsedTick()
  return (
    <box
      style={{
        backgroundColor: theme().color.completionBg,
        flexDirection: 'column',
        paddingLeft: 1,
        paddingRight: 1
      }}
    >
      <For each={props.agents}>
        {(sa, i) => {
          const active = () => i() === props.selected
          const last = () => sa.trace?.at(-1)?.text ?? sa.thought
          const secs = () => (tick(), elapsedSeconds(props.firstSeen.get(sa.id) ?? Date.now()))
          return (
            <box
              style={{
                backgroundColor: active() ? theme().color.completionCurrentBg : theme().color.completionBg
              }}
            >
              <text selectable={false}>
                <span style={{ fg: active() ? theme().color.accent : theme().color.muted }}>
                  {active() ? '▸ ' : '  '}
                </span>
                <span style={{ fg: statusColor(sa.status, theme) }}>{`● ${sa.status}`}</span>
                <span style={{ fg: active() ? theme().color.text : theme().color.label }}>{`  ${truncate(
                  sa.goal || sa.id,
                  72
                )}`}</span>
                <span style={{ fg: theme().color.muted }}>{`  · ${fmtElapsed(secs())}`}</span>
                <span style={{ fg: theme().color.muted }}>{last() ? `  ${truncate(last() ?? '')}` : ''}</span>
              </text>
            </box>
          )
        }}
      </For>
      <text selectable={false} fg={theme().color.muted}>
        ↑/↓ select · Enter inspect · Esc back
      </text>
    </box>
  )
}
