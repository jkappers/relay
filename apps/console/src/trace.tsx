import type { EventDetail, EventTrace, StatusCounts } from './api'
import { condenseCause } from './cause'
import { cx } from './components'
import { DETAIL_STATE, ROUTED_SHORT, ROUTED_TEXT, type LampState } from './states'

export type { LampState }

export const STAGES = [
  ['received', 'Received', 'RCV'],
  ['verified', 'Verified', 'VER'],
  ['routed', 'Routed', 'RTE'],
  ['delivered', 'Delivered', 'DLV'],
  ['acted', 'Acted', 'ACT'],
] as const

export type Stage = (typeof STAGES)[number][0]

export interface StageView {
  stage: Stage
  name: string
  code: string
  state: LampState
  text: string
}

export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

function aggregate(c: StatusCounts, noun: [string, string], none: string): [LampState, string] {
  const total = c.pending + c.succeeded + c.failed
  if (total === 0) return ['off', none]
  const parts: string[] = []
  if (c.failed) parts.push(`${c.failed} failed`)
  if (c.pending) parts.push(`${c.pending} pending or retrying`)
  if (c.succeeded) parts.push(`${c.succeeded} succeeded`)
  const text = `${plural(total, ...noun)}: ${parts.join(', ')}`
  return [c.failed ? 'bad' : c.pending ? 'warn' : 'ok', text]
}

export function stagesOf(t: EventTrace): StageView[] {
  const [rs, rt] = ROUTED_TEXT[t.routed]
  const reached = t.routed === 'routed'
  const [ds, dt] = reached ? aggregate(t.deliveries, ['delivery', 'deliveries'], 'Not reached: no deliveries') : ['off' as const, 'Not reached']
  const [as, at] = aggregate(t.actions, ['action', 'actions'], 'Not reached: no actions')
  const states: [LampState, string][] = [
    ['ok', 'Received and stored'],
    ['ok', 'Signature verified'],
    [rs, rt],
    [ds, dt],
    [as, at],
  ]
  return STAGES.map(([stage, name, code], i) => ({ stage, name, code, state: states[i]![0], text: states[i]![1] }))
}

const count = (rows: { status: string }[]): StatusCounts => ({
  pending: rows.filter((r) => r.status === 'pending' || r.status === 'running').length,
  succeeded: rows.filter((r) => r.status === 'succeeded').length,
  failed: rows.filter((r) => r.status === 'failed').length,
})

export function traceOfDetail(e: EventDetail): EventTrace {
  return {
    routed: DETAIL_STATE[e.state],
    deliveries: count(e.deliveries),
    actions: count(e.actions),
    failedDelivery: null,
  }
}

const DELAY = ['', '[animation-delay:30ms]', '[animation-delay:60ms]', '[animation-delay:90ms]', '[animation-delay:120ms]']

export function Lamp({ state, className, index = 0 }: { state: LampState; className?: string; index?: number }) {
  return (
    <svg viewBox="0 0 12 12" aria-hidden="true" focusable="false" className={cx('shrink-0 animate-settle', DELAY[index], className ?? 'size-3')}>
      {state === 'ok' ? <circle cx="6" cy="6" r="5.25" strokeWidth="1.5" className="fill-ok stroke-ok-ink" /> : null}
      {state === 'warn' ? (
        <>
          <circle cx="6" cy="6" r="5.25" strokeWidth="1.5" className="fill-ground stroke-warn-ink" />
          <circle cx="6" cy="6" r="2.5" className="fill-warn" />
        </>
      ) : null}
      {state === 'bad' ? (
        <>
          <circle cx="6" cy="6" r="5.25" strokeWidth="1.5" className="fill-bad stroke-bad-ink" />
          <rect x="3" y="5.25" width="6" height="1.5" className="fill-ground" />
        </>
      ) : null}
      {state === 'off' ? <circle cx="6" cy="6" r="4.5" strokeWidth="1" className="fill-ground stroke-edge" /> : null}
    </svg>
  )
}

export function wireStates(stages: StageView[]): LampState[] {
  const firstBad = stages.findIndex((s) => s.state === 'bad')
  let last = -1
  stages.forEach((s, i) => {
    if (s.state !== 'off') last = i
  })
  const end = firstBad === -1 ? last : Math.min(firstBad, last)
  return stages.slice(1).map((s, i) => (i + 1 <= end ? s.state : 'off'))
}

