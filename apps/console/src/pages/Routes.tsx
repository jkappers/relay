import { useEffect, useState, type FormEvent } from 'react'
import { ApiError, del, get, post, put, type Connection, type Destination, type Route } from '../api'
import { Async, ConfirmButton, Field, FormError, Page, Status } from '../components'
import { errorText, useDebounced, useLoad } from '../hooks'

interface RouteForm {
  name: string
  eventType: string
  connectionId: string
  textContains: string
  textRegex: string
  includeSubtypes: boolean
  enabled: boolean
  destinationIds: string[]
}

const blank: RouteForm = {
  name: '',
  eventType: 'slack.message.*',
  connectionId: '',
  textContains: '',
  textRegex: '',
  includeSubtypes: false,
  enabled: true,
  destinationIds: [],
}

const toForm = (r: Route): RouteForm => ({
  name: r.name,
  eventType: r.eventType,
  connectionId: r.connectionId ?? '',
  textContains: r.textContains ?? '',
  textRegex: r.textRegex ?? '',
  includeSubtypes: r.includeSubtypes,
  enabled: r.enabled,
  destinationIds: r.destinationIds,
})

const matchFields = (f: RouteForm) => ({
  eventType: f.eventType,
  connectionId: f.connectionId || null,
  textContains: f.textContains || null,
  textRegex: f.textRegex || null,
  includeSubtypes: f.includeSubtypes,
  enabled: true,
})

interface PreviewResult {
  scanned: number
  matches: { id: string; receivedAt: string; type: string; subtype: string | null; text: string | null }[]
}

function Preview({ form }: { form: RouteForm }) {
  const fields = useDebounced(JSON.stringify(matchFields(form)), 400)
  const [result, setResult] = useState<PreviewResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    if (!form.eventType) {
      setResult(null)
      return
    }
    post<PreviewResult>('/api/routes/preview', JSON.parse(fields)).then(
      (r) => {
        if (!live) return
        setResult(r)
        setError(null)
      },
      (e: unknown) => {
        if (!live) return
        setResult(null)
        setError(e instanceof ApiError ? e.describe() : errorText(e))
      },
    )
    return () => {
      live = false
    }
  }, [fields, form.eventType])

  return (
    <div className="preview" aria-live="polite">
      <strong>Live preview</strong>
      {error ? <p className="notice error">{error}</p> : null}
      {result ? (
        <>
          <p className="muted">
            {result.matches.length} of the last {result.scanned} events would match.
          </p>
          <ul className="list tight">
            {result.matches.slice(0, 10).map((m) => (
              <li key={m.id}>
                <a href={`#/events/${m.id}`}>
                  <code>{m.type}</code>
                </a>{' '}
                <span className="clamp-inline">{m.text ?? ''}</span>
              </li>
            ))}
          </ul>
          {result.matches.length > 10 ? <p className="muted">and {result.matches.length - 10} more</p> : null}
        </>
      ) : null}
    </div>
  )
}

