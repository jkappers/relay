import { useState } from 'react'
import { get, post, type DeliveryRow } from '../api'
import { Async, ConfirmButton, fmtDate, Json, Page, Status } from '../components'
import { useLoad } from '../hooks'

export function DeliveryCard({ d, onChange, showEvent = true }: { d: DeliveryRow; onChange: () => void; showEvent?: boolean }) {
  return (
    <div className="card stack">
      <div className="row between">
        <strong>
          {d.routeName} → {d.destinationName}
        </strong>
        <Status value={d.status} />
      </div>
      <dl className="kv">
        {showEvent ? (
          <>
            <dt>Event</dt>
            <dd>
              <a href={`#/events/${d.eventId}`}>
                <code>{d.eventType ?? d.eventId}</code>
              </a>
            </dd>
          </>
        ) : null}
        <dt>Attempts</dt>
        <dd>{d.attempts}</dd>
        {d.lastStatusCode !== null ? (<><dt>Last status</dt><dd>{d.lastStatusCode}</dd></>) : null}
        {d.lastError ? (<><dt>Last error</dt><dd className="bad-text">{d.lastError}</dd></>) : null}
        {d.status === 'pending' && d.nextAttemptAt ? (<><dt>Next attempt</dt><dd>{fmtDate(d.nextAttemptAt)}</dd></>) : null}
        <dt>Created</dt>
        <dd>{fmtDate(d.createdAt)}</dd>
      </dl>
      {d.responseBody !== null && d.responseBody !== undefined ? (
        <details>
          <summary>Response body</summary>
          <Json value={d.responseBody} />
        </details>
      ) : null}
      <div className="row wrap">
        {d.status === 'failed' ? (
          <ConfirmButton
            label="Replay"
            confirmLabel="Replay delivery"
            onConfirm={async () => {
              await post(`/api/deliveries/${d.id}/replay`)
              onChange()
            }}
          />
        ) : null}
        {d.lastReplyJti ? (
          <ConfirmButton
            danger
            label="Revoke reply token"
            confirmLabel="Revoke token"
            onConfirm={() => post('/api/tokens/revoke', { jti: d.lastReplyJti })}
          />
        ) : null}
      </div>
    </div>
  )
}

export function Deliveries() {
  const [status, setStatus] = useState('')
  const state = useLoad(() => get<{ items: DeliveryRow[] }>(`/api/deliveries${status ? `?status=${status}` : ''}`), [status])
  return (
    <Page title="Deliveries" actions={<button onClick={state.reload}>Refresh</button>}>
      <label className="field narrow">
        <span>Status</span>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All</option>
          <option value="failed">Failed</option>
          <option value="pending">Pending</option>
          <option value="succeeded">Succeeded</option>
        </select>
      </label>
      <Async state={state} empty={(d) => d.items.length === 0}>
        {(d) => (
          <ul className="list">
            {d.items.map((x) => (
              <li key={x.id}>
                <DeliveryCard d={x} onChange={state.reload} />
              </li>
            ))}
          </ul>
        )}
      </Async>
    </Page>
  )
}
