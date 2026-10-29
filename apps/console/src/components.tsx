import { useState, type ReactNode } from 'react'
import { errorText, type Loaded } from './hooks'

export function Page({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section>
      <header className="page-head">
        <h1>{title}</h1>
        {actions ? <div className="row">{actions}</div> : null}
      </header>
      {children}
    </section>
  )
}

export function Async<T>({ state, empty, children }: { state: Loaded<T>; empty?: (d: T) => boolean; children: (d: T) => ReactNode }) {
  if (state.error) {
    return (
      <p className="notice error" role="alert">
        {state.error} <button onClick={state.reload}>Retry</button>
      </p>
    )
  }
  if (state.data === null) return <p className="muted">Loading…</p>
  if (empty?.(state.data)) return <p className="muted empty">Nothing here yet.</p>
  return <>{children(state.data)}</>
}

export function Badge({ tone, children }: { tone: 'ok' | 'bad' | 'warn' | 'muted'; children: ReactNode }) {
  return <span className={`badge ${tone}`}>{children}</span>
}

export const statusTone = (s: string) => (s === 'succeeded' || s === 'active' ? 'ok' : s === 'failed' || s === 'revoked' ? 'bad' : s === 'pending' ? 'warn' : 'muted')

export function Status({ value }: { value: string }) {
  return <Badge tone={statusTone(value)}>{value}</Badge>
}

export function ConfirmButton({
  label,
  confirmLabel = 'Confirm',
  onConfirm,
  danger,
}: {
  label: string
  confirmLabel?: string
  onConfirm: () => Promise<unknown> | unknown
  danger?: boolean
}) {
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!asking) {
    return (
      <button className={danger ? 'danger' : ''} onClick={() => setAsking(true)}>
        {label}
      </button>
    )
  }
  return (
    <span className="confirm" role="group" aria-label={`Confirm ${label}`}>
      <span>Are you sure?</span>
      <button
        className={danger ? 'danger' : 'primary'}
        disabled={busy}
        onClick={async () => {
          setBusy(true)
          setError(null)
          try {
            await onConfirm()
            setAsking(false)
          } catch (e) {
            setError(errorText(e))
          } finally {
            setBusy(false)
          }
        }}
      >
        {busy ? 'Working…' : confirmLabel}
      </button>
      <button disabled={busy} onClick={() => setAsking(false)}>
        Cancel
      </button>
      {error ? (
        <span className="notice error" role="alert">
          {error}
        </span>
      ) : null}
    </span>
  )
}

export function SecretBox({ label, value, onDismiss }: { label: string; value: string; onDismiss: () => void }) {
  const [copied, setCopied] = useState<'yes' | 'no' | null>(null)
  return (
    <div className="secret" role="status">
      <strong>{label}</strong>
      <p className="warn-text">You won&apos;t see this again. Copy it now.</p>
      <div className="row">
        <input readOnly value={value} aria-label={label} onFocus={(e) => e.currentTarget.select()} />
        <button
          onClick={() => {
            navigator.clipboard.writeText(value).then(
              () => setCopied('yes'),
              () => setCopied('no'),
            )
          }}
        >
          {copied === 'yes' ? 'Copied' : 'Copy'}
        </button>
      </div>
      {copied === 'no' ? <p className="muted">Copy failed. Select the text and copy it by hand.</p> : null}
      <button onClick={onDismiss}>I saved it</button>
    </div>
  )
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint ? <small className="muted">{hint}</small> : null}
    </label>
  )
}

export function Json({ value }: { value: unknown }) {
  return <pre className="json">{JSON.stringify(value, null, 2)}</pre>
}

export const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—')

export function FormError({ error }: { error: string | null }) {
  return error ? (
    <p className="notice error" role="alert">
      {error}
    </p>
  ) : null
}

export const splitList = (s: string): string[] | null => {
  const list = s.split(',').map((x) => x.trim()).filter(Boolean)
  return list.length ? list : null
}
