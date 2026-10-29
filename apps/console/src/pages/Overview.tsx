import { useEffect, type ReactNode } from 'react'
import { get, type Connection, type EventPage, type Overview as OverviewData } from '../api'
import { Async, cx, Empty, Page, SectionHead, Time } from '../components'
import { useLoad } from '../hooks'
import { Icon } from '../icons'
import { Lamp } from '../trace'
import { CallLog, CallLogSkeleton, KeyHints } from './CallLog'

const REFRESH_MS = 15_000

export function usd(v: string): string {
  const n = Number(v)
  if (n === 0) return '$0.00'
  if (n > 0 && n < 0.01) return '<$0.01'
  return `$${n.toFixed(2)}`
}

function Count({ n, label, href, tone }: { n: ReactNode; label: string; href?: string; tone?: 'bad' | 'warn' }) {
  const body = (
    <>
      <span className={cx('font-semibold', tone === 'bad' ? 'text-bad-ink' : tone === 'warn' ? 'text-warn-ink' : 'text-ink')}>{n}</span>{' '}
      <span className="text-ink-2">{label}</span>
    </>
  )
  return (
    <li className="inline-flex items-center gap-1.5">
      {tone === 'bad' ? <Lamp key="bad" state="bad" className="size-2" /> : null}
      {href ? (
        <a href={href} className="no-underline hover:underline">
          {body}
        </a>
      ) : (
        <span>{body}</span>
      )}
    </li>
  )
}

function Counts({ o }: { o: OverviewData }) {
  const failed = o.deliveries.failed
  return (
    <div className="flex min-h-8 flex-wrap items-center justify-between gap-x-6 gap-y-1 rounded-ctl border border-rule bg-raised px-3 py-1">
      <ul aria-label="Last 24 hours" className="flex flex-wrap items-center gap-x-4 gap-y-0.5">
        <li className="text-xs font-medium text-ink-3">24h</li>
        <Count n={o.events} label="calls" href="#/events" />
        <li className="text-ink-3">· Deliveries:</li>
        <Count n={o.deliveries.succeeded} label="delivered" href="#/deliveries" />
        <Count n={o.deliveries.pending} label="pending" href="#/deliveries" tone={o.deliveries.pending ? 'warn' : undefined} />
        <Count n={failed} label="failed" href="#/deliveries" tone={failed ? 'bad' : undefined} />
        {o.failedActions ? <Count n={o.failedActions} label="actions failed" tone="bad" /> : null}
      </ul>
      <p className="text-xs text-ink-3">
        {o.failedActions ? null : <>0 actions failed · </>}
        {o.agentRuns} agent {o.agentRuns === 1 ? 'run' : 'runs'} · {usd(o.agentCostUsd)} est. cost
      </p>
    </div>
  )
}

function CountsSkeleton() {
  return (
    <div aria-hidden="true" className="flex h-8 items-center gap-4 rounded-ctl border border-rule px-3">
      {Array.from({ length: 4 }, (_, i) => (
        <span key={i} className="h-2.5 w-16 rounded-jack bg-skeleton" />
      ))}
    </div>
  )
}

export function Overview({ open }: { open: string | null }) {
  const overview = useLoad(() => get<OverviewData>('/api/overview'), [])
  const calls = useLoad(
    async () => {
      const [events, connections] = await Promise.all([get<EventPage>('/api/events?limit=50'), get<{ items: Connection[] }>('/api/connections')])
      return { events: events.items, connections: connections.items, at: new Date().toISOString() }
    },
    [],
  )
  const { reload: reloadOverview } = overview
  const { reload: reloadCalls } = calls

  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState !== 'visible') return
      reloadOverview()
      reloadCalls()
    }, REFRESH_MS)
    return () => clearInterval(t)
  }, [reloadOverview, reloadCalls])

  const refresh = () => {
    reloadOverview()
    reloadCalls()
  }

  return (
    <Page
      title="Overview"
      meta="Last 24 hours, all connections"
      actions={
        <button type="button" className="btn btn-sm" onClick={refresh}>
          <Icon name="refresh" className="size-3.5" />
          Refresh
        </button>
      }
    >
      <Async state={overview} skeleton={<CountsSkeleton />}>
        {(o) => <Counts o={o} />}
      </Async>
      <section aria-labelledby="calls-title" className="flex min-w-0 flex-col gap-1">
        <SectionHead id="calls-title" title="Live call log">
          {calls.data ? (
            <span>
              Updated <Time iso={calls.data.at} /> · every 15s
            </span>
          ) : null}
        </SectionHead>
        <Async
          state={calls}
          skeleton={<CallLogSkeleton />}
          empty={{
            when: (d) => d.events.length === 0,
            render: () => (
              <Empty
                title="No calls yet"
                action={
                  <a href="#/connections" className="btn btn-primary">
                    Add a connection
                  </a>
                }
              >
                Events show up here as soon as a connection receives one. Connect Slack or create a signed webhook to start.
              </Empty>
            ),
          }}
        >
          {(d) => (
            <>
              <CallLog label="Latest calls" base="/" open={open} events={d.events} connections={d.connections} onChange={refresh} />
              <div className="flex min-h-8 items-center justify-between gap-4">
                <a href="#/events" className="text-xs font-medium">
                  All events and filters
                </a>
                <KeyHints />
              </div>
            </>
          )}
        </Async>
      </section>
    </Page>
  )
}
