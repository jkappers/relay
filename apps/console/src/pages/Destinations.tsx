import { useState, type FormEvent } from 'react'
import { del, get, patch, post, type Destination } from '../api'
import { Async, Check, ConfirmButton, CopyId, Empty, Field, FormError, Page, SecretBox, SkeletonRows, splitList } from '../components'
import { Icon } from '../icons'
import { jackCode } from '../patch'
import { StatusMark } from '../trace'
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
    <form onSubmit={submit} aria-labelledby="dest-form-title" className="flex flex-col gap-4 border border-edge bg-raised p-4 shadow-panel sm:p-5">
      <h2 id="dest-form-title" className="font-bold">
        {editing ? `Edit ${editing.name}` : 'New destination'}
      </h2>
      <div className="grid gap-4 sm:grid-cols-2">
        {!editing ? (
          <Field label="Kind">
            {(p) => (
              <select {...p} className="input" value={f.kind} onChange={(e) => set('kind', e.target.value as 'http' | 'agent')}>
                <option value="http">HTTP (signed POST)</option>
                <option value="agent">Agent (Claude)</option>
              </select>
            )}
          </Field>
        ) : null}
        <Field label="Name">{(p) => <input {...p} className="input" required value={f.name} onChange={(e) => set('name', e.target.value)} />}</Field>
      </div>
      {f.kind === 'http' ? (
        <div className="grid gap-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
          <Field label="URL" hint="http or https">
            {(p) => <input {...p} className="input font-mono" required type="url" value={f.url} onChange={(e) => set('url', e.target.value)} />}
          </Field>
          <Field label="Max attempts">
            {(p) => <input {...p} className="input" type="number" min={1} max={50} value={f.maxAttempts} onChange={(e) => set('maxAttempts', e.target.value)} />}
          </Field>
          <Field label="Timeout (ms)">
            {(p) => <input {...p} className="input" type="number" min={100} max={120000} value={f.timeoutMs} onChange={(e) => set('timeoutMs', e.target.value)} />}
          </Field>
        </div>
      ) : (
        <>
          <Field label="System prompt" hint="Event text is untrusted. Relay adds a fixed preamble before this.">
            {(p) => <textarea {...p} className="input min-h-40 font-mono" required rows={8} maxLength={20000} value={f.systemPrompt} onChange={(e) => set('systemPrompt', e.target.value)} />}
          </Field>
          <div className="grid gap-4 sm:grid-cols-4">
            <Field label="Model">{(p) => <input {...p} className="input font-mono" value={f.model} onChange={(e) => set('model', e.target.value)} />}</Field>
            <Field label="Max turns">
              {(p) => <input {...p} className="input" type="number" min={1} max={50} value={f.maxTurns} onChange={(e) => set('maxTurns', e.target.value)} />}
            </Field>
            <Field label="Timeout (s)">
              {(p) => <input {...p} className="input" type="number" min={5} max={3600} value={f.timeoutSeconds} onChange={(e) => set('timeoutSeconds', e.target.value)} />}
            </Field>
            <Field label="Max Slack changes per run" hint="Replies, posts, reactions, updates.">
              {(p) => <input {...p} className="input" type="number" min={0} max={50} value={f.maxMutatingActions} onChange={(e) => set('maxMutatingActions', e.target.value)} />}
            </Field>
          </div>
          <p className="text-xs text-ink-2">Agents run with Relay&apos;s actions as their only tools: no shell, files, or web.</p>
        </>
      )}
      <Field label="Allowed actions" hint="Comma-separated, such as reply, react, thread.history. Empty means all.">
        {(p) => <input {...p} className="input font-mono" value={f.allowedActions} onChange={(e) => set('allowedActions', e.target.value)} />}
      </Field>
      {editing ? (
        <Check checked={f.enabled} onChange={(v) => set('enabled', v)}>
          Enabled
        </Check>
      ) : null}
      <FormError error={error} />
      <div className="flex flex-wrap gap-2 border-t border-rule pt-4">
        <button className="btn btn-primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
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

  const newButton = (
    <button type="button" className="btn btn-primary" onClick={() => setMode({ edit: null })}>
      <Icon name="plus" className="size-3.5" />
      New destination
    </button>
  )

  return (
    <Page title="Destinations" meta="Jacks that events are patched to: signed HTTP endpoints or a locked-down Claude agent." actions={newButton}>
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
      <Async
        state={state}
        skeleton={<SkeletonRows rows={3} height="h-20" />}
        empty={{
          when: (d) => d.items.length === 0,
          render: () => (
            <Empty title="No destinations yet" action={mode ? null : newButton}>
              A destination receives events from routes. Add a signed HTTP endpoint, or an agent that can reply in Slack.
            </Empty>
          ),
        }}
      >
        {(d) => (
          <ul aria-label="Destinations" className="divide-y divide-rule border-y border-rule">
            {d.items.map((x) => (
              <li key={x.id} className="flex flex-col gap-2 px-2 py-3">
                <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
                  <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="grid h-6 min-w-9 place-items-center border border-rule bg-raised px-1 font-mono text-[0.6875rem] tracking-wide text-ink-2 uppercase">
                      {jackCode(x.kind)}
                    </span>
                    <span className="min-w-0 truncate font-bold">{x.name}</span>
                    <StatusMark value={x.enabled ? 'enabled' : 'disabled'} />
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button type="button" className="btn btn-sm" onClick={() => setMode({ edit: x })}>
                      Edit
                    </button>
                    {x.kind === 'http' ? (
                      <ConfirmButton
                        small
                        label="Rotate secret"
                        question="The old secret stops working."
                        confirmLabel="Rotate"
                        onConfirm={async () => {
                          const r = await post<{ secret: string }>(`/api/destinations/${x.id}/rotate-secret`)
                          setSecret({ label: `New signing secret for ${x.name}`, value: r.secret })
                        }}
                      />
                    ) : null}
                    <ConfirmButton
                      small
                      danger
                      label="Delete"
                      confirmLabel="Delete destination"
                      onConfirm={async () => {
                        await del(`/api/destinations/${x.id}`)
                        state.reload()
                      }}
                    />
                  </div>
                </div>
                <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm sm:grid-cols-[max-content_minmax(0,1fr)_max-content_minmax(0,1fr)]">
                  <dt className="text-ink-2">ID</dt>
                  <dd className="min-w-0">
                    <CopyId value={x.id} label="destination ID" />
                  </dd>
                  {x.kind === 'http' ? (
                    <>
                      <dt className="text-ink-2">URL</dt>
                      <dd className="min-w-0 truncate font-mono text-xs leading-5" title={x.url ?? ''}>
                        {x.url}
                      </dd>
                      <dt className="text-ink-2">Retries</dt>
                      <dd>
                        {x.maxAttempts} attempts, {x.timeoutMs} ms timeout
                      </dd>
                    </>
                  ) : (
                    <>
                      <dt className="text-ink-2">Model</dt>
                      <dd className="font-mono text-xs leading-5">{x.config?.model}</dd>
                      <dt className="text-ink-2">Limits</dt>
                      <dd>
                        {x.config?.maxTurns} turns, {x.config?.timeoutSeconds}s, {x.config?.maxMutatingActions} changes
                      </dd>
                    </>
                  )}
                  <dt className="text-ink-2">Actions</dt>
                  <dd className="font-mono text-xs leading-5">{x.allowedActions?.join(', ') ?? 'all'}</dd>
                  <dt className="text-ink-2">Routes</dt>
                  <dd>{x.routeCount ?? 0}</dd>
                  {x.kind === 'agent' ? (
                    <>
                      <dt className="text-ink-2">Tools</dt>
                      <dd>Relay actions only</dd>
                    </>
                  ) : null}
                </dl>
                {x.kind === 'agent' && x.config?.systemPrompt ? (
                  <p className="line-clamp-2 max-w-[75ch] text-sm text-ink-2">
                    <span className="font-bold text-ink">Prompt: </span>
                    {x.config.systemPrompt}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Async>
    </Page>
  )
}
