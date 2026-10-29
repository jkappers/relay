import { useState, type FormEvent } from 'react'
import { del, get, patch, post, type Destination } from '../api'
import { Async, ConfirmButton, Field, FormError, Page, SecretBox, Status, splitList } from '../components'
import { errorText, useLoad } from '../hooks'

interface FormState {
  kind: 'http' | 'agent'
  name: string
  enabled: boolean
  url: string
  maxAttempts: string
  timeoutMs: string
  allowedActions: string
  systemPrompt: string
  model: string
  maxTurns: string
  timeoutSeconds: string
  maxMutatingActions: string
}

const blank: FormState = {
  kind: 'http',
  name: '',
  enabled: true,
  url: '',
  maxAttempts: '8',
  timeoutMs: '10000',
  allowedActions: '',
  systemPrompt: '',
  model: 'claude-sonnet-5-5',
  maxTurns: '8',
  timeoutSeconds: '300',
  maxMutatingActions: '3',
}

const fromDestination = (d: Destination): FormState => ({
  ...blank,
  kind: d.kind,
  name: d.name,
  enabled: d.enabled,
  url: d.url ?? '',
  maxAttempts: String(d.maxAttempts),
  timeoutMs: String(d.timeoutMs),
  allowedActions: d.allowedActions?.join(', ') ?? '',
  ...(d.config
    ? {
        systemPrompt: d.config.systemPrompt,
        model: d.config.model,
        maxTurns: String(d.config.maxTurns),
        timeoutSeconds: String(d.config.timeoutSeconds),
        maxMutatingActions: String(d.config.maxMutatingActions),
      }
    : {}),
})

