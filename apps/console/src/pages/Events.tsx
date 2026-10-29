import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { get, post, type Connection, type EventDetail, type EventPage as EventList, type EventSummary } from '../api'
import { Async, ConfirmButton, CopyId, Details, Empty, Fact, Facts, Json, Notice, Page, Segmented, SkeletonRows, Time } from '../components'
import { errorText, useDebounced, useLoad } from '../hooks'
import { Icon } from '../icons'
import { lineLabel, Patch } from '../patch'
import { Lamp, plural, StatusMark, TraceDetail, traceOfDetail, type LampState } from '../trace'
import { CallLog, CallLogSkeleton, KeyHints } from './CallLog'
import { DeliveryItem } from './Deliveries'

interface Filters {
  provider: string
  connectionId: string
  type: string
  range: string
}

type Facet = '' | 'failed' | 'pending' | 'unrouted' | 'echo' | 'ok'

const empty: Filters = { provider: '', connectionId: '', type: '', range: '' }

const RANGES: readonly [string, string, number][] = [
  ['', 'All time', 0],
  ['15m', 'Last 15m', 9e5],
  ['1h', 'Last 1h', 36e5],
  ['24h', 'Last 24h', 864e5],
  ['7d', 'Last 7d', 6048e5],
]

const FACETS: readonly [Facet, string, string, LampState?][] = [
  ['', 'All', 'Every event'],
  ['failed', 'Failed', 'A delivery or action failed', 'bad'],
  ['pending', 'Pending', 'Waiting to route, or a delivery is retrying', 'warn'],
  ['unrouted', 'No route', 'No route matched, or the line is inactive', 'off'],
  ['echo', 'Echo', 'Skipped: echo of a Relay message'],
  ['ok', 'Delivered', 'Routed and every delivery succeeded', 'ok'],
]

type Counts = Record<'all' | Exclude<Facet, ''>, number>

