import { useEffect, useState } from 'react'
import { get, post, type Connection, type EventDetail, type EventPage as EventList, type EventSummary } from '../api'
import {
  Async,
  ConfirmButton,
  CopyId,
  Details,
  Empty,
  Fact,
  Facts,
  Field,
  Json,
  Notice,
  Page,
  SectionHead,
  SkeletonRows,
  Time,
} from '../components'
import { errorText, useLoad } from '../hooks'
import { Icon } from '../icons'
import { lineLabel, Patch } from '../patch'
import { StatusMark, TraceDetail, traceOfDetail, type LampState } from '../trace'
import { CallLog, CallLogSkeleton } from './CallLog'
import { DeliveryItem } from './Deliveries'

interface Filters {
  provider: string
  connectionId: string
  type: string
  since: string
}

const empty: Filters = { provider: '', connectionId: '', type: '', since: '' }

function query(f: Filters, cursor?: string) {
  const p = new URLSearchParams()
  if (f.provider) p.set('provider', f.provider)
  if (f.connectionId) p.set('connectionId', f.connectionId)
  if (f.type) p.set('type', f.type)
  if (f.since) p.set('since', new Date(f.since).toISOString())
  if (cursor) p.set('cursor', cursor)
  return `/api/events?${p.toString()}`
}

