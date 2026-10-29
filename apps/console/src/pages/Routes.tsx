import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { ApiError, currentTenant, del, get, post, put, type Connection, type Destination, type Route } from '../api'
import { Async, Check, ConfirmButton, Empty, Field, FormError, Page, SectionHead, SkeletonRows, Time } from '../components'
import { Icon } from '../icons'
import { lineLabel, Patch } from '../patch'
import { StatusMark } from '../trace'
import { errorText, hrefTo, useDebounced, useLoad } from '../hooks'

interface RouteForm {
  name: string
  eventType: string
  textContains: string
  textRegex: string
  includeSubtypes: boolean
  enabled: boolean
  destinationIds: string[]
}

const DEFAULT_EVENT_TYPES: Record<string, string> = { slack: 'slack.message.*', discord: 'discord.message.*', webhook: 'webhook.*' }
const defaultEventType = (provider: string | undefined) => DEFAULT_EVENT_TYPES[provider ?? ''] ?? 'slack.message.*'
const EVENT_HINTS: Record<string, string> = {
  slack: 'slack.message.*',
  discord: 'discord.message.* or discord.message.dm',
  webhook: 'webhook.*',
}

const blank: RouteForm = {
  name: '',
  eventType: 'slack.message.*',
  textContains: '',
  textRegex: '',
  includeSubtypes: false,
  enabled: true,
  destinationIds: [],
}

const toForm = (r: Route): RouteForm => ({
  name: r.name,
  eventType: r.eventType,
  textContains: r.textContains ?? '',
  textRegex: r.textRegex ?? '',
  includeSubtypes: r.includeSubtypes,
  enabled: r.enabled,
  destinationIds: r.destinationIds,
})

