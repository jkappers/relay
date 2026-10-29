import { useState } from 'react'
import { get, post, type DeliveryRow } from '../api'
import { Async, ConfirmButton, CopyId, Details, Empty, Field, Json, Page, SkeletonRows, Time } from '../components'
import { useLoad } from '../hooks'
import { Icon } from '../icons'
import { StatusMark } from '../trace'

export function DeliveryItem({ d, onChange, showEvent = true }: { d: DeliveryRow; onChange: () => void; showEvent?: boolean }) {
  const retrying = d.status === 'pending' && d.attempts > 0
  return (
    <li className="flex min-w-0 flex-col gap-2 px-2 py-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <StatusMark value={d.status} label={retrying ? 'retrying' : d.status} />
          <span className="flex min-w-0 items-center gap-1.5 font-bold">
            <span className="truncate">{d.routeName}</span>
            <Icon name="send" className="size-3.5 text-ink-3" />
            <span className="sr-only">to</span>
            <span className="truncate">{d.destinationName}</span>
          </span>
          {showEvent ? (
            <a href={`#/events/${d.eventId}`} className="min-w-0 truncate font-mono text-sm">
              {d.eventType ?? d.eventId}
            </a>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {d.status === 'failed' ? (
            <ConfirmButton
              small
              icon="replay"
              label="Replay"
              confirmLabel="Replay delivery"
              doneText="Queued"
              onConfirm={async () => {
                await post(`/api/deliveries/${d.id}/replay`)
                onChange()
              }}
            />
          ) : null}
          {d.lastReplyJti ? (
            <ConfirmButton
              small
              danger
              quiet
              label="Revoke reply token"
              confirmLabel="Revoke token"
              doneText="Token revoked"
              onConfirm={() => post('/api/tokens/revoke', { jti: d.lastReplyJti })}
            />
          ) : null}
        </div>
      </div>
      {d.lastError ? (
        <p className="text-sm break-words text-bad-ink">
          <span className="font-bold">Cause: </span>
          {d.lastError}
        </p>
      ) : null}
      <dl className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-ink-2">
        <div className="flex gap-1">
          <dt>Attempts</dt>
          <dd className="font-bold text-ink">{d.attempts}</dd>
        </div>
        {d.lastStatusCode !== null ? (
          <div className="flex gap-1">
            <dt>Last status</dt>
            <dd className="font-bold text-ink">{d.lastStatusCode}</dd>
          </div>
        ) : null}
        {d.status === 'pending' && d.nextAttemptAt ? (
          <div className="flex gap-1">
            <dt>Next attempt</dt>
            <dd className="text-ink">
              <Time iso={d.nextAttemptAt} />
            </dd>
          </div>
        ) : null}
        <div className="flex gap-1">
          <dt>Created</dt>
          <dd className="text-ink">
            <Time iso={d.createdAt} />
          </dd>
        </div>
        {d.completedAt ? (
          <div className="flex gap-1">
            <dt>Completed</dt>
            <dd className="text-ink">
              <Time iso={d.completedAt} />
            </dd>
          </div>
        ) : null}
        <div className="flex min-w-0 items-center gap-1">
          <dt>ID</dt>
          <dd className="min-w-0">
            <CopyId value={d.id} label="delivery ID" short />
          </dd>
        </div>
      </dl>
      {d.responseBody !== null && d.responseBody !== undefined ? (
        <Details summary="Response body">
          <Json value={d.responseBody} label="Response body" />
        </Details>
      ) : null}
    </li>
  )
}

export function Deliveries() {
  const [status, setStatus] = useState('')
  const state = useLoad(() => get<{ items: DeliveryRow[] }>(`/api/deliveries${status ? `?status=${status}` : ''}`), [status])
  return (
    <Page
      title="Deliveries"
      meta="The 100 newest deliveries to your destinations."
      actions={
        <button type="button" className="btn" onClick={state.reload}>
          <Icon name="refresh" className="size-3.5" />
          Refresh
        </button>
      }
    >
      <Field label="Status" className="w-48">
        {(p) => (
          <select {...p} className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option>
            <option value="failed">Failed</option>
            <option value="pending">Pending</option>
            <option value="succeeded">Succeeded</option>
          </select>
        )}
      </Field>
      <Async
        state={state}
        skeleton={<SkeletonRows rows={6} height="h-24" />}
        empty={{
          when: (d) => d.items.length === 0,
          render: () =>
            status ? (
              <Empty
                title={`No ${status} deliveries`}
                action={
                  <button type="button" className="btn" onClick={() => setStatus('')}>
                    Show all
                  </button>
                }
              >
                Nothing in the 100 newest deliveries has this status.
              </Empty>
            ) : (
              <Empty
                title="No deliveries yet"
                action={
                  <a href="#/routes" className="btn btn-primary">
                    Set up a route
                  </a>
                }
              >
                A delivery is made when a route sends an event to a destination. Patch a line to a destination on the Routes page.
              </Empty>
            ),
        }}
      >
        {(d) => (
          <ul aria-label="Deliveries" className="divide-y divide-rule border-y border-rule">
            {d.items.map((x) => (
              <DeliveryItem key={x.id} d={x} onChange={state.reload} />
            ))}
          </ul>
        )}
      </Async>
    </Page>
  )
}
