import type { EventDetail, EventTrace, RoutedState, StatusCounts } from './api'
import { cx } from './components'

export type LampState = 'ok' | 'warn' | 'bad' | 'off'

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

const ROUTED_TEXT: Record<RoutedState, [LampState, string]> = {
  pending: ['warn', 'Waiting to be routed'],
  routed: ['ok', 'Routed to destinations'],
  echo: ['ok', 'Skipped: echo of a Relay message'],
  unmatched: ['warn', 'Not routed: no route matched'],
  inactive: ['off', 'Not routed: connection not active'],
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

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

const DETAIL_STATE: Record<EventDetail['state'], RoutedState> = {
  pending: 'pending',
  routed: 'routed',
  unmatched: 'unmatched',
  skipped_echo: 'echo',
  skipped_inactive: 'inactive',
}

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

const WIRE: Record<LampState, string> = { ok: 'ok', warn: 'warn', bad: 'bad', off: 'rule' }

export function wireStates(stages: StageView[]): LampState[] {
  const firstBad = stages.findIndex((s) => s.state === 'bad')
  let last = -1
  stages.forEach((s, i) => {
    if (s.state !== 'off') last = i
  })
  const end = firstBad === -1 ? last : Math.min(firstBad, last)
  return stages.slice(1).map((s, i) => (i + 1 <= end ? s.state : 'off'))
}

const STROKE: Record<string, string> = { ok: 'stroke-ok', warn: 'stroke-warn', bad: 'stroke-bad', rule: 'stroke-edge' }
const FILL: Record<string, string> = { ok: 'bg-ok', warn: 'bg-warn', bad: 'bg-bad', rule: 'bg-edge' }

export const traceLabel = (stages: StageView[]) => `Trace. ${stages.map((s) => `${s.name}: ${s.text}`).join('. ')}.`

export function TraceLamps({ trace }: { trace: EventTrace }) {
  const stages = stagesOf(trace)
  const wires = wireStates(stages)
  return (
    <span role="img" aria-label={traceLabel(stages)} className="relative grid grid-cols-5 items-center justify-items-center">
      <svg viewBox="0 0 120 24" aria-hidden="true" focusable="false" className="absolute inset-0 h-full w-full">
        {wires.map((w, i) => (
          <line
            key={i}
            x1={12 + 24 * i + 6}
            x2={12 + 24 * (i + 1) - 6}
            y1="12"
            y2="12"
            strokeWidth={w === 'off' ? 1 : 1.5}
            strokeDasharray={w === 'off' ? '2 2' : undefined}
            className={STROKE[WIRE[w]]}
          />
        ))}
      </svg>
      {stages.map((s, i) => (
        <span key={s.stage} title={`${s.name}: ${s.text}`} className="relative grid size-6 place-items-center">
          <Lamp key={s.state} state={s.state} index={i} />
        </span>
      ))}
    </span>
  )
}

export function TraceCodes({ className }: { className?: string }) {
  return (
    <span aria-hidden="true" className={cx('grid grid-cols-5 justify-items-center font-mono text-[0.625rem] leading-4 tracking-wider text-ink-3', className)}>
      {STAGES.map(([stage, name, code]) => (
        <abbr key={stage} title={name} className="no-underline">
          {code}
        </abbr>
      ))}
    </span>
  )
}

export function TraceDetail({ trace }: { trace: EventTrace }) {
  const stages = stagesOf(trace)
  const wires = wireStates(stages)
  return (
    <ol aria-label="Trace" className="grid grid-cols-1 border-y border-rule sm:grid-cols-5">
      {stages.map((s, i) => {
        const w = wires[i]
        const wire = w ? cx(FILL[WIRE[w]], w === 'off' && 'opacity-60') : null
        return (
          <li key={s.stage} className="relative flex items-start gap-3 py-3 max-sm:border-b max-sm:border-rule max-sm:last:border-b-0 sm:flex-col sm:gap-2">
            <span className="flex items-center self-stretch">
              <Lamp key={s.state} state={s.state} index={i} className="size-4" />
              {wire ? <span aria-hidden="true" className={cx('ml-1 hidden h-px flex-1 sm:block', wire)} /> : null}
            </span>
            {wire ? <span aria-hidden="true" className={cx('absolute top-7.5 -bottom-3 left-[7.5px] w-px sm:hidden', wire)} /> : null}
            <span className="min-w-0 pr-3">
              <span className="block font-bold">
                {s.name}{' '}
                <abbr title={s.name} className="font-mono text-xs font-normal tracking-wider text-ink-3 no-underline">
                  {s.code}
                </abbr>
              </span>
              <span className="block text-sm text-ink-2">{s.text}</span>
            </span>
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
}

export function StatusMark({ value, label }: { value: string; label?: string }) {
  const state = STATUS_LAMP[value] ?? 'off'
  return (
    <span className={cx('inline-flex items-center gap-1.5 text-sm font-bold whitespace-nowrap', state === 'bad' ? 'text-bad-ink' : state === 'warn' ? 'text-warn-ink' : state === 'ok' ? 'text-ink' : 'text-ink-2')}>
      <Lamp key={state} state={state} />
      {label ?? value}
    </span>
  )
}
