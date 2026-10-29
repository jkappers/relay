import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { ApiError, del, get, post, put, type Connection, type Destination, type Route } from '../api'
import { Async, Check, ConfirmButton, Empty, Field, FormError, Page, SectionHead, SkeletonRows, Time } from '../components'
import { Icon } from '../icons'
import { lineLabel, Patch } from '../patch'
import { StatusMark } from '../trace'
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
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    if (!form.eventType) {
      setResult(null)
      return
    }
    setBusy(true)
    post<PreviewResult>('/api/routes/preview', JSON.parse(fields)).then(
      (r) => {
        if (!live) return
        setResult(r)
        setError(null)
        setBusy(false)
      },
      (e: unknown) => {
        if (!live) return
        setResult(null)
        setError(e instanceof ApiError ? e.describe() : errorText(e))
        setBusy(false)
      },
    )
    return () => {
      live = false
    }
  }, [fields, form.eventType])

  return (
    <section aria-labelledby="preview-title" className="flex min-w-0 flex-col gap-2">
      <SectionHead id="preview-title" title="Live preview">
        {busy ? <span>Checking…</span> : null}
      </SectionHead>
      <div aria-live="polite" className="min-w-0">
        {error ? <p className="text-sm text-bad-ink">{error}</p> : null}
        {!form.eventType ? <p className="text-sm text-ink-2">Enter an event type to see matches.</p> : null}
        {result ? (
          <>
            <p className="text-sm">
              <span className="font-bold">{result.matches.length}</span> of the last {result.scanned} events would match.
            </p>
            {result.matches.length > 0 ? (
              <ul aria-label="Matching events" className="mt-2 divide-y divide-rule border-y border-rule">
                {result.matches.slice(0, 10).map((m) => (
                  <li key={m.id} className="flex min-w-0 items-baseline gap-3 px-1 py-1.5 text-sm">
                    <a href={`#/events/${m.id}`} className="shrink-0 font-mono text-xs">
                      {m.type}
                    </a>
                    <span className="min-w-0 flex-1 truncate text-ink-2">{m.text ?? ''}</span>
                    <Time iso={m.receivedAt} className="shrink-0 text-xs text-ink-3" />
                  </li>
                ))}
              </ul>
            ) : null}
            {result.matches.length > 10 ? <p className="mt-1 text-xs text-ink-2">and {result.matches.length - 10} more</p> : null}
          </>
        ) : null}
      </div>
    </section>
  )
}

