import { get, type Overview as OverviewData } from '../api'
import { Async, Page } from '../components'
import { useLoad } from '../hooks'

function Stat({ label, value, href, tone }: { label: string; value: string | number; href?: string; tone?: 'bad' }) {
  const body = (
    <>
      <span className="stat-value">{value}</span>
      <span className="muted">{label}</span>
    </>
  )
  return href ? (
    <a className={`card stat ${tone ?? ''}`} href={href}>
      {body}
    </a>
  ) : (
    <div className={`card stat ${tone ?? ''}`}>{body}</div>
  )
}

export function Overview() {
  const state = useLoad(() => get<OverviewData>('/api/overview'), [])
  return (
    <Page title="Overview" actions={<button onClick={state.reload}>Refresh</button>}>
      <Async state={state}>
        {(o) => (
          <>
            <p className="muted">Last {o.windowHours} hours.</p>
            <div className="grid">
              <Stat label="Events" value={o.events} href="#/events" />
              <Stat label="Deliveries succeeded" value={o.deliveries.succeeded} href="#/deliveries" />
              <Stat label="Deliveries pending" value={o.deliveries.pending} href="#/deliveries" />
              <Stat label="Deliveries failed" value={o.deliveries.failed} href="#/deliveries" tone={o.deliveries.failed > 0 ? 'bad' : undefined} />
              <Stat label="Failed actions" value={o.failedActions} tone={o.failedActions > 0 ? 'bad' : undefined} />
              <Stat label="Agent runs" value={o.agentRuns} />
              <Stat label="Agent cost (USD, estimate)" value={`$${Number(o.agentCostUsd).toFixed(4)}`} />
            </div>
          </>
        )}
      </Async>
    </Page>
  )
}
