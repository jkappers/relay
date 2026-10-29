import { useState, type FormEvent } from 'react'
import { del, get, patch, post, type Destination } from '../api'
import { Async, Check, ConfirmButton, CopyButton, cx, Empty, Field, FormError, Page, SecretBox, SkeletonRows, splitList } from '../components'
import { Icon } from '../icons'
import { jackCode } from '../patch'
import { plural, StatusMark } from '../trace'
import { errorText, useLoad } from '../hooks'

type Kind = Destination['kind']

const PARAMS_EXAMPLE = JSON.stringify({ type: 'object', properties: { query: { type: 'string', maxLength: 200 } }, required: ['query'] }, null, 2)

interface FormState {
  kind: Kind
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
  toolDestinationIds: string[]
  toolName: string
  description: string
  params: string
  mutating: boolean
  sensitive: boolean
  maxResponseBytes: string
}

const blank: FormState = {
  kind: 'http',
  name: '',
  enabled: true,
  url: '',
  maxAttempts: '8',
  timeoutMs: '10',
  allowedActions: '',
  systemPrompt: '',
  model: 'claude-sonnet-5-5',
  maxTurns: '8',
  timeoutSeconds: '300',
  maxMutatingActions: '3',
  toolDestinationIds: [],
  toolName: '',
  description: '',
  params: PARAMS_EXAMPLE,
  mutating: true,
  sensitive: false,
  maxResponseBytes: '32768',
}

const fromDestination = (d: Destination): FormState => ({
  ...blank,
  kind: d.kind,
  name: d.name,
  enabled: d.enabled,
  url: d.url ?? '',
  maxAttempts: String(d.maxAttempts),
  timeoutMs: String(d.timeoutMs / 1000),
  allowedActions: d.allowedActions?.join(', ') ?? '',
  ...(d.kind === 'agent'
    ? {
        systemPrompt: d.config.systemPrompt,
        model: d.config.model,
        maxTurns: String(d.config.maxTurns),
        timeoutSeconds: String(d.config.timeoutSeconds),
        maxMutatingActions: String(d.config.maxMutatingActions),
        toolDestinationIds: d.config.toolDestinationIds ?? [],
      }
    : {}),
  ...(d.kind === 'tool'
    ? {
        toolName: d.config.toolName,
        description: d.config.description,
        params: JSON.stringify(d.config.params, null, 2),
        mutating: d.config.mutating,
        sensitive: d.config.sensitive,
        maxResponseBytes: String(d.config.maxResponseBytes),
      }
    : {}),
})

function parseParams(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('Params must be valid JSON.')
  }
}

