import { useEffect, useState, type FormEvent } from 'react'
import { CONNECTIONS_CHANGED_EVENT, get, post, type InstallUrls, type SmsCreated, type WebhookCreated } from '../api'
import { CopyId, Field, FormError, SecretBox } from '../components'
import { ACTIONS, FIELD_GRID, FORM } from './new/layout'
import type { Viewer } from '../connect-wizard'
import { errorText, useLoad } from '../hooks'
import { PROVIDER_NAME, setupHint, type ProviderId } from '../integrations'
import { Icon } from '../icons'

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

export function SetupHint({ provider, viewer }: { provider: ProviderId; viewer: Viewer }) {
  const name = PROVIDER_NAME[provider]
  const hint = setupHint(viewer)
  if (hint === 'set_up') {
    return (
      <a className="btn" href={`#/new/${provider}/setup`}>
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

export function NewWebhook({ onCreated }: { onCreated: (c: WebhookCreated) => void }) {
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
    <form onSubmit={submit} aria-label="New webhook" className={FORM}>
      <Field label="Name" hint="Optional. Shown in the connection switcher.">
        {(p) => <input {...p} className="input" maxLength={100} placeholder="Deploys" value={name} onChange={(e) => setName(e.target.value)} />}
      </Field>
      <FormError error={error} />
      <div className={ACTIONS}>
        <button className="btn btn-primary" disabled={busy}>
          <Icon name="plus" className="size-3.5" />
          {busy ? 'Creating…' : 'Create webhook'}
        </button>
      </div>
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

export function NewSms({ onCreated }: { onCreated: (c: SmsCreated) => void }) {
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
    <form onSubmit={submit} aria-label="New SMS connection" className={FORM}>
      <Field label="Name" hint="Optional. Shown in the connection switcher.">
        {(p) => <input {...p} className="input" maxLength={100} placeholder="Support line" value={name} onChange={(e) => setName(e.target.value)} />}
      </Field>
      <div className={FIELD_GRID}>
        <Field label="Twilio number" hint="E.164, e.g. +15551234567.">
          {(p) => <input {...p} required className="input font-mono" placeholder="+15551234567" value={number} onChange={(e) => setNumber(e.target.value)} />}
        </Field>
        <Field label="Account SID" hint="Starts with AC.">
          {(p) => <input {...p} required className="input font-mono" placeholder="AC…" value={accountSid} onChange={(e) => setAccountSid(e.target.value)} />}
        </Field>
      </div>
      <Field label="Auth token" hint="Stored encrypted. Signs inbound requests and sends replies.">
        {(p) => <input {...p} required type="password" autoComplete="off" className="input font-mono" value={authToken} onChange={(e) => setAuthToken(e.target.value)} />}
      </Field>
      <FormError error={error} />
      <div className={ACTIONS}>
        <button className="btn btn-primary" disabled={busy}>
          <Icon name="plus" className="size-3.5" />
          {busy ? 'Creating…' : 'Create SMS connection'}
        </button>
      </div>
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
