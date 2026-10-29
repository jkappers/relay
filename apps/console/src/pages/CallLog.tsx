import { post, type Connection, type EventSummary } from '../api'
import { ConfirmButton, cx, SkeletonRows, Time } from '../components'
import { lineLabel } from '../patch'
import { stagesOf, TraceCodes, TraceLamps } from '../trace'

const ROW =
  'grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1.5 [grid-template-areas:"call_age"_"trace_line"_"out_out"] lg:grid-cols-[minmax(0,1.5fr)_minmax(0,0.8fr)_4.5rem_7.5rem_minmax(0,1.4fr)] lg:items-center lg:[grid-template-areas:"call_line_age_trace_out"]'

function outcome(e: EventSummary): { text: string; tone: 'bad' | 'warn' | 'plain' } {
  const s = stagesOf(e.trace)
  const routed = s[2]!
  const delivered = s[3]!
  if (e.trace.failedDelivery) return { text: e.trace.failedDelivery.lastError ?? 'Delivery failed with no error text', tone: 'bad' }
  if (routed.state === 'warn') return { text: routed.text, tone: 'warn' }
  if (e.trace.routed !== 'routed') return { text: routed.text, tone: 'plain' }
  return { text: delivered.text, tone: delivered.state === 'warn' ? 'warn' : delivered.state === 'bad' ? 'bad' : 'plain' }
}

function CallRow({ e, connection, onChange }: { e: EventSummary; connection?: Connection; onChange: () => void }) {
  const o = outcome(e)
  const failed = e.trace.failedDelivery
  return (
    <li className={cx('relative px-2 py-2.5 hover:bg-raised has-[a:focus-visible]:bg-raised has-[a:focus-visible]:outline-2 has-[a:focus-visible]:-outline-offset-2 has-[a:focus-visible]:outline-accent lg:min-h-14 lg:py-2', ROW)}>
      <div className="min-w-0 [grid-area:call]">
        <a
          href={`#/events/${e.id}`}
          className="block truncate font-mono text-sm font-bold text-ink no-underline after:absolute after:inset-0 hover:text-accent focus-visible:outline-none"
        >
          {e.type}
          {e.subtype ? <span className="font-normal text-ink-2"> · {e.subtype}</span> : null}
        </a>
        <p className={cx('truncate text-sm', e.text ? 'text-ink-2' : 'text-ink-3')}>{e.text ?? 'No text'}</p>
      </div>
      <div className="min-w-0 truncate text-right text-sm text-ink-2 [grid-area:line] lg:text-left">
        <span className="sr-only">Line: </span>
        {lineLabel(connection, e.connectionId, e.provider)}
      </div>
      <div className="text-right text-sm text-ink-2 [grid-area:age] lg:text-left">
        <Time iso={e.receivedAt} />
      </div>
      <div className="w-30 [grid-area:trace]">
        <TraceLamps trace={e.trace} />
      </div>
      <div className="flex min-w-0 items-center justify-between gap-3 [grid-area:out]">
        <p
          title={o.text}
          className={cx('line-clamp-3 min-w-0 text-sm break-words', o.tone === 'bad' ? 'font-bold text-bad-ink' : o.tone === 'warn' ? 'text-warn-ink' : 'text-ink-2')}
        >
          {failed ? <span className="sr-only">Cause: </span> : null}
          {o.text}
        </p>
        {failed ? (
          <span className="relative z-10 shrink-0">
            <ConfirmButton
              small
              icon="replay"
              label="Replay"
              question="Replay?"
              confirmLabel="Replay delivery"
              doneText="Queued"
              onConfirm={async () => {
                await post(`/api/deliveries/${failed.id}/replay`)
                onChange()
              }}
            />
          </span>
        ) : null}
      </div>
    </li>
  )
}

export function CallLogHeader() {
  return (
    <div aria-hidden="true" className={cx('hidden border-b border-rule px-2 pb-1 text-xs font-bold text-ink-3 lg:grid', ROW)}>
      <span>Call</span>
      <span>Line</span>
      <span>Age</span>
      <TraceCodes className="w-30" />
      <span>Outcome</span>
    </div>
  )
}

export function CallLog({ events, connections, onChange, label }: { events: EventSummary[]; connections: Connection[]; onChange: () => void; label: string }) {
  const byId = new Map(connections.map((c) => [c.id, c]))
  return (
    <div className="min-w-0">
      <CallLogHeader />
      <ul aria-label={label} className="divide-y divide-rule border-b border-rule max-lg:border-t">
        {events.map((e) => (
          <CallRow key={e.id} e={e} connection={byId.get(e.connectionId)} onChange={onChange} />
        ))}
      </ul>
    </div>
  )
}

export function CallLogSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div>
      <CallLogHeader />
      <SkeletonRows rows={rows} height="h-29 lg:h-14" />
    </div>
  )
}