export function Events({ open }: { open: string | null }) {
  const [f, setF] = useState<Filters>(empty)
  const [outcome, setOutcome] = useState<Facet>('')
  const [extra, setExtra] = useState<EventSummary[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [moreError, setMoreError] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const type = useDebounced(f.type.trim(), 300)
  const qs = useMemo(() => {
    const p = new URLSearchParams()
    if (f.provider) p.set('provider', f.provider)
    if (f.connectionId) p.set('connectionId', f.connectionId)
    if (type) p.set('type', type)
    const ms = RANGES.find((r) => r[0] === f.range)?.[2]
    if (ms) p.set('since', new Date(Date.now() - ms).toISOString())
    return p.toString()
  }, [f.provider, f.connectionId, f.range, type])
  const list = (cur?: string) => `/api/events?${qs}${outcome ? `&outcome=${outcome}` : ''}${cur ? `&cursor=${cur}` : ''}`
  const connections = useLoad(() => get<{ items: Connection[] }>('/api/connections'), [])
  const state = useLoad(() => get<EventList>(list()), [qs, outcome])
  const counts = useLoad(() => get<Counts>(`/api/events/facets?${qs}`), [qs])
  const filtered = Object.values(f).some(Boolean) || outcome !== ''
  const set = (k: keyof Filters) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value })

  useEffect(() => {
    setExtra([])
    setCursor(state.data?.nextCursor ?? null)
  }, [state.data])

  async function more() {
    if (!cursor) return
    setMoreError(null)
    setLoadingMore(true)
    try {
      const page = await get<EventList>(list(cursor))
      setExtra((e) => [...e, ...page.items])
      setCursor(page.nextCursor)
    } catch (e) {
      setMoreError(errorText(e))
    } finally {
      setLoadingMore(false)
    }
  }

  const clear = () => {
    setF(empty)
    setOutcome('')
  }
  const refresh = () => {
    state.reload()
    counts.reload()
  }

  return (
    <Page
      title="Events"
      meta="Every call Relay received, newest first"
      actions={
        <button type="button" className="btn btn-sm" onClick={refresh}>
          <Icon name="refresh" className="size-3.5" />
          Refresh
        </button>
      }
    >
      <form role="search" aria-label="Filter events" className="flex flex-wrap items-center gap-2" onSubmit={(e) => e.preventDefault()}>
        <input id="filter" aria-label="Type prefix" className="input w-40 font-mono text-xs max-sm:w-full" value={f.type} placeholder="Type prefix" onChange={set('type')} />
        <select aria-label="Time range" className="input w-auto max-sm:flex-1" value={f.range} onChange={set('range')}>
          {RANGES.map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>
        <select aria-label="Provider" className="input w-auto max-sm:flex-1" value={f.provider} onChange={set('provider')}>
          <option value="">Any provider</option>
          <option value="slack">slack</option>
          <option value="webhook">webhook</option>
        </select>
        <select aria-label="Connection" className="input w-auto max-w-44 max-sm:max-w-none max-sm:flex-1" value={f.connectionId} onChange={set('connectionId')}>
          <option value="">Any connection</option>
          {connections.data?.items.map((c) => (
            <option key={c.id} value={c.id}>
              {lineLabel(c)}
            </option>
          ))}
        </select>
        {filtered ? (
          <button type="button" className="btn btn-quiet" onClick={clear}>
            Clear
          </button>
        ) : null}
      </form>
      <div className="flex flex-col gap-1">
        <div className="flex min-h-8 flex-wrap items-center justify-between gap-2">
          <Segmented
            label="Outcome"
            value={outcome}
            onChange={setOutcome}
            options={FACETS.map(([v, label, title, lamp]) => [
              v,
              <>
                {lamp ? <Lamp state={lamp} className="size-2" /> : null}
                {label}
                <span className="text-ink-3">{counts.data?.[v || 'all'] ?? ''}</span>
              </>,
              title,
            ])}
          />
          <KeyHints filter />
        </div>
        <Async
          state={state}
          skeleton={<CallLogSkeleton />}
          empty={{
            when: (d) => d.items.length === 0,
            render: () =>
              filtered ? (
                <Empty
                  title="No events match these filters"
                  action={
                    <button type="button" className="btn" onClick={clear}>
                      Clear filters
                    </button>
                  }
                >
                  Try another outcome, a shorter type prefix, or a wider time range.
                </Empty>
              ) : (
                <Empty
                  title="No events yet"
                  action={
                    <a href="#/connections" className="btn btn-primary">
                      Add a connection
                    </a>
                  }
                >
                  Relay stores every verified call it receives. Connect Slack or create a signed webhook, then send a test event.
                </Empty>
              ),
          }}
        >
          {(d) => (
            <div className="flex flex-col gap-2">
              <CallLog label="Events" base="/events" open={open} events={[...d.items, ...extra]} connections={connections.data?.items ?? []} onChange={state.reload} />
              <p role="status" className="sr-only">
                {d.items.length + extra.length} events shown
              </p>
              {moreError ? (
                <Notice tone="error" onRetry={more}>
                  Could not load more: {moreError}
                </Notice>
              ) : null}
              {cursor ? (
                <button type="button" className="btn btn-sm self-start" onClick={more} disabled={loadingMore}>
                  {loadingMore ? 'Loading…' : 'Load more'}
                </button>
              ) : (
                <p className="text-xs text-ink-3">End of list.</p>
              )}
            </div>
          )}
        </Async>
      </div>
    </Page>
  )
}

const STATE_TEXT: Record<EventDetail['state'], string> = {
  pending: 'Not routed yet',
  routed: 'Routed',
  unmatched: 'Routed, no route matched',
  skipped_echo: 'Skipped: echo of a Relay message',
  skipped_inactive: 'Skipped: connection not active',
}

const DELIVERY_LAMP: Record<string, LampState> = { succeeded: 'ok', pending: 'warn', failed: 'bad' }

