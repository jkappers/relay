import { useEffect, useState, type FormEvent } from 'react'
import { CONNECTIONS_CHANGED_EVENT, get, post, type Connection, type InstallUrls, type SmsCreated, type WebhookCreated } from '../api'
import { Async, ConfirmButton, CopyId, cx, Empty, Field, FormError, Page, SecretBox, SkeletonRows, Time } from '../components'
import { errorText, useLoad } from '../hooks'
import { PROVIDER_NAME, setupHint, type ProviderId } from '../integrations'
import { Icon } from '../icons'
import { jackCode, lineLabel } from '../patch'
import { StatusMark } from '../trace'

export const connectionsChanged = () => window.dispatchEvent(new Event(CONNECTIONS_CHANGED_EVENT))

export const INSTALLS = [
  { id: 'slack', label: 'Connect Slack' },
  { id: 'discord', label: 'Add Discord server' },
] as const

export interface Viewer {
  isAdmin: boolean
  adminExists: boolean
}

/** OAuth installs the server has app settings for. Null until loaded or if the call fails. Reloads when settings or connections change. */
export function useInstalls(): InstallUrls | null {
  const state = useLoad(() => get<InstallUrls>('/api/connections/providers'), [])
  const { reload } = state
  useEffect(() => {
    window.addEventListener(CONNECTIONS_CHANGED_EVENT, reload)
    return () => window.removeEventListener(CONNECTIONS_CHANGED_EVENT, reload)
  }, [reload])
  return state.data
}

export function InstallLinks({ installs, small }: { installs: InstallUrls | null; small?: boolean }) {
  return (
    <>
      {INSTALLS.map((i) =>
        installs?.[i.id] ? (
          <a key={i.id} className={cx('btn', small && 'btn-sm')} href={`/oauth/${i.id}/start`}>
            <Icon name="external" className="size-3.5" />
            {i.label}
          </a>
        ) : null,
      )}
    </>
  )
}

export function SetupHint({ provider, viewer }: { provider: ProviderId; viewer: Viewer }) {
  const name = PROVIDER_NAME[provider]
  const hint = setupHint(viewer)
  if (hint === 'set_up') {
    return (
      <a className="btn" href="#/settings">
        <Icon name="settings" className="size-3.5" />
        Set up {name}
      </a>
    )
  }
  return (
    <p className="text-xs text-ink-3">
      {hint === 'ask_admin' ? (
        <>Ask your admin to set up {name}.</>
      ) : (
        <>
          No one can set up {name} yet. Ask the person who installed Relay to run <code>users:grant-admin</code>.
        </>
      )}
    </p>
  )
}

/** Providers that are not set up, each with what this viewer can do about it. */
export function SetupHints({ installs, viewer }: { installs: InstallUrls | null; viewer: Viewer }) {
  if (!installs) return null
  const missing = INSTALLS.filter((i) => !installs[i.id])
  if (missing.length === 0) return null
  return (
    <ul aria-label="Not set up yet" className="flex flex-col divide-y divide-rule border-y border-rule">
      {missing.map((i) => (
        <li key={i.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-3 py-2">
          <span className="text-ink-2">{PROVIDER_NAME[i.id]} isn’t set up yet.</span>
          <SetupHint provider={i.id} viewer={viewer} />
        </li>
      ))}
    </ul>
  )
}

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

export function NewSms({ onCreated, onCancel }: { onCreated: (c: SmsCreated) => void; onCancel?: () => void }) {
  const [name, setName] = useState('')
  const [accountSid, setAccountSid] = useState('')
  const [number, setNumber] = useState('')
  const [authToken, setAuthToken] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      onCreated(
        await post<SmsCreated>('/api/connections/sms', {
          ...(name.trim() ? { name: name.trim() } : {}),
          accountSid: accountSid.trim(),
          number: number.trim(),
          authToken: authToken.trim(),
        }),
      )
      setAuthToken('')
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} aria-label="New SMS connection" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Name" hint="Optional. Shown in the connection switcher." className="min-w-48 flex-1">
          {(p) => <input {...p} className="input" maxLength={100} placeholder="Support line" value={name} onChange={(e) => setName(e.target.value)} />}
        </Field>
        <Field label="Twilio number" hint="E.164, e.g. +15551234567." className="min-w-48 flex-1">
          {(p) => <input {...p} required className="input font-mono" placeholder="+15551234567" value={number} onChange={(e) => setNumber(e.target.value)} />}
        </Field>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Account SID" className="min-w-48 flex-1">
          {(p) => <input {...p} required className="input font-mono" placeholder="AC…" value={accountSid} onChange={(e) => setAccountSid(e.target.value)} />}
        </Field>
        <Field label="Auth token" hint="Stored encrypted. Signs inbound requests and sends replies." className="min-w-48 flex-1">
          {(p) => (
            <input {...p} required type="password" autoComplete="off" className="input font-mono" value={authToken} onChange={(e) => setAuthToken(e.target.value)} />
          )}
        </Field>
      </div>
      <div className="flex gap-2">
        <button className="btn btn-primary" disabled={busy}>
          <Icon name="plus" className="size-3.5" />
          {busy ? 'Creating…' : 'Create SMS connection'}
        </button>
        {onCancel ? (
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
        ) : null}
      </div>
      <FormError error={error} />
    </form>
  )
}

