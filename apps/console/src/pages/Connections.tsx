import { get, post, connectionsChanged, type Connection } from '../api'
import { Async, ConfirmButton, CopyId, cx, Empty, Page, SkeletonRows, Time } from '../components'
import { useLoad } from '../hooks'
import { Icon } from '../icons'
import { jackCode, lineLabel } from '../patch'
import { StatusMark } from '../trace'

const COLS = 'grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-0.5 px-3 md:grid-cols-[minmax(0,10rem)_6rem_minmax(0,9rem)_minmax(0,1fr)_6rem_minmax(0,auto)]'

export function Connections() {
  const state = useLoad(() => get<{ items: Connection[] }>('/api/connections'), [])
  const actions = (
    <a className="btn btn-primary btn-sm" href="#/new">
      <Icon name="plus" className="size-3.5" />
      New connection
    </a>
  )

  return (
    <Page title="Connections" meta="Lines that bring events in. Each one keeps its own routes, destinations, and events." actions={actions}>
      <Async
        state={state}
        skeleton={<SkeletonRows rows={4} />}
        empty={{
          when: (d) => d.items.length === 0,
          render: () => (
            <Empty title="No connections yet" action={actions}>
              Connect Slack, add the Relay bot to a Discord server, add an SMS number, or create a signed webhook.
            </Empty>
          ),
        }}
      >
        {(d) => (
          <div role="table" aria-label="Connections" className="min-w-0 border-t border-rule md:border-t-0">
            <div role="row" className={cx('th hidden md:grid', COLS)}>
              <span role="columnheader">Line</span>
              <span role="columnheader">Status</span>
              <span role="columnheader">ID</span>
              <span role="columnheader">Team / user</span>
              <span role="columnheader" className="text-right">
                Created
              </span>
              <span role="columnheader">
                <span className="sr-only">Actions</span>
              </span>
            </div>
            {d.items.map((c) => (
              <div role="row" key={c.id} className={cx('tr py-1 md:py-0', COLS)}>
                <span role="cell" className="flex min-w-0 items-center gap-2">
                  <span className="jack-code" title={c.provider}>
                    {jackCode(c.provider)}
                  </span>
                  <a href={`#/c/${c.id}`} className="min-w-0 truncate font-medium text-ink no-underline hover:underline" title={lineLabel(c)}>
                    {lineLabel(c)}
                  </a>
                </span>
                <span role="cell" className="text-xs">
                  <StatusMark value={c.status} />
                </span>
                <span role="cell" className="min-w-0">
                  <CopyId value={c.id} label="connection ID" short />
                </span>
                <span role="cell" className="min-w-0 truncate font-mono text-xs text-ink-2">
                  {[c.teamId, c.userId].filter(Boolean).join(' / ') || <span className="text-ink-3">—</span>}
                </span>
                <span role="cell" className="text-xs text-ink-3 md:text-right">
                  <Time iso={c.createdAt} />
                </span>
                <span role="cell" className="relative flex justify-end">
                  {c.status === 'active' ? (
                    <ConfirmButton
                      small
                      quiet
                      label="Revoke"
                      question="Stop accepting events?"
                      confirmLabel="Revoke connection"
                      danger
                      onConfirm={async () => {
                        await post(`/api/c/${c.id}/revoke`)
                        state.reload()
                        connectionsChanged()
                      }}
                    />
                  ) : null}
                </span>
              </div>
            ))}
          </div>

        )}
      </Async>
    </Page>
  )
}