function DestinationForm({
  initial,
  editing,
  tools,
  onSaved,
  onCancel,
}: {
  initial: FormState
  editing: Destination | null
  tools: Extract<Destination, { kind: 'tool' }>[]
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
      toolDestinationIds: f.toolDestinationIds,
    }
    try {
      const toolFields = () => ({
        url: f.url,
        timeoutMs: Math.round(Number(f.timeoutMs) * 1000),
        toolName: f.toolName,
        description: f.description,
        params: parseParams(f.params),
        mutating: f.mutating,
        sensitive: f.sensitive,
        maxResponseBytes: Number(f.maxResponseBytes),
      })
      if (editing) {
        await patch(
          `/api/destinations/${editing.id}`,
          editing.kind === 'http'
            ? { name: f.name, enabled: f.enabled, url: f.url, maxAttempts: Number(f.maxAttempts), timeoutMs: Math.round(Number(f.timeoutMs) * 1000), allowedActions: splitList(f.allowedActions) }
            : editing.kind === 'tool'
              ? { name: f.name, enabled: f.enabled, ...toolFields() }
              : { name: f.name, enabled: f.enabled, allowedActions: splitList(f.allowedActions), config: agentConfig },
        )
        onSaved()
      } else if (f.kind === 'tool') {
        const res = await post<{ secret: string }>('/api/destinations', { kind: 'tool', name: f.name, ...toolFields() })
        onSaved(res.secret)
      } else if (f.kind === 'http') {
        const res = await post<{ secret: string }>('/api/destinations', {
          kind: 'http',
          name: f.name,
          url: f.url,
          maxAttempts: Number(f.maxAttempts),
          timeoutMs: Math.round(Number(f.timeoutMs) * 1000),
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
    <form onSubmit={submit} aria-labelledby="dest-form-title" className="flex flex-col gap-3 rounded-ctl border border-line bg-raised p-4 shadow-panel">
      <h2 id="dest-form-title" className="font-semibold">
        {editing ? `Edit ${editing.name}` : 'New destination'}
      </h2>
      <div className="grid gap-3 sm:grid-cols-2">
        {!editing ? (
          <Field label="Kind">
            {(p) => (
              <select {...p} className="input" value={f.kind} onChange={(e) => set('kind', e.target.value as Kind)}>
                <option value="http">HTTP (signed POST)</option>
                <option value="agent">Agent (Claude)</option>
                <option value="tool">Tool (endpoint an agent can call)</option>
              </select>
            )}
          </Field>
        ) : null}
        <Field label="Name">{(p) => <input {...p} className="input" required value={f.name} onChange={(e) => set('name', e.target.value)} />}</Field>
      </div>
      {f.kind === 'tool' ? (
        <>
          <div className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
            <Field label="URL" hint="http or https. The agent can never change it.">
              {(p) => <input {...p} className="input font-mono" required type="url" value={f.url} onChange={(e) => set('url', e.target.value)} />}
            </Field>
            <Field label="Timeout (s)" hint="Max 30">
              {(p) => <input {...p} className="input" type="number" min={0.1} max={30} step={0.1} value={f.timeoutMs} onChange={(e) => set('timeoutMs', e.target.value)} />}
            </Field>
            <Field label="Max response (bytes)">
              {(p) => <input {...p} className="input" type="number" min={1024} max={262144} value={f.maxResponseBytes} onChange={(e) => set('maxResponseBytes', e.target.value)} />}
            </Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
            <Field label="Tool name" hint="lowercase_slug. Relay action names are reserved.">
              {(p) => <input {...p} className="input font-mono" required pattern="[a-z][a-z0-9_]{0,47}" value={f.toolName} onChange={(e) => set('toolName', e.target.value)} />}
            </Field>
            <Field label="Description" hint="What the agent is told the tool does.">
              {(p) => <input {...p} className="input" required maxLength={1000} value={f.description} onChange={(e) => set('description', e.target.value)} />}
            </Field>
          </div>
          <Field label="Params (JSON Schema)" hint="An object of string, number, integer, boolean, or arrays of those. Max 20 params. Anything else is rejected.">
            {(p) => <textarea {...p} className="input min-h-28 font-mono text-xs" required rows={6} value={f.params} onChange={(e) => set('params', e.target.value)} />}
          </Field>
          <div className="flex flex-wrap gap-x-6">
            <Check checked={f.mutating} onChange={(v) => set('mutating', v)}>
              Makes changes <span className="text-ink-2">(counts toward the agent&apos;s change limit)</span>
            </Check>
            <Check checked={f.sensitive} onChange={(v) => set('sensitive', v)}>
              Sensitive <span className="text-ink-2">(only when the route&apos;s actor list holds the sender)</span>
            </Check>
          </div>
          <p className="text-xs text-ink-3">Model args go only in the signed JSON body. Treat them as attacker-controlled: verify the signature and validate args at the endpoint.</p>
        </>
      ) : f.kind === 'http' ? (
        <div className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
          <Field label="URL" hint="http or https">
            {(p) => <input {...p} className="input font-mono" required type="url" value={f.url} onChange={(e) => set('url', e.target.value)} />}
          </Field>
          <Field label="Max attempts">
            {(p) => <input {...p} className="input" type="number" min={1} max={50} value={f.maxAttempts} onChange={(e) => set('maxAttempts', e.target.value)} />}
          </Field>
          <Field label="Timeout (s)">
            {(p) => <input {...p} className="input" type="number" min={0.1} max={120} step={0.1} value={f.timeoutMs} onChange={(e) => set('timeoutMs', e.target.value)} />}
          </Field>
        </div>
      ) : (
        <>
          <Field label="System prompt" hint="Event text is untrusted. Relay adds a fixed preamble before this.">
            {(p) => <textarea {...p} className="input min-h-36 font-mono text-xs" required rows={8} maxLength={20000} value={f.systemPrompt} onChange={(e) => set('systemPrompt', e.target.value)} />}
          </Field>
          <div className="grid gap-3 sm:grid-cols-4">
            <Field label="Model">{(p) => <input {...p} className="input font-mono" value={f.model} onChange={(e) => set('model', e.target.value)} />}</Field>
            <Field label="Max turns">
              {(p) => <input {...p} className="input" type="number" min={1} max={50} value={f.maxTurns} onChange={(e) => set('maxTurns', e.target.value)} />}
            </Field>
            <Field label="Timeout (s)">
              {(p) => <input {...p} className="input" type="number" min={5} max={3600} value={f.timeoutSeconds} onChange={(e) => set('timeoutSeconds', e.target.value)} />}
            </Field>
            <Field label="Max changes per run" hint="Replies, posts, reactions, updates in Slack or Discord, plus calls to tools that make changes.">
              {(p) => <input {...p} className="input" type="number" min={0} max={50} value={f.maxMutatingActions} onChange={(e) => set('maxMutatingActions', e.target.value)} />}
            </Field>
          </div>
          <fieldset className="flex flex-col gap-0.5">
            <legend className="label mb-0.5">Tools</legend>
            {tools.length === 0 ? <p className="text-xs text-ink-2">No tool destinations in this connection yet.</p> : null}
            {tools.map((t) => (
              <Check
                key={t.id}
                checked={f.toolDestinationIds.includes(t.id)}
                onChange={(v) => set('toolDestinationIds', v ? [...f.toolDestinationIds, t.id] : f.toolDestinationIds.filter((x) => x !== t.id))}
              >
                <span className="font-mono">{t.config.toolName}</span>{' '}
                <span className="text-ink-2">
                  ({t.name}
                  {t.config.mutating ? ', changes' : ', read only'}
                  {t.config.sensitive ? ', sensitive' : ''}
                  {t.enabled ? '' : ', disabled'})
                </span>
              </Check>
            ))}
          </fieldset>
          <p className="text-xs text-ink-3">Agents run with Relay&apos;s actions and the tools picked above as their only tools: no shell, files, or web.</p>
        </>
      )}
      {f.kind !== 'tool' ? (
        <Field label="Allowed actions" hint="Comma-separated, such as reply, react, thread.history. Empty means all.">
          {(p) => <input {...p} className="input font-mono" value={f.allowedActions} onChange={(e) => set('allowedActions', e.target.value)} />}
        </Field>
      ) : null}
      {editing ? (
        <Check checked={f.enabled} onChange={(v) => set('enabled', v)}>
          Enabled
        </Check>
      ) : null}
      <FormError error={error} />
      <div className="flex flex-wrap gap-2 border-t border-rule pt-3">
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

const COLS = 'grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-0.5 px-3 md:grid-cols-[minmax(0,13rem)_5.5rem_minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,0.8fr)_3.5rem_5.5rem]'

export function Destinations() {
  const state = useLoad(() => get<{ items: Destination[] }>('/api/destinations'), [])
  const [mode, setMode] = useState<{ edit: Destination | null } | null>(null)
  const [secret, setSecret] = useState<{ label: string; value: string } | null>(null)

  const newButton = (
    <button type="button" className="btn btn-primary btn-sm" onClick={() => setMode({ edit: null })}>
      <Icon name="plus" className="size-3.5" />
      New destination
    </button>
  )

  return (
    <Page title="Destinations" meta="Jacks that events are patched to: signed HTTP endpoints or a locked-down Claude agent, plus tools agents can call." actions={newButton}>
      {secret ? <SecretBox label={secret.label} value={secret.value} onDismiss={() => setSecret(null)} /> : null}
      {mode ? (
        <DestinationForm
          key={mode.edit?.id ?? 'new'}
          initial={mode.edit ? fromDestination(mode.edit) : blank}
          editing={mode.edit}
          tools={(state.data?.items ?? []).filter((x): x is Extract<Destination, { kind: 'tool' }> => x.kind === 'tool')}
          onCancel={() => setMode(null)}
          onSaved={(s) => {
            if (s) setSecret({ label: 'Signing secret', value: s })
            setMode(null)
            state.reload()
          }}
        />
      ) : null}
      <Async
        state={state}
        skeleton={<SkeletonRows rows={4} />}
        empty={{
          when: (d) => d.items.length === 0,
          render: () => (
            <Empty title="No destinations yet" action={mode ? null : newButton}>
              A destination receives events from routes. Add a signed HTTP endpoint, or an agent that can reply in Slack or Discord. Tools are HTTP endpoints an agent can call.
            </Empty>
          ),
        }}
      >
        {(d) => (
          <div role="table" aria-label="Destinations" className="min-w-0 border-t border-rule md:border-t-0">
            <div role="row" className={cx('th hidden md:grid', COLS)}>
              <span role="columnheader">Name</span>
              <span role="columnheader">Status</span>
              <span role="columnheader">Target</span>
              <span role="columnheader">Limits</span>
              <span role="columnheader">Actions and tools</span>
              <span role="columnheader" className="text-right">
                Routes
              </span>
              <span role="columnheader">
                <span className="sr-only">Controls</span>
              </span>
            </div>
            {d.items.map((x) => (
              <div role="row" key={x.id} className={cx('tr py-1 md:py-0', COLS)}>
                <span role="cell" className="flex min-w-0 items-center gap-2">
                  <span className="jack-code">{jackCode(x.kind)}</span>
                  <span className="min-w-0 truncate font-medium">{x.name}</span>
                  <CopyButton value={x.id} label={`Copy ${x.name} ID`} />
                </span>
                <span role="cell" className="text-xs">
                  <StatusMark value={x.enabled ? 'enabled' : 'disabled'} />
                </span>
                <span role="cell" title={x.kind === 'agent' ? x.config.systemPrompt : (x.url ?? '')} className="min-w-0 truncate font-mono text-xs text-ink-2">
                  {x.kind === 'agent' ? x.config.model : x.url}
                </span>
                <span role="cell" className="min-w-0 truncate text-xs text-ink-2">
                  {x.kind === 'http'
                    ? `${plural(x.maxAttempts, 'try', 'tries')} · ${x.timeoutMs / 1000}s`
                    : x.kind === 'tool'
                      ? `${x.timeoutMs / 1000}s · ${x.config.mutating ? 'changes' : 'read only'}${x.config.sensitive ? ' · sensitive' : ''}`
                      : `${plural(x.config.maxTurns, 'turn', 'turns')} · ${x.config.timeoutSeconds}s · ${plural(x.config.maxMutatingActions, 'change', 'changes')}`}
                </span>
                <span role="cell" title={x.kind === 'tool' ? x.config.description : undefined} className="min-w-0 truncate font-mono text-xs text-ink-2">
                  {x.kind === 'tool'
                    ? `tool ${x.config.toolName}`
                    : `${x.allowedActions?.join(', ') ?? 'all'}${x.kind === 'agent' && x.config.toolDestinationIds?.length ? ` + ${plural(x.config.toolDestinationIds.length, 'tool', 'tools')}` : ''}`}
                </span>
                <span role="cell" className="text-xs text-ink-2 md:text-right">
                  {x.routeCount ?? 0}
                  <span className="md:sr-only"> routes</span>
                </span>
                <span role="cell" className="relative flex items-center justify-end gap-0.5">
                  <button type="button" className="btn btn-sm btn-icon btn-quiet" aria-label={`Edit ${x.name}`} title="Edit" onClick={() => setMode({ edit: x })}>
                    <Icon name="edit" className="size-3.5" />
                  </button>
                  {x.kind !== 'agent' ? (
                    <ConfirmButton
                      small
                      iconOnly
                      icon="refresh"
                      label={`Rotate ${x.name} secret`}
                      question="Old secret stops working."
                      confirmLabel="Rotate"
                      onConfirm={async () => {
                        const r = await post<{ secret: string }>(`/api/destinations/${x.id}/rotate-secret`)
                        setSecret({ label: `New signing secret for ${x.name}`, value: r.secret })
                      }}
                    />
                  ) : (
                    <span className="w-6" />
                  )}
                  <ConfirmButton
                    small
                    danger
                    iconOnly
                    icon="trash"
                    label={`Delete ${x.name}`}
                    question="Delete destination?"
                    confirmLabel="Delete"
                    onConfirm={async () => {
                      await del(`/api/destinations/${x.id}`)
                      state.reload()
                    }}
                  />
                </span>
              </div>
            ))}
          </div>

        )}
      </Async>
    </Page>
  )
}