export function SmsWebhookUrl({ created, onDismiss }: { created: SmsCreated; onDismiss: () => void }) {
  return (
    <section role="status" aria-label="SMS webhook URL" className="rounded-ctl border border-accent bg-raised p-3 shadow-panel">
      <h2 className="font-semibold">Point Twilio at this URL</h2>
      <p className="mt-1 flex min-w-0 flex-wrap items-center gap-2 text-ink-2">
        <CopyId value={created.url} label="SMS webhook URL" />
      </p>
      <p className="mt-1 text-ink-2">In the Twilio console, set “A message comes in” to this URL with HTTP POST.</p>
      <button type="button" className="btn mt-2" onClick={onDismiss}>
        Done
      </button>
    </section>
  )
}

const COLS ='grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-0.5 px-3 md:grid-cols-[minmax(0,10rem)_6rem_minmax(0,9rem)_minmax(0,1fr)_6rem_minmax(0,auto)]'

export function Connections({ viewer }: { viewer: Viewer }) {
  const state = useLoad(() => get<{ items: Connection[] }>('/api/connections'), [])
  const [created, setCreated] = useState<WebhookCreated | null>(null)
  const [createdSms, setCreatedSms] = useState<SmsCreated | null>(null)
  const [adding, setAdding] = useState(false)
  const installs = useInstalls()
  const [addingSms, setAddingSms] = useState(false)

  const actions = (
    <>
      <button type="button" className="btn btn-sm" disabled={addingSms} onClick={() => setAddingSms(true)}>
        <Icon name="plus" className="size-3.5" />
        New SMS
      </button>
      <InstallLinks installs={installs} small />
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
      {addingSms ? (
        <div className="rounded-ctl border border-line bg-raised p-4 shadow-panel">
          <NewSms
            onCancel={() => setAddingSms(false)}
            onCreated={(c) => {
              setAddingSms(false)
              setCreatedSms(c)
              state.reload()
              connectionsChanged()
            }}
          />
        </div>
      ) : null}
      <SetupHints installs={installs} viewer={viewer} />
      {created ? <WebhookSecret created={created} onDismiss={() => setCreated(null)} /> : null}
      {createdSms ? <SmsWebhookUrl created={createdSms} onDismiss={() => setCreatedSms(null)} /> : null}
      <Async
        state={state}
        skeleton={<SkeletonRows rows={4} />}
        empty={{
          when: (d) => d.items.length === 0,
          render: () => (
            <Empty title="No connections yet" action={actions}>
              Connect a Slack account, add the Relay bot to a Discord server, add an SMS number, or create a signed webhook for any service that can send HTTP POSTs.
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
