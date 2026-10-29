import { post, type Connection, type EventSummary } from '../api'
import { ConfirmButton, cx, SkeletonRows, Time } from '../components'
import { eventHref, navigate, useListNav } from '../hooks'
import { jackCode, lineId, lineLabel } from '../patch'
import { outcomeOf, TraceMini } from '../trace'

export const COLS =
  'grid grid-cols-[3.5rem_minmax(0,1fr)_auto_auto] gap-x-3 px-3 [grid-template-areas:"tr_ty_ty_ag"_"ln_ln_oc_ac"] md:grid-cols-[3.5rem_minmax(0,1.3fr)_minmax(8.5rem,0.7fr)_minmax(8.75rem,1fr)_4rem_1.75rem] md:gap-x-4 md:[grid-template-areas:"tr_ty_ln_oc_ag_ac"]'

const TONE = { bad: 'text-bad-ink', warn: 'text-warn-ink', plain: 'text-ink-2' }

function CallRow({ e, connection, href, selected, tab, onFocus, onChange }: { e: EventSummary; connection?: Connection; href: string; selected: boolean; tab: number; onFocus: () => void; onChange: () => void }) {
  const o = outcomeOf(e.trace)
  const failed = e.trace.failedDelivery
  return (
    <div role="row" aria-selected={selected} className={cx('tr cursor-pointer py-1 md:py-0', COLS, selected && 'is-sel')} onClick={() => navigate(href.slice(1))}>
      <span role="gridcell" className="flex h-6 items-center [grid-area:tr] md:h-8">
        <TraceMini trace={e.trace} />
      </span>
      <span role="gridcell" className="min-w-0 truncate [grid-area:ty]">
        <a href={href} title={e.subtype ? `${e.type} · ${e.subtype}` : e.type} data-ev={e.id} tabIndex={tab} onFocus={onFocus} onClick={(x) => x.stopPropagation()} className="font-mono text-xs text-ink no-underline hover:text-ink">
          {e.type}
          {e.subtype ? <span className="text-ink-3"> · {e.subtype}</span> : null}
        </a>
      </span>
      <span role="gridcell" title={lineLabel(connection, e.connectionId, e.provider)} className="flex min-w-0 items-center gap-1.5 [grid-area:ln]">
        <span className="jack-code">{jackCode(e.provider)}</span>
        <span className="font-mono text-xs whitespace-nowrap text-ink-2">{lineId(connection, e.connectionId)}</span>
      </span>
      <span role="gridcell" title={o.full} className={cx('min-w-0 truncate [grid-area:oc]', TONE[o.tone], o.tone === 'bad' && 'font-mono text-xs font-medium')}>
        <span className="sr-only">{failed ? 'Failed: ' : 'Outcome: '}</span>
        {o.text}
      </span>
      <span role="gridcell" className="text-right text-xs text-ink-3 [grid-area:ag]">
        <Time iso={e.receivedAt} bare />
      </span>
      <span role="gridcell" className="flex justify-end [grid-area:ac]">
        {failed ? (
          <ConfirmButton
            small
            iconOnly
            icon="replay"
            label="Replay delivery"
            question="Replay?"
            confirmLabel="Replay"
            doneText="Replay queued"
            tabIndex={tab}
            onConfirm={async () => {
              await post(`/api/deliveries/${failed.id}/replay`)
              onChange()
            }}
          />
        ) : null}
      </span>
    </div>
  )
}

export function CallLogHeader() {
  return (
    <div role="row" className={cx('th hidden md:grid', COLS)}>
      <span role="columnheader">Trace</span>
      <span role="columnheader">Type</span>
      <span role="columnheader">Line</span>
      <span role="columnheader">Outcome</span>
      <span role="columnheader" className="text-right">
        Age
      </span>
      <span role="columnheader">
        <span className="sr-only">Actions</span>
      </span>
    </div>
  )
}

export function CallLog({
  events,
  connections,
  onChange,
  label,
  base,
  open,
}: {
  events: EventSummary[]
  connections: Connection[]
  onChange: () => void
  label: string
  base: string
  open: string | null
}) {
  const byId = new Map(connections.map((c) => [c.id, c]))
  const [sel, setSel] = useListNav(
    events.map((e) => e.id),
    base,
    open,
  )
  const focusable = sel >= 0 && sel < events.length ? sel : 0
  return (
    <div role="grid" aria-label={label} aria-rowcount={events.length + 1} data-list className="min-w-0 border-t border-rule md:border-t-0">
      <CallLogHeader />
      {events.map((e, i) => (
        <CallRow
          key={e.id}
          e={e}
          connection={byId.get(e.connectionId)}
          href={eventHref(base, e.id)}
          selected={i === sel || e.id === open}
          tab={i === focusable ? 0 : -1}
          onFocus={() => setSel(i)}
          onChange={onChange}
        />
      ))}
    </div>
  )
}

export function KeyHints({ filter }: { filter?: boolean }) {
  return (
    <p className="hidden items-center gap-3 text-xs text-ink-3 md:flex">
      {filter ? (
        <span>
          <kbd>/</kbd> filter
        </span>
      ) : null}
      <span>
        <kbd>j</kbd> <kbd>k</kbd> move
      </span>
      <span>
        <kbd>Enter</kbd> open
      </span>
      <span>
        <kbd>Esc</kbd> close
      </span>
    </p>
  )
}

export function CallLogSkeleton({ rows = 12 }: { rows?: number }) {
  return (
    <div>
      <CallLogHeader />
      <SkeletonRows rows={rows} height="h-14 md:h-8" />
    </div>
  )
}