function RouteEditor({
  editing,
  connections,
  destinations,
  onDone,
}: {
  editing: Route | null
  connections: Connection[]
  destinations: Destination[]
  onDone: () => void
}) {
  const [f, setF] = useState<RouteForm>(editing ? toForm(editing) : blank)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const set = <K extends keyof RouteForm>(k: K, v: RouteForm[K]) => setF((p) => ({ ...p, [k]: v }))

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const body = { ...matchFields(f), enabled: f.enabled, name: f.name, destinationIds: f.destinationIds }
    try {
      if (editing) await put(`/api/routes/${editing.id}`, body)
      else await post('/api/routes', body)
      onDone()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="card stack">
      <h2>{editing ? `Edit ${editing.name}` : 'New route'}</h2>
      <Field label="Name">
        <input required value={f.name} onChange={(e) => set('name', e.target.value)} />
      </Field>
      <Field label="Event type" hint="Exact, or a prefix ending in *, such as slack.message.*">
        <input required value={f.eventType} onChange={(e) => set('eventType', e.target.value)} />
      </Field>
      <Field label="Connection">
        <select value={f.connectionId} onChange={(e) => set('connectionId', e.target.value)}>
          <option value="">Any connection</option>
          {connections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.provider} {c.userId ?? c.id.slice(0, 8)} ({c.status})
            </option>
          ))}
        </select>
      </Field>
      <Field label="Text contains" hint="Case-insensitive. Leave empty for any text.">
        <input value={f.textContains} onChange={(e) => set('textContains', e.target.value)} />
      </Field>
      <Field label="Text regex" hint="Max 200 characters, no flags.">
        <input value={f.textRegex} onChange={(e) => set('textRegex', e.target.value)} />
      </Field>
      <label className="check">
        <input type="checkbox" checked={f.includeSubtypes} onChange={(e) => set('includeSubtypes', e.target.checked)} /> Include message subtypes
      </label>
      <label className="check">
        <input type="checkbox" checked={f.enabled} onChange={(e) => set('enabled', e.target.checked)} /> Enabled
      </label>
      <fieldset>
        <legend>Destinations</legend>
        {destinations.length === 0 ? <p className="muted">Create a destination first.</p> : null}
        {destinations.map((d) => (
          <label key={d.id} className="check">
            <input
              type="checkbox"
              checked={f.destinationIds.includes(d.id)}
              onChange={(e) => set('destinationIds', e.target.checked ? [...f.destinationIds, d.id] : f.destinationIds.filter((x) => x !== d.id))}
            />{' '}
            {d.name} <span className="muted">({d.kind})</span>
          </label>
        ))}
      </fieldset>
      <Preview form={f} />
      <FormError error={error} />
      <div className="row">
        <button className="primary" disabled={busy || f.destinationIds.length === 0}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button type="button" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  )
}

export function Routes() {
  const state = useLoad(
    async () => {
      const [routes, destinations, connections] = await Promise.all([
        get<{ items: Route[] }>('/api/routes'),
        get<{ items: Destination[] }>('/api/destinations'),
        get<{ items: Connection[] }>('/api/connections'),
      ])
      return { routes: routes.items, destinations: destinations.items, connections: connections.items }
    },
    [],
  )
  const [editor, setEditor] = useState<{ edit: Route | null } | null>(null)

  return (
    <Page
      title="Routes"
      actions={
        <button className="primary" onClick={() => setEditor({ edit: null })}>
          New route
        </button>
      }
    >
      <Async state={state}>
        {(d) => (
          <>
            {editor ? (
              <RouteEditor
                key={editor.edit?.id ?? 'new'}
                editing={editor.edit}
                connections={d.connections}
                destinations={d.destinations}
                onDone={() => {
                  setEditor(null)
                  state.reload()
                }}
              />
            ) : null}
            {d.routes.length === 0 ? <p className="muted empty">No routes yet.</p> : null}
            <ul className="list">
              {d.routes.map((r) => (
                <li key={r.id} className="card stack">
                  <div className="row between">
                    <strong>{r.name}</strong>
                    <Status value={r.enabled ? 'active' : 'revoked'} />
                  </div>
                  <dl className="kv">
                    <dt>Type</dt>
                    <dd><code>{r.eventType}</code></dd>
                    {r.connectionId ? (<><dt>Connection</dt><dd><code>{r.connectionId.slice(0, 8)}</code></dd></>) : null}
                    {r.textContains ? (<><dt>Contains</dt><dd>{r.textContains}</dd></>) : null}
                    {r.textRegex ? (<><dt>Regex</dt><dd><code>{r.textRegex}</code></dd></>) : null}
                    {r.includeSubtypes ? (<><dt>Subtypes</dt><dd>included</dd></>) : null}
                    <dt>To</dt>
                    <dd>{r.destinationIds.map((id) => d.destinations.find((x) => x.id === id)?.name ?? id.slice(0, 8)).join(', ')}</dd>
                  </dl>
                  <div className="row wrap">
                    <button onClick={() => setEditor({ edit: r })}>Edit</button>
                    <button
                      onClick={async () => {
                        await post(`/api/routes/${r.id}/${r.enabled ? 'disable' : 'enable'}`)
                        state.reload()
                      }}
                    >
                      {r.enabled ? 'Disable' : 'Enable'}
                    </button>
                    <ConfirmButton
                      danger
                      label="Delete"
                      confirmLabel="Delete route"
                      onConfirm={async () => {
                        await del(`/api/routes/${r.id}`)
                        state.reload()
                      }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </Async>
    </Page>
  )
}