function DestinationForm({
  initial,
  editing,
  onSaved,
  onCancel,
}: {
  initial: FormState
  editing: Destination | null
  onSaved: (secret?: string) => void
  onCancel: () => void
}) {
  const [f, setF] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((p) => ({ ...p, [k]: v }))

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const agentConfig = {
      systemPrompt: f.systemPrompt,
      model: f.model,
      maxTurns: Number(f.maxTurns),
      timeoutSeconds: Number(f.timeoutSeconds),
      maxMutatingActions: Number(f.maxMutatingActions),
    }
    try {
      if (editing) {
        await patch(
          `/api/destinations/${editing.id}`,
          editing.kind === 'http'
            ? { name: f.name, enabled: f.enabled, url: f.url, maxAttempts: Number(f.maxAttempts), timeoutMs: Number(f.timeoutMs), allowedActions: splitList(f.allowedActions) }
            : { name: f.name, enabled: f.enabled, allowedActions: splitList(f.allowedActions), config: agentConfig },
        )
        onSaved()
      } else if (f.kind === 'http') {
        const res = await post<{ secret: string }>('/api/destinations', {
          kind: 'http',
          name: f.name,
          url: f.url,
          maxAttempts: Number(f.maxAttempts),
          timeoutMs: Number(f.timeoutMs),
          allowedActions: splitList(f.allowedActions),
        })
        onSaved(res.secret)
      } else {
        await post('/api/destinations', { kind: 'agent', name: f.name, allowedActions: splitList(f.allowedActions), config: agentConfig })
        onSaved()
      }
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="card stack">
      <h2>{editing ? `Edit ${editing.name}` : 'New destination'}</h2>
      {!editing ? (
        <Field label="Kind">
          <select value={f.kind} onChange={(e) => set('kind', e.target.value as 'http' | 'agent')}>
            <option value="http">HTTP (signed POST)</option>
            <option value="agent">Agent (Claude)</option>
          </select>
        </Field>
      ) : null}
      <Field label="Name">
        <input required value={f.name} onChange={(e) => set('name', e.target.value)} />
      </Field>
      {f.kind === 'http' ? (
        <>
          <Field label="URL" hint="http or https">
            <input required type="url" value={f.url} onChange={(e) => set('url', e.target.value)} />
          </Field>
          <div className="two">
            <Field label="Max attempts">
              <input type="number" min={1} max={50} value={f.maxAttempts} onChange={(e) => set('maxAttempts', e.target.value)} />
            </Field>
            <Field label="Timeout (ms)">
              <input type="number" min={100} max={120000} value={f.timeoutMs} onChange={(e) => set('timeoutMs', e.target.value)} />
            </Field>
          </div>
        </>
      ) : (
        <>
          <Field label="System prompt" hint="Event text is untrusted. Relay adds a fixed preamble before this.">
            <textarea required rows={8} maxLength={20000} value={f.systemPrompt} onChange={(e) => set('systemPrompt', e.target.value)} />
          </Field>
          <Field label="Model">
            <input value={f.model} onChange={(e) => set('model', e.target.value)} />
          </Field>
          <div className="two">
            <Field label="Max turns">
              <input type="number" min={1} max={50} value={f.maxTurns} onChange={(e) => set('maxTurns', e.target.value)} />
            </Field>
            <Field label="Timeout (s)">
              <input type="number" min={5} max={3600} value={f.timeoutSeconds} onChange={(e) => set('timeoutSeconds', e.target.value)} />
            </Field>
          </div>
          <Field label="Max Slack changes per run" hint="Replies, posts, reactions, updates.">
            <input type="number" min={0} max={50} value={f.maxMutatingActions} onChange={(e) => set('maxMutatingActions', e.target.value)} />
          </Field>
        </>
      )}
      <Field label="Allowed actions" hint="Comma-separated, such as reply, react, thread.history. Empty means all.">
        <input value={f.allowedActions} onChange={(e) => set('allowedActions', e.target.value)} />
      </Field>
      {editing ? (
        <label className="check">
          <input type="checkbox" checked={f.enabled} onChange={(e) => set('enabled', e.target.checked)} /> Enabled
        </label>
      ) : null}
      <FormError error={error} />
      <div className="row">
        <button className="primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}

export function Destinations() {
  const state = useLoad(() => get<{ items: Destination[] }>('/api/destinations'), [])
  const [mode, setMode] = useState<{ edit: Destination | null } | null>(null)
  const [secret, setSecret] = useState<{ label: string; value: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  return (
    <Page
      title="Destinations"
      actions={
        <button className="primary" onClick={() => setMode({ edit: null })}>
          New destination
        </button>
      }
    >
      {secret ? <SecretBox label={secret.label} value={secret.value} onDismiss={() => setSecret(null)} /> : null}
      {mode ? (
        <DestinationForm
          key={mode.edit?.id ?? 'new'}
          initial={mode.edit ? fromDestination(mode.edit) : blank}
          editing={mode.edit}
          onCancel={() => setMode(null)}
          onSaved={(s) => {
            if (s) setSecret({ label: 'HTTP signing secret', value: s })
            setMode(null)
            state.reload()
          }}
        />
      ) : null}
      <FormError error={error} />
      <Async state={state} empty={(d) => d.items.length === 0}>
        {(d) => (
          <ul className="list">
            {d.items.map((x) => (
              <li key={x.id} className="card stack">
                <div className="row between">
                  <strong>{x.name}</strong>
                  <span className="row">
                    <Status value={x.kind} />
                    <Status value={x.enabled ? 'active' : 'revoked'} />
                  </span>
                </div>
                <dl className="kv">
                  <dt>ID</dt>
                  <dd><code>{x.id}</code></dd>
                  {x.kind === 'http' ? (
                    <>
                      <dt>URL</dt>
                      <dd>{x.url}</dd>
                      <dt>Retries</dt>
                      <dd>{x.maxAttempts} attempts, {x.timeoutMs} ms timeout</dd>
                    </>
                  ) : (
                    <>
                      <dt>Model</dt>
                      <dd>{x.config?.model}</dd>
                      <dt>Limits</dt>
                      <dd>{x.config?.maxTurns} turns, {x.config?.timeoutSeconds}s, {x.config?.maxMutatingActions} changes</dd>
                      <dt>Prompt</dt>
                      <dd className="clamp">{x.config?.systemPrompt}</dd>
                    </>
                  )}
                  <dt>Actions</dt>
                  <dd>{x.allowedActions?.join(', ') ?? 'all'}</dd>
                  <dt>Routes</dt>
                  <dd>{x.routeCount ?? 0}</dd>
                </dl>
                <div className="row wrap">
                  <button onClick={() => setMode({ edit: x })}>Edit</button>
                  {x.kind === 'http' ? (
                    <ConfirmButton
                      label="Rotate secret"
                      confirmLabel="Rotate"
                      onConfirm={async () => {
                        const r = await post<{ secret: string }>(`/api/destinations/${x.id}/rotate-secret`)
                        setSecret({ label: `New signing secret for ${x.name}`, value: r.secret })
                      }}
                    />
                  ) : null}
                  <ConfirmButton
                    danger
                    label="Delete"
                    confirmLabel="Delete destination"
                    onConfirm={async () => {
                      setError(null)
                      await del(`/api/destinations/${x.id}`)
                      state.reload()
                    }}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Async>
    </Page>
  )
}
