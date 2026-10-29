import { useState } from 'react'
import { get, post, type Connection, type WebhookCreated } from '../api'
import { Async, ConfirmButton, FormError, fmtDate, Page, SecretBox, Status } from '../components'
import { errorText, useLoad } from '../hooks'

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

  return (
    <Page
      title="Connections"
      actions={
        <>
          <a className="button" href="/oauth/slack/start">
            Connect Slack
          </a>
          <button className="primary" disabled={busy} onClick={createWebhook}>
            New webhook
          </button>
        </>
      }
    >
      <FormError error={error} />
      {created ? (
        <div className="card stack">
          <p>
            Webhook URL: <code>{created.url}</code>
          </p>
          <p className="muted">
            Sign each request: send <code>X-Relay-Timestamp</code> and <code>X-Relay-Signature</code>. See the README.
          </p>
          <SecretBox label="Webhook signing secret" value={created.secret} onDismiss={() => setCreated(null)} />
        </div>
      ) : null}
      <Async state={state} empty={(d) => d.items.length === 0}>
        {(d) => (
          <ul className="list">
            {d.items.map((c) => (
              <li key={c.id} className="card">
                <div className="row between">
                  <strong>{c.provider}</strong>
                  <Status value={c.status} />
                </div>
                <dl className="kv">
                  <dt>ID</dt>
                  <dd><code>{c.id}</code></dd>
                  {c.teamId ? (<><dt>Team</dt><dd>{c.teamId}</dd></>) : null}
                  {c.userId ? (<><dt>User</dt><dd>{c.userId}</dd></>) : null}
                  <dt>Created</dt>
                  <dd>{fmtDate(c.createdAt)}</dd>
                </dl>
                {c.status === 'active' ? (
                  <ConfirmButton
                    danger
                    label="Revoke"
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