export function Events() {
  const [draft, setDraft] = useState<Filters>(empty)
  const [applied, setApplied] = useState<Filters>(empty)
  const [extra, setExtra] = useState<EventSummary[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [moreError, setMoreError] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const connections = useLoad(() => get<{ items: Connection[] }>('/api/connections'), [])
  const state = useLoad(() => get<EventList>(query(applied)), [applied])
  const filtered = Object.values(applied).some(Boolean)

  useEffect(() => {
    setExtra([])
    setCursor(state.data?.nextCursor ?? null)
  }, [state.data])

  async function more() {
    if (!cursor) return
    setMoreError(null)
    setLoadingMore(true)
    try {
      const page = await get<EventList>(query(applied, cursor))
      setExtra((e) => [...e, ...page.items])
      setCursor(page.nextCursor)
    } catch (e) {
      setMoreError(errorText(e))
    } finally {
      setLoadingMore(false)
    }
  }

  const clear = () => {
    setDraft(empty)
    setApplied(empty)
  }

  return (
    <Page
      title="Events"
      meta="Every call Relay received, newest first."
      actions={
        <button type="button" className="btn" onClick={state.reload}>
          <Icon name="refresh" className="size-3.5" />
          Refresh
        </button>
      }
    >
      <form
        aria-label="Filter events"
        className="grid grid-cols-1 items-end gap-3 border-y border-rule py-3 sm:grid-cols-2 lg:grid-cols-[repeat(4,minmax(0,1fr))_auto]"
        onSubmit={(e) => {
          e.preventDefault()
          setApplied(draft)
        }}
      >
        <Field label="Provider">
          {(p) => (
            <select {...p} className="input" value={draft.provider} onChange={(e) => setDraft({ ...draft, provider: e.target.value })}>
              <option value="">Any</option>
              <option value="slack">slack</option>
              <option value="webhook">webhook</option>
            </select>
          )}
        </Field>
        <Field label="Connection">
          {(p) => (
            <select {...p} className="input" value={draft.connectionId} onChange={(e) => setDraft({ ...draft, connectionId: e.target.value })}>
              <option value="">Any</option>
              {connections.data?.items.map((c) => (
                <option key={c.id} value={c.id}>
                  {lineLabel(c)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Type prefix">
          {(p) => <input {...p} className="input font-mono" value={draft.type} placeholder="slack.message." onChange={(e) => setDraft({ ...draft, type: e.target.value })} />}
        </Field>
        <Field label="Since">
          {(p) => <input {...p} className="input" type="datetime-local" value={draft.since} onChange={(e) => setDraft({ ...draft, since: e.target.value })} />}
        </Field>
        <div className="flex gap-2">
          <button className="btn btn-primary">Apply</button>
          <button type="button" className="btn" onClick={clear}>
            Clear
          </button>
        </div>
      </form>
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
                Try a shorter type prefix or an earlier start time.
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
          <div className="flex flex-col gap-3">
            <CallLog
              label="Events"
              events={[...d.items, ...extra]}
              connections={connections.data?.items ?? []}
              onChange={state.reload}
            />
            <p role="status" className="sr-only">
              {d.items.length + extra.length} events shown
            </p>
            {moreError ? <Notice tone="error" onRetry={more}>Could not load more: {moreError}</Notice> : null}
            {cursor ? (
              <button type="button" className="btn self-start" onClick={more} disabled={loadingMore}>
                {loadingMore ? 'Loading…' : 'Load more'}
              </button>
            ) : (
              <p className="text-sm text-ink-3">End of list.</p>
            )}
          </div>
        )}
      </Async>
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

function DetailSkeleton() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-6">
      <div className="grid h-24 grid-cols-5 border-y border-rule">
        {Array.from({ length: 5 }, (_, i) => (
          <span key={i} className="m-3 h-4 w-16 rounded-jack bg-skeleton" />
        ))}
      </div>
      <SkeletonRows rows={4} height="h-8" />
    </div>
  )
}

export function EventPage({ id }: { id: string }) {
  const state = useLoad(
    async () => {
      const [event, connections] = await Promise.all([get<EventDetail>(`/api/events/${id}`), get<{ items: Connection[] }>('/api/connections')])
      return { event, connections: connections.items }
    },
    [id],
  )
  const [replayed, setReplayed] = useState(false)
  const e = state.data?.event
  return (
    <Page
      title={e ? <span className="font-mono">{eventType(e)}</span> : 'Event'}
      meta={e ? <Time iso={e.receivedAt} /> : null}
      actions={
        <>
          <a className="btn" href="#/events">
            <Icon name="back" className="size-3.5" />
            Events
          </a>
          <button type="button" className="btn" onClick={state.reload}>
            <Icon name="refresh" className="size-3.5" />
            Refresh
          </button>
        </>
      }
    >
      <Async state={state} skeleton={<DetailSkeleton />}>
        {({ event: e, connections }) => {
          const connection = connections.find((c) => c.id === e.connectionId)
          return (
            <>
              <TraceDetail trace={traceOfDetail(e)} />
              <section aria-labelledby="facts" className="flex flex-col gap-3">
                <SectionHead id="facts" title="Call" />
                <Facts>
                  <Fact term="Event ID">
                    <CopyId value={e.id} label="event ID" />
                  </Fact>
                  <Fact term="Line">
                    <span className="flex min-w-0 flex-wrap items-center gap-x-2">
                      <span>{connection?.provider === 'slack' ? lineLabel(connection) : e.provider}</span>
                      <CopyId value={e.connectionId} label="connection ID" />
                    </span>
                  </Fact>
                  <Fact term="Received">
                    <Time iso={e.receivedAt} />
                  </Fact>
                  <Fact term="Routed">
                    {e.routedAt ? <Time iso={e.routedAt} /> : <span className="text-warn-ink">Not yet</span>}
                  </Fact>
                  <Fact term="Status">{STATE_TEXT[e.state]}</Fact>
                  <Fact term="Dedup key">
                    <code className="text-ink-2">{e.dedupKey}</code>
                  </Fact>
                </Facts>
                <div className="flex flex-col gap-1.5 border-t border-rule pt-3">
                  <div className="flex flex-wrap items-center gap-3">
                    <ConfirmButton
                      icon="replay"
                      label="Replay event"
                      confirmLabel="Re-route this event"
                      onConfirm={async () => {
                        await post(`/api/events/${e.id}/replay`)
                        setReplayed(true)
                      }}
                    />
                    {replayed ? (
                      <span role="status" className="text-sm text-ok-ink">
                        Queued. Refresh in a moment.
                      </span>
                    ) : null}
                  </div>
                  <p className="text-xs text-ink-2">Replay keeps existing deliveries. Only new matches create deliveries.</p>
                </div>
              </section>
              <section aria-labelledby="deliveries" className="flex flex-col gap-3">
                <SectionHead id="deliveries" title="Deliveries">
                  {e.deliveries.length}
                </SectionHead>
                {e.deliveries.length === 0 ? (
                  <p className="text-sm text-ink-2">
                    No deliveries. {e.state === 'unmatched' ? 'No enabled route matched this event.' : STATE_TEXT[e.state] + '.'}{' '}
                    <a href="#/routes">Check routes</a>
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
                        <DeliveryItem key={d.id} d={d} onChange={state.reload} showEvent={false} />
                      ))}
                    </ul>
                  </>
                )}
              </section>
              {e.actions.length > 0 ? (
                <section aria-labelledby="actions" className="flex flex-col gap-3">
                  <SectionHead id="actions" title="Actions">
                    {e.actions.length}
                  </SectionHead>
                  <ul aria-label="Actions" className="divide-y divide-rule border-y border-rule">
                    {e.actions.map((a) => (
                      <li key={a.id} className="flex flex-col gap-1 px-2 py-2.5">
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                          <StatusMark value={a.status} />
                          <code className="font-bold">{a.type}</code>
                          <span className="text-xs text-ink-2">
                            {a.attempts} {a.attempts === 1 ? 'attempt' : 'attempts'}
                          </span>
                          <Time iso={a.createdAt} className="text-xs text-ink-2" />
                        </div>
                        {a.error ? <p className="text-sm break-words text-bad-ink">{a.error}</p> : null}
                      </li>
                    ))}
                  </ul>
                  <Details summary="Actions JSON">
                    <Json value={e.actions} label="Actions JSON" />
                  </Details>
                </section>
              ) : null}
              {e.agentRuns.length > 0 ? (
                <section aria-labelledby="runs" className="flex flex-col gap-3">
                  <SectionHead id="runs" title="Agent runs">
                    {e.agentRuns.length}
                  </SectionHead>
                  <ul aria-label="Agent runs" className="divide-y divide-rule border-y border-rule">
                    {e.agentRuns.map((r) => (
                      <li key={r.id} className="flex flex-col gap-1 px-2 py-2.5">
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-2">
                          <StatusMark value={r.status} />
                          <span>{r.turns} turns</span>
                          <span>
                            {r.inputTokens} in / {r.outputTokens} out tokens
                          </span>
                          <span>${Number(r.costUsd).toFixed(4)} est.</span>
                          <Time iso={r.startedAt} />
                        </div>
                        {r.error ? <p className="text-sm break-words text-bad-ink">{r.error}</p> : null}
                      </li>
                    ))}
                  </ul>
                  <Details summary="Agent runs JSON">
                    <Json value={e.agentRuns} label="Agent runs JSON" />
                  </Details>
                </section>
              ) : null}
              <section aria-labelledby="envelope" className="flex flex-col gap-3">
                <SectionHead id="envelope" title="Envelope" />
                <Json value={e.envelope} label="Envelope JSON" />
              </section>
              <section aria-labelledby="raw" className="flex flex-col gap-3">
                <SectionHead id="raw" title="Raw payload" />
                <Json value={e.raw} label="Raw payload JSON" />
              </section>
            </>
          )
        }}
      </Async>
    </Page>
  )
}