function RoutePatch({ route, connections, destinations, live }: { route: { connectionId: string | null; destinationIds: string[] }; connections: Connection[]; destinations: Destination[]; live: boolean }) {
  const connection = route.connectionId ? connections.find((c) => c.id === route.connectionId) : undefined
  return (
    <Patch
      label="Destinations"
      live={live}
      sourceCode={route.connectionId ? (connection?.provider ?? 'line') : 'any'}
      sourceLabel={route.connectionId ? lineLabel(connection, route.connectionId) : 'Any connection'}
      targets={route.destinationIds.map((id) => {
        const d = destinations.find((x) => x.id === id)
        return { key: id, code: d?.kind ?? 'dest', label: d?.name ?? id.slice(0, 8), note: d && !d.enabled ? 'disabled' : undefined }
      })}
    />
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
    <form onSubmit={submit} aria-labelledby="route-form-title" className="grid gap-6 border border-edge bg-raised p-4 shadow-panel sm:p-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col gap-4">
        <h2 id="route-form-title" className="font-bold">
          {editing ? `Edit ${editing.name}` : 'New route'}
        </h2>
        <Field label="Name">{(p) => <input {...p} className="input" required value={f.name} onChange={(e) => set('name', e.target.value)} />}</Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Event type" hint="Exact, or a prefix ending in *, such as slack.message.*">
            {(p) => <input {...p} className="input font-mono" required value={f.eventType} onChange={(e) => set('eventType', e.target.value)} />}
          </Field>
          <Field label="Connection">
            {(p) => (
              <select {...p} className="input" value={f.connectionId} onChange={(e) => set('connectionId', e.target.value)}>
                <option value="">Any connection</option>
                {connections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {lineLabel(c)} ({c.status})
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Text contains" hint="Case-insensitive. Leave empty for any text.">
            {(p) => <input {...p} className="input" value={f.textContains} onChange={(e) => set('textContains', e.target.value)} />}
          </Field>
          <Field label="Text regex" hint="Max 200 characters, no flags.">
            {(p) => <input {...p} className="input font-mono" value={f.textRegex} onChange={(e) => set('textRegex', e.target.value)} />}
          </Field>
        </div>
        <div className="flex flex-wrap gap-x-6">
          <Check checked={f.includeSubtypes} onChange={(v) => set('includeSubtypes', v)}>
            Include message subtypes
          </Check>
          <Check checked={f.enabled} onChange={(v) => set('enabled', v)}>
            Enabled
          </Check>
        </div>
        <fieldset className="flex min-w-0 flex-col gap-1">
          <legend className="label mb-1">Destinations</legend>
          {destinations.length === 0 ? (
            <p className="text-sm text-ink-2">
              Create a destination first. <a href="#/destinations">Go to destinations</a>
            </p>
          ) : null}
          {destinations.map((d) => (
            <Check
              key={d.id}
              checked={f.destinationIds.includes(d.id)}
              onChange={(v) => set('destinationIds', v ? [...f.destinationIds, d.id] : f.destinationIds.filter((x) => x !== d.id))}
            >
              {d.name} <span className="text-ink-2">({d.kind})</span>
            </Check>
          ))}
        </fieldset>
        <FormError error={error} />
        <div className="flex flex-wrap items-center gap-2 border-t border-rule pt-4">
          <button className="btn btn-primary" disabled={busy || f.destinationIds.length === 0}>
            {busy ? 'Saving…' : 'Save'}
          </button>
          <button type="button" className="btn" onClick={onDone}>
            Cancel
          </button>
          {f.destinationIds.length === 0 ? <span className="text-xs text-ink-2">Pick at least one destination.</span> : null}
        </div>
      </div>
      <div className="flex min-w-0 flex-col gap-6">
        <section aria-labelledby="patch-title" className="flex min-w-0 flex-col gap-3">
          <SectionHead id="patch-title" title="Patch" />
          <RoutePatch
            route={{ connectionId: f.connectionId || null, destinationIds: f.destinationIds }}
            connections={connections}
            destinations={destinations}
            live={f.enabled}
          />
        </section>
        <Preview form={f} />
      </div>
    </form>
  )
}

function Rule({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 gap-1.5">
      <dt className="text-ink-2">{term}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
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
  const [toggleError, setToggleError] = useState<string | null>(null)

  const newButton = (
    <button type="button" className="btn btn-primary" onClick={() => setEditor({ edit: null })}>
      <Icon name="plus" className="size-3.5" />
      New route
    </button>
  )

  return (
    <Page title="Routes" meta="Each route patches a line to one or more destinations. Only enabled routes carry calls." actions={newButton}>
      <FormError error={toggleError} />
      <Async state={state} skeleton={<SkeletonRows rows={3} height="h-28" />}>
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
            {d.routes.length === 0 ? (
              <Empty title="No routes yet" action={editor ? null : newButton}>
                A route matches events by type and text, then sends each match to its destinations. The live preview shows what it would catch before you save.
              </Empty>
            ) : (
              <ul aria-label="Routes" className="divide-y divide-rule border-y border-rule">
                {d.routes.map((r) => (
                  <li key={r.id} className="grid min-w-0 gap-x-8 gap-y-3 px-2 py-4 xl:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
                    <div className="flex min-w-0 flex-col gap-2">
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <h3 className="min-w-0 truncate font-bold">{r.name}</h3>
                        <StatusMark value={r.enabled ? 'enabled' : 'disabled'} />
                      </div>
                      <dl className="flex flex-col gap-0.5 text-sm">
                        <Rule term="Type">
                          <code>{r.eventType}</code>
                        </Rule>
                        {r.textContains ? <Rule term="Contains">{r.textContains}</Rule> : null}
                        {r.textRegex ? (
                          <Rule term="Regex">
                            <code>{r.textRegex}</code>
                          </Rule>
                        ) : null}
                        {r.includeSubtypes ? <Rule term="Subtypes">included</Rule> : null}
                      </dl>
                      <div className="flex flex-wrap gap-2 pt-1">
                        <button type="button" className="btn btn-sm" onClick={() => setEditor({ edit: r })}>
                          Edit
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={async () => {
                            setToggleError(null)
                            try {
                              await post(`/api/routes/${r.id}/${r.enabled ? 'disable' : 'enable'}`)
                              state.reload()
                            } catch (e) {
                              setToggleError(errorText(e))
                            }
                          }}
                        >
                          {r.enabled ? 'Disable' : 'Enable'}
                        </button>
                        <ConfirmButton
                          small
                          danger
                          label="Delete"
                          confirmLabel="Delete route"
                          onConfirm={async () => {
                            await del(`/api/routes/${r.id}`)
                            state.reload()
                          }}
                        />
                      </div>
                    </div>
                    <div className="min-w-0">
                      <RoutePatch route={r} connections={d.connections} destinations={d.destinations} live={r.enabled} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </Async>
    </Page>
  )
}