function eventType(e: EventDetail): string {
  const env = e.envelope as { type?: unknown } | null
  return typeof env?.type === 'string' ? env.type : 'Event'
}

function Section({ id, title, count, children }: { id: string; title: string; count?: number; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="flex min-w-0 flex-col gap-2 border-t border-rule pt-3">
      <h3 id={id} className="text-xs font-semibold text-ink-2">
        {title}
        {count !== undefined ? <span className="ml-1.5 font-normal text-ink-3">{count}</span> : null}
      </h3>
      {children}
    </section>
  )
}

function EventBody({ e, connections, onChange }: { e: EventDetail; connections: Connection[]; onChange: () => void }) {
  const [replayed, setReplayed] = useState(false)
  const connection = connections.find((c) => c.id === e.connectionId)
  return (
    <div className="flex flex-col gap-4">
      <TraceDetail trace={traceOfDetail(e)} />
      <Section id="p-call" title="Call">
        <Facts>
          <Fact term="Event ID">
            <CopyId value={e.id} label="event ID" />
          </Fact>
          <Fact term="Line">
            <span className="flex min-w-0 flex-wrap items-center gap-x-2">
              <span>{connection?.provider === 'slack' ? lineLabel(connection) : e.provider}</span>
              <CopyId value={e.connectionId} label="connection ID" short />
            </span>
          </Fact>
          <Fact term="Received">
            <Time iso={e.receivedAt} abs />
          </Fact>
          <Fact term="Routed">{e.routedAt ? <Time iso={e.routedAt} abs /> : <span className="text-warn-ink">Not yet</span>}</Fact>
          <Fact term="Status">{STATE_TEXT[e.state]}</Fact>
          <Fact term="Dedup key">
            <code className="break-all text-ink-2">{e.dedupKey}</code>
          </Fact>
        </Facts>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1">
          <ConfirmButton
            small
            icon="replay"
            label="Replay event"
            confirmLabel="Re-route this event"
            onConfirm={async () => {
              await post(`/api/events/${e.id}/replay`)
              setReplayed(true)
            }}
          />
          {replayed ? (
            <span role="status" className="text-xs text-ok-ink">
              Queued. Refresh in a moment.
            </span>
          ) : (
            <span className="text-xs text-ink-3">Keeps existing deliveries; only new matches deliver.</span>
          )}
        </div>
      </Section>
      <Section id="p-deliveries" title="Deliveries" count={e.deliveries.length}>
        {e.deliveries.length === 0 ? (
          <p className="text-ink-2">
            No deliveries. {e.state === 'unmatched' ? 'No enabled route matched this event.' : STATE_TEXT[e.state] + '.'} <a href="#/routes">Check routes</a>
          </p>
        ) : (
          <>
            <Patch
              label="Destinations reached"
              live
              sourceCode={e.provider}
              sourceLabel={lineLabel(connection, e.connectionId, e.provider)}
              targets={e.deliveries.map((d) => ({
                key: d.id,
                code: d.destinationKind ?? 'dest',
                label: d.destinationName,
                note: `via ${d.routeName}`,
                lamp: { state: DELIVERY_LAMP[d.status] ?? 'off', text: d.status },
              }))}
            />
            <ul aria-label="Delivery details" className="divide-y divide-rule border-y border-rule">
              {e.deliveries.map((d) => (
                <DeliveryItem key={d.id} d={d} onChange={onChange} />
              ))}
            </ul>
          </>
        )}
      </Section>
      {e.actions.length > 0 ? (
        <Section id="p-actions" title="Actions" count={e.actions.length}>
          <ul aria-label="Actions" className="divide-y divide-rule border-y border-rule">
            {e.actions.map((a) => (
              <li key={a.id} className="flex flex-col gap-0.5 py-1.5">
                <div className="flex flex-wrap items-center gap-x-3">
                  <StatusMark value={a.status} />
                  <code className="text-ink">{a.type}</code>
                  <span className="text-xs text-ink-3">
                    {plural(a.attempts, 'attempt', 'attempts')}
                  </span>
                  <Time iso={a.createdAt} className="ml-auto text-xs text-ink-3" />
                </div>
                {a.error ? <p className="break-words text-bad-ink">{a.error}</p> : null}
              </li>
            ))}
          </ul>
          <Details summary="Actions JSON">
            <Json value={e.actions} label="Actions JSON" />
          </Details>
        </Section>
      ) : null}
      {e.agentRuns.length > 0 ? (
        <Section id="p-runs" title="Agent runs" count={e.agentRuns.length}>
          <ul aria-label="Agent runs" className="divide-y divide-rule border-y border-rule">
            {e.agentRuns.map((r) => (
              <li key={r.id} className="flex flex-col gap-0.5 py-1.5">
                <div className="flex flex-wrap items-center gap-x-3 text-xs text-ink-2">
                  <StatusMark value={r.status} />
                  <span>{plural(r.turns, 'turn', 'turns')}</span>
                  <span>
                    {r.inputTokens} in / {r.outputTokens} out
                  </span>
                  <span>${Number(r.costUsd).toFixed(4)} est.</span>
                  <Time iso={r.startedAt} className="ml-auto text-ink-3" />
                </div>
                {r.error ? <p className="break-words text-bad-ink">{r.error}</p> : null}
              </li>
            ))}
          </ul>
          <Details summary="Agent runs JSON">
            <Json value={e.agentRuns} label="Agent runs JSON" />
          </Details>
        </Section>
      ) : null}
      <Section id="p-envelope" title="Envelope">
        <Json value={e.envelope} label="Envelope JSON" />
      </Section>
      <Section id="p-raw" title="Raw payload">
        <Details summary="Show raw payload">
          <Json value={e.raw} label="Raw payload JSON" />
        </Details>
      </Section>
    </div>
  )
}

