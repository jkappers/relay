import { useState } from 'react'
import { get, post, type DeliveryRow } from '../api'
import { condenseCause } from '../cause'
import { Async, ConfirmButton, CopyId, cx, Details, Empty, Json, Page, Segmented, SkeletonRows, Time } from '../components'
import { eventHref, navigate, useLoad } from '../hooks'
import { Icon } from '../icons'
import { StatusMark } from '../trace'

const statusOf = (d: DeliveryRow) => (d.status === 'pending' && d.attempts > 0 ? 'retrying' : d.status)

export function DeliveryItem({ d, onChange }: { d: DeliveryRow; onChange: () => void }) {
  return (
    <li className="flex min-w-0 flex-col gap-1 py-2 text-xs text-ink-3 [&_dd]:text-ink-2">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <dl className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-0.5">
          <div className="flex min-w-0 gap-1">
            <dt className="sr-only">Destination</dt>
            <dd className="truncate font-medium">{d.destinationName}</dd>
          </div>
          <div className="flex gap-1">
            <dt>Attempts</dt>
            <dd>{d.attempts}</dd>
          </div>
          {d.lastStatusCode !== null ? (
            <div className="flex gap-1">
              <dt>Status</dt>
              <dd>{d.lastStatusCode}</dd>
            </div>
          ) : null}
          <div className="flex min-w-0 items-center gap-1">
            <dt>ID</dt>
            <dd className="min-w-0">
              <CopyId value={d.id} label="delivery ID" short />
            </dd>
          </div>
        </dl>
        <span className="flex items-center gap-1">
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
        </span>
      </div>
      {d.lastError ? <p className="font-mono break-words text-bad-ink">{d.lastError}</p> : null}
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-0.5">
        <dt>Created</dt>
        <dd>
          <Time iso={d.createdAt} abs />
        </dd>
        {d.status === 'pending' && d.nextAttemptAt ? (
          <>
            <dt>Next try</dt>
            <dd>
              <Time iso={d.nextAttemptAt} abs />
            </dd>
          </>
        ) : null}
        {d.completedAt ? (
          <>
            <dt>Done</dt>
            <dd>
              <Time iso={d.completedAt} abs />
            </dd>
          </>
        ) : null}
      </dl>
      {d.responseBody !== null && d.responseBody !== undefined ? (
        <Details summary="Response body">
          <Json value={d.responseBody} label="Response body" />
        </Details>
      ) : null}
    </li>
  )
}

const COLS =
  'grid grid-cols-[5.5rem_minmax(0,1fr)_auto_auto] gap-x-3 px-3 [grid-template-areas:"st_ev_ev_ag"_"rt_rt_oc_ac"] md:grid-cols-[5.5rem_minmax(0,1.1fr)_minmax(0,1.2fr)_3.5rem_minmax(0,1fr)_4.5rem_1.75rem] md:gap-x-4 md:[grid-template-areas:"st_ev_rt_at_oc_ag_ac"]'

const STATUSES = [
  ['', 'All'],
  ['failed', 'Failed'],
  ['pending', 'Pending'],
  ['succeeded', 'Succeeded'],
] as const

type Status = (typeof STATUSES)[number][0]

function Row({ d, open, onChange }: { d: DeliveryRow; open: string | null; onChange: () => void }) {
  const href = eventHref('/deliveries', d.eventId)
  const cause = d.status === 'failed' ? condenseCause(d.lastError) : d.lastStatusCode !== null ? `HTTP ${d.lastStatusCode}` : ''
  return (
    <div role="row" className={cx('tr cursor-pointer py-1 md:py-0', COLS, open === d.eventId && 'is-sel')} onClick={() => navigate(href.slice(1))}>
      <span role="cell" className="flex h-6 items-center text-xs [grid-area:st] md:h-8">
        <StatusMark value={statusOf(d)} />
      </span>
      <span role="cell" className="min-w-0 truncate [grid-area:ev]">
        <a href={href} data-ev={d.eventId} onClick={(x) => x.stopPropagation()} className="font-mono text-xs text-ink no-underline hover:text-ink">
          {d.eventType ?? d.eventId.slice(0, 8)}
        </a>
      </span>
      <span role="cell" className="flex min-w-0 items-center gap-1.5 text-ink-2 [grid-area:rt]">
        <span className="truncate">{d.routeName}</span>
        <Icon name="send" className="size-3 text-ink-3" />
        <span className="sr-only">to</span>
        <span className="truncate text-ink">{d.destinationName}</span>
      </span>
      <span role="cell" className="text-right text-xs text-ink-2 max-md:hidden md:[grid-area:at]">
        {d.attempts}
        <span className="sr-only"> attempts</span>
      </span>
      <span role="cell" title={d.lastError ?? undefined} className={cx('min-w-0 truncate font-mono text-xs [grid-area:oc]', d.status === 'failed' ? 'font-medium text-bad-ink' : 'text-ink-3')}>
        {cause}
      </span>
      <span role="cell" className="text-right text-xs text-ink-3 [grid-area:ag]">
        <Time iso={d.createdAt} bare />
      </span>
      <span role="cell" className="flex justify-end [grid-area:ac]">
        {d.status === 'failed' ? (
          <ConfirmButton
            small
            iconOnly
            icon="replay"
            label="Replay delivery"
            question="Replay?"
            confirmLabel="Replay"
            doneText="Replay queued"
            onConfirm={async () => {
              await post(`/api/deliveries/${d.id}/replay`)
              onChange()
            }}
          />
        ) : null}
      </span>
    </div>
  )
}

export function Deliveries({ open }: { open: string | null }) {
  const [status, setStatus] = useState<Status>('')
  const state = useLoad(() => get<{ items: DeliveryRow[] }>(`/api/deliveries${status ? `?status=${status}` : ''}`), [status])
  return (
    <Page
      title="Deliveries"
      meta="The 100 newest deliveries to your destinations"
      actions={
        <button type="button" className="btn btn-sm" onClick={state.reload}>
          <Icon name="refresh" className="size-3.5" />
          Refresh
        </button>
      }
    >
      <div className="flex flex-col gap-1">
        <div className="flex min-h-8 items-center">
          <Segmented label="Status" value={status} options={STATUSES} onChange={setStatus} />
        </div>
        <Async
          state={state}
          skeleton={<SkeletonRows rows={12} />}
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
            <div role="table" aria-label="Deliveries" className="min-w-0 border-t border-rule md:border-t-0">
              <div role="row" className={cx('th hidden md:grid', COLS)}>
                <span role="columnheader">Status</span>
                <span role="columnheader">Event</span>
                <span role="columnheader">Route to destination</span>
                <span role="columnheader" className="text-right">
                  Tries
                </span>
                <span role="columnheader">Result</span>
                <span role="columnheader" className="text-right">
                  Age
                </span>
                <span role="columnheader">
                  <span className="sr-only">Actions</span>
                </span>
              </div>
              {d.items.map((x) => (
                <Row key={x.id} d={x} open={open} onChange={state.reload} />
              ))}
            </div>
          )}
        </Async>
      </div>
    </Page>
  )
}
