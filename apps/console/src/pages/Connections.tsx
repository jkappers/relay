import { useState } from 'react'
import { get, post, type Connection, type WebhookCreated } from '../api'
import { Async, ConfirmButton, CopyId, cx, Empty, FormError, Page, SecretBox, SkeletonRows, Time } from '../components'
import { errorText, useLoad } from '../hooks'
import { Icon } from '../icons'
import { jackCode } from '../patch'
import { StatusMark } from '../trace'

const COLS = 'grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-0.5 px-3 md:grid-cols-[minmax(0,10rem)_6rem_minmax(0,9rem)_minmax(0,1fr)_6rem_minmax(0,auto)]'

export function Connections() {
  const state = useLoad(() => get<{ items: Connection[] }>('/api/connections'), [])
  const [created, setCreated] = useState<WebhookCreated | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function createWebhook() {
    setBusy(true)
    setError(null)
    try {
      setCreated(await post<WebhookCreated>('/api/connections/webhook'))
      state.reload()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const actions = (
    <>
      <a className="btn btn-sm" href="/oauth/slack/start">
        <Icon name="external" className="size-3.5" />
        Connect Slack
      </a>
      <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={createWebhook}>
        <Icon name="plus" className="size-3.5" />
        {busy ? 'Creating…' : 'New webhook'}
      </button>
    </>
  )

  return (
    <Page title="Connections" meta="Lines that bring events in. Every request is signature-checked before it is stored." actions={actions}>
      <FormError error={error} />
      {created ? (
        <SecretBox label="Webhook signing secret" value={created.secret} onDismiss={() => setCreated(null)}>
          <p className="flex min-w-0 flex-wrap items-center gap-2">
            <span>Webhook URL:</span>
            <CopyId value={created.url} label="webhook URL" />
          </p>
          <p className="mt-1">
            Sign each request: send <code>X-Relay-Timestamp</code> and <code>X-Relay-Signature</code>. See the README.
          </p>
        </SecretBox>
      ) : null}
      <Async
        state={state}
        skeleton={<SkeletonRows rows={4} />}
        empty={{
          when: (d) => d.items.length === 0,
          render: () => (
            <Empty title="No connections yet" action={actions}>
              Connect a Slack account with OAuth, or create a signed webhook for any service that can send HTTP POSTs.
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
                  <span className="jack-code">{jackCode(c.provider)}</span>
                  <span className="font-medium">{c.provider}</span>
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
                        await post(`/api/connections/${c.id}/revoke`)
                        state.reload()
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