export function EventPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const state = useLoad(
    async () => {
      const [event, connections] = await Promise.all([get<EventDetail>(`/api/events/${id}`), get<{ items: Connection[] }>('/api/connections')])
      return { event, connections: connections.items }
    },
    [id],
  )
  const ref = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    if (!ref.current?.contains(document.activeElement)) ref.current?.focus()
  }, [id])
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) close.current()
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [])
  const e = state.data?.event.id === id ? state.data.event : null
  return (
    <div
      ref={ref}
      role="dialog"
      aria-labelledby="panel-title"
      tabIndex={-1}
      className="fixed inset-0 z-40 flex animate-slide flex-col bg-raised outline-none md:left-auto md:w-panel md:border-l md:border-line md:shadow-panel"
    >
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-rule pr-2 pl-4">
        <h2 id="panel-title" className="min-w-0 flex-1 truncate font-mono text-xs font-semibold">
          {e ? eventType(e) : 'Event'}
        </h2>
        {e ? <Time iso={e.receivedAt} className="text-xs text-ink-3" /> : null}
        <button type="button" className="btn btn-sm btn-icon btn-quiet" aria-label="Refresh event" title="Refresh" onClick={state.reload}>
          <Icon name="refresh" className="size-3.5" />
        </button>
        <button type="button" className="btn btn-sm btn-icon btn-quiet" aria-label="Close panel" title="Close (Esc)" onClick={onClose}>
          <Icon name="close" className="size-4" />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3">
        {e && state.data ? (
          <>
            {state.error ? <Notice tone="error" onRetry={state.reload}>Refresh failed: {state.error}</Notice> : null}
            <EventBody key={e.id} e={e} connections={state.data.connections} onChange={state.reload} />
          </>
        ) : state.error ? (
          <Notice tone="error" onRetry={state.reload}>
            Could not load: {state.error}
          </Notice>
        ) : (
          <SkeletonRows rows={6} height="h-6" />
        )}
      </div>
    </div>
  )
}