export const traceLabel = (stages: StageView[]) => `Trace. ${stages.map((s) => `${s.name}: ${s.text}`).join('. ')}.`

const STROKE: Record<LampState, string> = { ok: 'stroke-ok', warn: 'stroke-warn', bad: 'stroke-bad', off: 'stroke-line' }
const DOT: Record<LampState, string> = { ok: 'fill-ok stroke-ok', warn: 'fill-raised stroke-warn', bad: 'fill-bad stroke-bad', off: 'fill-ground stroke-edge' }

export function TraceMini({ trace }: { trace: EventTrace }) {
  const stages = stagesOf(trace)
  const wires = wireStates(stages)
  return (
    <svg role="img" aria-label={traceLabel(stages)} viewBox="0 0 56 10" className="h-2.5 w-14 shrink-0 overflow-visible">
      <title>{stages.map((s) => `${s.code} ${s.text}`).join('\n')}</title>
      {wires.map((w, i) => (
        <line key={i} x1={8 + 12 * i} x2={16 + 12 * i} y1="5" y2="5" strokeWidth="1" className={STROKE[w]} />
      ))}
      {stages.map((s, i) => (
        <circle key={s.stage} cx={4 + 12 * i} cy="5" r={s.state === 'off' ? 2.5 : 3} strokeWidth={s.state === 'warn' ? 1.5 : 1} className={DOT[s.state]} />
      ))}
    </svg>
  )
}

const WIRE_BG: Record<LampState, string> = { ok: 'bg-ok', warn: 'bg-warn', bad: 'bg-bad', off: 'bg-line' }

export function TraceDetail({ trace }: { trace: EventTrace }) {
  const stages = stagesOf(trace)
  const wires = wireStates(stages)
  return (
    <ol aria-label="Trace" className="flex flex-col">
      {stages.map((s, i) => {
        const w = wires[i]
        return (
          <li key={s.stage} className="relative grid min-h-6 grid-cols-[1rem_4.5rem_minmax(0,1fr)] items-baseline gap-x-2">
            <Lamp key={s.state} state={s.state} index={i} className="size-2.5 self-center justify-self-center" />
            {w ? <span aria-hidden="true" className={cx('absolute top-[1.0625rem] left-[0.5rem] h-[0.875rem] w-px', WIRE_BG[w])} /> : null}
            <span className="font-medium">
              {s.name}
            </span>
            <span className={cx('min-w-0', s.state === 'bad' ? 'text-bad-ink' : s.state === 'warn' ? 'text-warn-ink' : 'text-ink-2')}>{s.text}</span>
          </li>
        )
      })}
    </ol>
  )
}

const STATUS_LAMP: Record<string, LampState> = {
  succeeded: 'ok',
  active: 'ok',
  enabled: 'ok',
  failed: 'bad',
  pending: 'warn',
  running: 'warn',
  retrying: 'warn',
}

export function StatusMark({ value, label }: { value: string; label?: string }) {
  const state = STATUS_LAMP[value] ?? 'off'
  return (
    <span className={cx('inline-flex items-center gap-1.5 whitespace-nowrap', state === 'bad' ? 'text-bad-ink' : state === 'warn' ? 'text-warn-ink' : state === 'ok' ? 'text-ink' : 'text-ink-3')}>
      <Lamp key={state} state={state} className="size-2.5" />
      {label ?? value}
    </span>
  )
}

export interface Outcome {
  text: string
  full: string
  tone: 'bad' | 'warn' | 'plain'
}

export function outcomeOf(t: EventTrace): Outcome {
  const [, , routed, delivered, acted] = stagesOf(t)
  if (t.failedDelivery) return { text: condenseCause(t.failedDelivery.lastError), full: t.failedDelivery.lastError ?? 'Delivery failed with no error text', tone: 'bad' }
  if (t.actions.failed) return { text: `${t.actions.failed} action failed`, full: acted!.text, tone: 'bad' }
  if (t.routed === 'pending') return { text: 'routing', full: routed!.text, tone: 'warn' }
  if (t.routed !== 'routed') return { text: ROUTED_SHORT[t.routed], full: routed!.text, tone: 'plain' }
  if (t.deliveries.pending) return { text: `${t.deliveries.pending} pending`, full: delivered!.text, tone: 'warn' }
  return { text: `${t.deliveries.succeeded} delivered`, full: delivered!.text, tone: 'plain' }
}
