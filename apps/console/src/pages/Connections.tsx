import { useState } from 'react'
import { get, post, type Connection, type WebhookCreated } from '../api'
import { Async, ConfirmButton, CopyId, Empty, FormError, Page, SecretBox, SkeletonRows, Time } from '../components'
import { errorText, useLoad } from '../hooks'
import { Icon } from '../icons'
import { jackCode } from '../patch'
import { StatusMark } from '../trace'

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
      <a className="btn" href="/oauth/slack/start">
        <Icon name="external" className="size-3.5" />
        Connect Slack
      </a>
      <button type="button" className="btn btn-primary" disabled={busy} onClick={createWebhook}>
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
        skeleton={<SkeletonRows rows={3} height="h-16" />}
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
          <ul aria-label="Connections" className="divide-y divide-rule border-y border-rule">
            {d.items.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-2 py-3">
                <div className="flex min-w-0 flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="grid h-6 min-w-9 place-items-center border border-rule bg-raised px-1 font-mono text-[0.6875rem] tracking-wide text-ink-2 uppercase">
                      {jackCode(c.provider)}
                    </span>
                    <span className="font-bold">{c.provider}</span>
                    <StatusMark value={c.status} />
                  </div>
                  <dl className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-ink-2">
                    <div className="flex min-w-0 items-center gap-1">
                      <dt>ID</dt>
                      <dd className="min-w-0">
                        <CopyId value={c.id} label="connection ID" />
                      </dd>
                    </div>
                    {c.teamId ? (
                      <div className="flex gap-1">
                        <dt>Team</dt>
                        <dd className="font-mono text-ink">{c.teamId}</dd>
                      </div>
                    ) : null}
                    {c.userId ? (
                      <div className="flex gap-1">
                        <dt>User</dt>
                        <dd className="font-mono text-ink">{c.userId}</dd>
                      </div>
                    ) : null}
                    <div className="flex gap-1">
                      <dt>Created</dt>
                      <dd className="text-ink">
                        <Time iso={c.createdAt} />
                      </dd>
                    </div>
                  </dl>
                </div>
                {c.status === 'active' ? (
                  <ConfirmButton
                    small
                    danger
                    quiet
                    label="Revoke"
                    question="Stop accepting events?"
                    confirmLabel="Revoke connection"
                    onConfirm={async () => {
                      await post(`/api/connections/${c.id}/revoke`)
                      state.reload()
                    }}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Async>
    </Page>
  )
}