const matchFields = (f: RouteForm) => ({
  eventType: f.eventType,
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
    <section aria-labelledby="preview-title" className="flex min-w-0 flex-col gap-1.5">
      <SectionHead id="preview-title" title="Live preview">
        {busy ? <span>Checking…</span> : null}
      </SectionHead>
      <div aria-live="polite" className="min-w-0">
        {error ? <p className="text-bad-ink">{error}</p> : null}
        {!form.eventType ? <p className="text-ink-2">Enter an event type to see matches.</p> : null}
        {result ? (
          <>
            <p>
              <span className="font-semibold">{result.matches.length}</span> of the last {result.scanned} events would match.
            </p>
            {result.matches.length > 0 ? (
              <ul aria-label="Matching events" className="mt-1.5 divide-y divide-rule border-y border-rule">
                {result.matches.slice(0, 10).map((m) => (
                  <li key={m.id} className="flex h-7 min-w-0 items-center gap-3 px-1">
                    <a href={hrefTo(`/events/${m.id}`)} className="shrink-0 font-mono text-xs">
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

function RoutePatch({ route, connections, destinations, live }: { route: { connectionId: string; destinationIds: string[] }; connections: Connection[]; destinations: Destination[]; live: boolean }) {
  const connection = connections.find((c) => c.id === route.connectionId)
  return (
    <Patch
      label="Destinations"
      live={live}
      sourceCode={connection?.provider ?? 'line'}
      sourceLabel={lineLabel(connection, route.connectionId)}
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
  const provider = connections.find((c) => c.id === currentTenant())?.provider
  const [f, setF] = useState<RouteForm>(editing ? toForm(editing) : { ...blank, eventType: defaultEventType(provider) })
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
    <form onSubmit={submit} aria-labelledby="route-form-title" className="grid gap-5 rounded-ctl border border-line bg-raised p-4 shadow-panel lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col gap-3">
        <h2 id="route-form-title" className="font-semibold">
          {editing ? `Edit ${editing.name}` : 'New route'}
        </h2>
        <Field label="Name">{(p) => <input {...p} className="input" required value={f.name} onChange={(e) => set('name', e.target.value)} />}</Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Event type" hint={`Exact, or a prefix ending in *, such as ${EVENT_HINTS[provider ?? ''] ?? EVENT_HINTS.slack}`}>
            {(p) => <input {...p} className="input font-mono" required value={f.eventType} onChange={(e) => set('eventType', e.target.value)} />}
          </Field>
          <Field label="Text contains" hint="Case-insensitive. Leave empty for any text.">
            {(p) => <input {...p} className="input" value={f.textContains} onChange={(e) => set('textContains', e.target.value)} />}
          </Field>
          <Field label="Text regex" hint="Max 200 characters, no flags.">
            {(p) => <input {...p} className="input font-mono" value={f.textRegex} onChange={(e) => set('textRegex', e.target.value)} />}
          </Field>
        </div>
        <div className="flex flex-wrap gap-x-5">
          <Check checked={f.includeSubtypes} onChange={(v) => set('includeSubtypes', v)}>
            Include message subtypes
          </Check>
          <Check checked={f.enabled} onChange={(v) => set('enabled', v)}>
            Enabled
          </Check>
        </div>
        <fieldset className="flex min-w-0 flex-col">
          <legend className="label mb-0.5">Destinations</legend>
          {destinations.length === 0 ? (
            <p className="text-ink-2">
              Create a destination first. <a href={hrefTo('/destinations')}>Go to destinations</a>
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
        <div className="flex flex-wrap items-center gap-2 border-t border-rule pt-3">
          <button className="btn btn-primary" disabled={busy || f.destinationIds.length === 0}>
            {busy ? 'Saving…' : 'Save'}
          </button>
          <button type="button" className="btn" onClick={onDone}>
            Cancel
          </button>
          {f.destinationIds.length === 0 ? <span className="text-xs text-ink-3">Pick at least one destination.</span> : null}
        </div>
      </div>
      <div className="flex min-w-0 flex-col gap-5">
        <section aria-labelledby="patch-title" className="flex min-w-0 flex-col gap-1.5">
          <SectionHead id="patch-title" title="Patch" />
          <RoutePatch
            route={{ connectionId: editing?.connectionId ?? currentTenant() ?? '', destinationIds: f.destinationIds }}
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
    <div className="flex min-w-0 gap-1">
      <dt className="text-ink-3">{term}</dt>
      <dd className="min-w-0 truncate text-ink-2">{children}</dd>
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
    <button type="button" className="btn btn-primary btn-sm" onClick={() => setEditor({ edit: null })}>
      <Icon name="plus" className="size-3.5" />
      New route
    </button>
  )

  return (
    <Page title="Routes" meta="Each route patches a line to destinations. Only enabled routes carry calls." actions={newButton}>
      <FormError error={toggleError} />
      <Async state={state} skeleton={<SkeletonRows rows={4} height="h-14" />}>
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
              <ul aria-label="Routes" className="border-t border-rule">
                {d.routes.map((r) => (
                  <li key={r.id} className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-x-6 gap-y-2 border-b border-rule px-3 py-2 hover:bg-hover lg:grid-cols-[minmax(0,17rem)_minmax(0,1fr)_auto] lg:items-start">
                    <div className="flex min-w-0 flex-col">
                      <div className="flex min-h-6 items-center gap-2">
                        <h3 className="min-w-0 truncate font-medium">{r.name}</h3>
                        <span className="text-xs">
                          <StatusMark value={r.enabled ? 'enabled' : 'disabled'} />
                        </span>
                      </div>
                      <dl className="flex min-w-0 flex-wrap gap-x-3 text-xs">
                        <Rule term="type">
                          <code>{r.eventType}</code>
                        </Rule>
                        {r.textContains ? <Rule term="contains">{r.textContains}</Rule> : null}
                        {r.textRegex ? (
                          <Rule term="regex">
                            <code>{r.textRegex}</code>
                          </Rule>
                        ) : null}
                        {r.includeSubtypes ? <Rule term="subtypes">included</Rule> : null}
                      </dl>
                    </div>
                    <div className="min-w-0 max-w-[38rem] max-lg:col-span-2">
                      <RoutePatch route={r} connections={d.connections} destinations={d.destinations} live={r.enabled} />
                    </div>
                    <div role="group" aria-label={`${r.name} actions`} className="relative flex items-center gap-0.5 max-lg:col-start-2 max-lg:row-start-1 max-lg:self-start">
                      <button type="button" className="btn btn-sm btn-icon btn-quiet" aria-label={`Edit ${r.name}`} title="Edit" onClick={() => setEditor({ edit: r })}>
                        <Icon name="edit" className="size-3.5" />
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm btn-icon btn-quiet"
                        aria-label={`${r.enabled ? 'Disable' : 'Enable'} ${r.name}`}
                        title={r.enabled ? 'Disable' : 'Enable'}
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
                        <Icon name="power" className={r.enabled ? 'size-3.5 text-ok-ink' : 'size-3.5'} />
                      </button>
                      <ConfirmButton
                        small
                        danger
                        iconOnly
                        icon="trash"
                        label={`Delete ${r.name}`}
                        question="Delete route?"
                        confirmLabel="Delete"
                        onConfirm={async () => {
                          await del(`/api/routes/${r.id}`)
                          state.reload()
                        }}
                      />
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
