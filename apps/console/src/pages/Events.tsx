import { useEffect, useState } from 'react'
import { get, post, type Connection, type EventDetail, type EventSummary } from '../api'
import { Async, ConfirmButton, fmtDate, Json, Page, Status } from '../components'
import { errorText, useLoad } from '../hooks'
import { DeliveryCard } from './Deliveries'

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
  const connections = useLoad(() => get<{ items: Connection[] }>('/api/connections'), [])
  const state = useLoad(() => get<{ items: EventSummary[]; nextCursor: string | null }>(query(applied)), [applied])

  useEffect(() => {
    setExtra([])
    setCursor(state.data?.nextCursor ?? null)
  }, [state.data])

  async function more() {
    if (!cursor) return
    setMoreError(null)
    try {
      const page = await get<{ items: EventSummary[]; nextCursor: string | null }>(query(applied, cursor))
      setExtra((e) => [...e, ...page.items])
      setCursor(page.nextCursor)
    } catch (e) {
      setMoreError(errorText(e))
    }
  }

  return (
    <Page title="Events" actions={<button onClick={state.reload}>Refresh</button>}>
      <form
        className="card filters"
        onSubmit={(e) => {
          e.preventDefault()
          setApplied(draft)
        }}
      >
        <label className="field">
          <span>Provider</span>
          <select value={draft.provider} onChange={(e) => setDraft({ ...draft, provider: e.target.value })}>
            <option value="">Any</option>
            <option value="slack">slack</option>
            <option value="webhook">webhook</option>
          </select>
        </label>
        <label className="field">
          <span>Connection</span>
          <select value={draft.connectionId} onChange={(e) => setDraft({ ...draft, connectionId: e.target.value })}>
            <option value="">Any</option>
            {connections.data?.items.map((c) => (
              <option key={c.id} value={c.id}>
                {c.provider} {c.userId ?? c.id.slice(0, 8)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Type prefix</span>
          <input value={draft.type} placeholder="slack.message." onChange={(e) => setDraft({ ...draft, type: e.target.value })} />
        </label>
        <label className="field">
          <span>Since</span>
          <input type="datetime-local" value={draft.since} onChange={(e) => setDraft({ ...draft, since: e.target.value })} />
        </label>
        <div className="row">
          <button className="primary">Apply</button>
          <button
            type="button"
            onClick={() => {
              setDraft(empty)
              setApplied(empty)
            }}
          >
            Clear
          </button>
        </div>
      </form>
      <Async state={state} empty={(d) => d.items.length === 0}>
        {(d) => (
          <>
            <ul className="list">
              {[...d.items, ...extra].map((e) => (
                <li key={e.id}>
                  <a className="card event" href={`#/events/${e.id}`}>
                    <div className="row between">
                      <code>{e.type}</code>
                      <span className="muted">{fmtDate(e.receivedAt)}</span>
                    </div>
                    <span className="clamp">{e.text ?? <em className="muted">no text</em>}</span>
                    <span className="row wrap">
                      <span className="muted">{e.provider}</span>
                      {e.subtype ? <span className="muted">{e.subtype}</span> : null}
                      {e.routedAt === null ? <Status value="pending" /> : null}
                      {e.deliveryCount > 0 ? <span className="muted">{e.deliveryCount} deliveries</span> : null}
                      {e.failedCount > 0 ? <Status value="failed" /> : null}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
            {moreError ? <p className="notice error">{moreError}</p> : null}
            {cursor ? <button onClick={more}>Load more</button> : <p className="muted">End of list.</p>}
          </>
        )}
      </Async>
    </Page>
  )
}

const STATE_TEXT: Record<EventDetail['state'], string> = {
  pending: 'Not routed yet',
  routed: 'Routed',
  unmatched: 'Routed, no route matched',
  skipped_echo: 'Skipped: echo of a relay message',
  skipped_inactive: 'Skipped: connection not active',
}

export function EventPage({ id }: { id: string }) {
  const state = useLoad(() => get<EventDetail>(`/api/events/${id}`), [id])
  const [replayed, setReplayed] = useState(false)
  return (
    <Page
      title="Event"
      actions={
        <>
          <a className="button" href="#/events">
            Back
          </a>
          <button onClick={state.reload}>Refresh</button>
        </>
      }
    >
      <Async state={state}>
        {(e) => (
          <div className="stack">
            <div className="card stack">
              <dl className="kv">
                <dt>ID</dt>
                <dd><code>{e.id}</code></dd>
                <dt>Provider</dt>
                <dd>{e.provider}</dd>
                <dt>Received</dt>
                <dd>{fmtDate(e.receivedAt)}</dd>
                <dt>Status</dt>
                <dd>{STATE_TEXT[e.state]}</dd>
              </dl>
              <div className="row">
                <ConfirmButton
                  label="Replay event"
                  confirmLabel="Re-route this event"
                  onConfirm={async () => {
                    await post(`/api/events/${e.id}/replay`)
                    setReplayed(true)
                  }}
                />
                {replayed ? <span className="muted">Queued. Refresh in a moment.</span> : null}
              </div>
              <p className="muted">Replay keeps existing deliveries. Only new matches create deliveries.</p>
            </div>
            <h2>Deliveries</h2>
            {e.deliveries.length === 0 ? <p className="muted empty">No deliveries.</p> : null}
            <ul className="list">
              {e.deliveries.map((d) => (
                <li key={d.id}>
                  <DeliveryCard d={d} onChange={state.reload} showEvent={false} />
                </li>
              ))}
            </ul>
            {e.actions.length > 0 ? (
              <>
                <h2>Actions</h2>
                <Json value={e.actions} />
              </>
            ) : null}
            {e.agentRuns.length > 0 ? (
              <>
                <h2>Agent runs</h2>
                <Json value={e.agentRuns} />
              </>
            ) : null}
            <h2>Envelope</h2>
            <Json value={e.envelope} />
            <h2>Raw</h2>
            <Json value={e.raw} />
          </div>
        )}
      </Async>
    </Page>
  )
}
