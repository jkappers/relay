import { useState, type FormEvent } from 'react'
import { CONNECTIONS_CHANGED_EVENT, get, post, type Connection, type WebhookCreated } from '../api'
import { Async, ConfirmButton, CopyId, cx, Empty, Field, FormError, Page, SecretBox, SkeletonRows, Time } from '../components'
import { errorText, useLoad } from '../hooks'
import { Icon } from '../icons'
import { jackCode, lineLabel } from '../patch'
import { StatusMark } from '../trace'

export const connectionsChanged = () => window.dispatchEvent(new Event(CONNECTIONS_CHANGED_EVENT))

export function NewWebhook({ onCreated, onCancel }: { onCreated: (c: WebhookCreated) => void; onCancel?: () => void }) {
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      onCreated(await post<WebhookCreated>('/api/connections/webhook', name.trim() ? { name: name.trim() } : {}))
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} aria-label="New webhook" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Webhook name" hint="Shown in the connection switcher." className="min-w-48 flex-1">
          {(p) => <input {...p} className="input" maxLength={100} placeholder="Deploys" value={name} onChange={(e) => setName(e.target.value)} />}
        </Field>
        <div className="flex gap-2 pb-5">
          <button className="btn btn-primary" disabled={busy}>
            <Icon name="plus" className="size-3.5" />
            {busy ? 'Creating…' : 'Create webhook'}
          </button>
          {onCancel ? (
            <button type="button" className="btn" onClick={onCancel}>
              Cancel
            </button>
          ) : null}
        </div>
      </div>
      <FormError error={error} />
    </form>
  )
}

export function WebhookSecret({ created, onDismiss }: { created: WebhookCreated; onDismiss: () => void }) {
  return (
    <SecretBox label="Webhook signing secret" value={created.secret} onDismiss={onDismiss}>
      <p className="flex min-w-0 flex-wrap items-center gap-2">
        <span>Webhook URL:</span>
        <CopyId value={created.url} label="webhook URL" />
      </p>
      <p className="mt-1">
        Sign each request: send <code>X-Relay-Timestamp</code> and <code>X-Relay-Signature</code>. See the README.
      </p>
    </SecretBox>
  )
}

const COLS = 'grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-0.5 px-3 md:grid-cols-[minmax(0,10rem)_6rem_minmax(0,9rem)_minmax(0,1fr)_6rem_minmax(0,auto)]'

export function Connections() {
  const state = useLoad(() => get<{ items: Connection[] }>('/api/connections'), [])
  const [created, setCreated] = useState<WebhookCreated | null>(null)
  const [adding, setAdding] = useState(false)

  const actions = (
    <>
      <a className="btn btn-sm" href="/oauth/slack/start">
        <Icon name="external" className="size-3.5" />
        Connect Slack
      </a>
      <button type="button" className="btn btn-primary btn-sm" disabled={adding} onClick={() => setAdding(true)}>
        <Icon name="plus" className="size-3.5" />
        New webhook
      </button>
    </>
  )

  return (
    <Page title="Connections" meta="Lines that bring events in. Each one keeps its own routes, destinations, and events." actions={actions}>
      {adding ? (
        <div className="rounded-ctl border border-line bg-raised p-4 shadow-panel">
          <NewWebhook
            onCancel={() => setAdding(false)}
            onCreated={(c) => {
              setAdding(false)
              setCreated(c)
              state.reload()
              connectionsChanged()
            }}
          />
        </div>
      ) : null}
      {created ? <WebhookSecret created={created} onDismiss={() => setCreated(null)} /> : null}
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
