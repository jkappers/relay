import { useEffect, useId, useState, type ReactNode } from 'react'
import { errorText, type Loaded } from './hooks'
import { Icon, type IconName } from './icons'

export const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ')

export function Page({ title, meta, actions, children }: { title: ReactNode; meta?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section aria-labelledby="page-title" className="min-w-0">
      <header className="flex min-h-9 flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-3">
          <h1 id="page-title" className="text-lg font-semibold tracking-tight break-words">
            {title}
          </h1>
          {meta ? <p className="min-w-0 text-xs text-ink-3">{meta}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </header>
      <div className="mt-3 flex flex-col gap-4">{children}</div>
    </section>
  )
}

export function SectionHead({ id, title, children }: { id?: string; title: string; children?: ReactNode }) {
  return (
    <div className="flex min-h-6 flex-wrap items-center justify-between gap-x-3">
      <h2 id={id} className="text-xs font-semibold text-ink-2">
        {title}
      </h2>
      {children ? <div className="flex flex-wrap items-center gap-2 text-xs text-ink-3">{children}</div> : null}
    </div>
  )
}

export function SkeletonRows({ rows = 8, height = 'h-8' }: { rows?: number; height?: string }) {
  return (
    <div aria-hidden="true" className="divide-y divide-rule border-y border-rule">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className={cx('flex items-center gap-4 px-3', height)}>
          <span className="h-2.5 w-40 max-w-[40%] rounded-jack bg-skeleton" />
          <span className="h-2.5 w-24 rounded-jack bg-skeleton" />
          <span className="ml-auto h-2.5 w-12 rounded-jack bg-skeleton" />
        </div>
      ))}
    </div>
  )
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="border-y border-rule px-3 py-6">
      <p className="font-semibold">{title}</p>
      {children ? <p className="mt-1 max-w-[60ch] text-ink-2">{children}</p> : null}
      {action ? <div className="mt-3 flex flex-wrap gap-2">{action}</div> : null}
    </div>
  )
}

export function Notice({ tone = 'info', children, onRetry }: { tone?: 'info' | 'error' | 'ok'; children: ReactNode; onRetry?: () => void }) {
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={cx(
        'flex min-h-8 flex-wrap items-center gap-x-3 gap-y-1 border-y px-3 py-1',
        tone === 'error' ? 'border-bad text-bad-ink' : tone === 'ok' ? 'border-ok text-ok-ink' : 'border-rule text-ink-2',
      )}
    >
      <span className="min-w-0 break-words">{children}</span>
      {onRetry ? (
        <button type="button" className="btn btn-sm" onClick={onRetry}>
          <Icon name="refresh" className="size-3" />
          Retry
        </button>
      ) : null}
    </div>
  )
}

export function Async<T>({
  state,
  skeleton,
  empty,
  children,
}: {
  state: Loaded<T>
  skeleton?: ReactNode
  empty?: { when: (d: T) => boolean; render: () => ReactNode }
  children: (d: T) => ReactNode
}) {
  if (state.error && state.data === null) {
    return (
      <Notice tone="error" onRetry={state.reload}>
        Could not load: {state.error}
      </Notice>
    )
  }
  if (state.data === null) return <>{skeleton ?? <SkeletonRows />}</>
  return (
    <>
      {state.error ? (
        <Notice tone="error" onRetry={state.reload}>
          Refresh failed: {state.error}. Showing the last loaded data.
        </Notice>
      ) : null}
      {empty?.when(state.data) ? empty.render() : children(state.data)}
    </>
  )
}

export function FormError({ error }: { error: string | null }) {
  return error ? <Notice tone="error">{error}</Notice> : null
}

export function ConfirmButton({
  label,
  confirmLabel = 'Confirm',
  question = 'Are you sure?',
  onConfirm,
  danger,
  quiet,
  icon,
  small,
  doneText,
  iconOnly,
  tabIndex,
}: {
  label: string
  confirmLabel?: string
  question?: string
  onConfirm: () => Promise<unknown> | unknown
  danger?: boolean
  quiet?: boolean
  icon?: IconName
  small?: boolean
  doneText?: string
  iconOnly?: boolean
  tabIndex?: number
}) {
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const size = small ? 'btn-sm' : ''

  if (!asking) {
    return (
      <span className="inline-flex items-center gap-2">
        <button
          type="button"
          className={cx('btn', size, iconOnly && 'btn-icon', quiet || iconOnly ? 'btn-quiet' : null, danger && !iconOnly && 'btn-danger')}
          aria-label={iconOnly ? label : undefined}
          title={iconOnly ? label : undefined}
          tabIndex={tabIndex}
          onClick={(e) => {
            e.stopPropagation()
            setDone(false)
            setAsking(true)
          }}
        >
          {icon ? <Icon name={icon} className="size-3.5" /> : null}
          {iconOnly ? null : label}
        </button>
        {done && doneText ? (
          <span role="status" className={iconOnly ? 'sr-only' : 'text-xs text-ok-ink'}>
            {doneText}
          </span>
        ) : null}
      </span>
    )
  }
  return (
    <span
      className={cx('inline-flex items-center gap-2', iconOnly ? 'absolute inset-y-0 right-0 z-20 bg-raised pr-1 pl-3 shadow-panel' : 'flex-wrap')}
      role="group"
      aria-label={`Confirm ${label}`}
      onClick={(e) => e.stopPropagation()}
    >
      <span className="text-xs font-medium whitespace-nowrap text-ink-2">{question}</span>
      <button
        type="button"
        className={cx('btn btn-sm', danger ? 'btn-danger-solid' : 'btn-primary')}
        disabled={busy}
        autoFocus
        onClick={async () => {
          setBusy(true)
          setError(null)
          try {
            await onConfirm()
            setAsking(false)
            setDone(true)
          } catch (e) {
            setError(errorText(e))
          } finally {
            setBusy(false)
          }
        }}
      >
        {busy ? 'Working…' : confirmLabel}
      </button>
      <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setAsking(false)}>
        Cancel
      </button>
      {error ? (
        <span role="alert" className="text-xs text-bad-ink">
          {error}
        </span>
      ) : null}
    </span>
  )
}

function useCopy(): [state: 'idle' | 'copied' | 'failed', copy: (v: string) => void] {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  useEffect(() => {
    if (state === 'idle') return
    const t = setTimeout(() => setState('idle'), 2000)
    return () => clearTimeout(t)
  }, [state])
  const copy = (v: string) => {
    navigator.clipboard.writeText(v).then(
      () => setState('copied'),
      () => setState('failed'),
    )
  }
  return [state, copy]
}

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [state, copy] = useCopy()
  return (
    <>
      <button type="button" className="btn btn-xs" onClick={() => copy(value)} aria-label={label} title={label}>
        <Icon name={state === 'copied' ? 'check' : 'copy'} className="size-3" />
      </button>
      <span role="status" className="sr-only">
        {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : ''}
      </span>
    </>
  )
}

export function CopyId({ value, label = 'ID', short }: { value: string; label?: string; short?: boolean }) {
  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-0.5 align-middle">
      <code className="min-w-0 truncate text-ink-2" title={value}>
        {short ? value.slice(0, 8) : value}
      </code>
      <CopyButton value={value} label={`Copy ${label}`} />
    </span>
  )
}

export function SecretBox({ label, value, onDismiss, children }: { label: string; value: string; onDismiss: () => void; children?: ReactNode }) {
  const [state, copy] = useCopy()
  const id = useId()
  return (
    <section role="status" aria-labelledby={`${id}-t`} className="rounded-ctl border border-accent bg-raised p-3 shadow-panel">
      <h2 id={`${id}-t`} className="font-semibold">
        {label}
      </h2>
      <p className="mt-0.5 text-xs font-medium text-warn-ink">You won&apos;t see this again. Copy it now.</p>
      {children ? <div className="mt-2 text-ink-2">{children}</div> : null}
      <div className="mt-2 flex gap-2">
        <input readOnly value={value} aria-label={label} className="input font-mono" onFocus={(e) => e.currentTarget.select()} />
        <button type="button" className="btn btn-primary" onClick={() => copy(value)}>
          <Icon name={state === 'copied' ? 'check' : 'copy'} className="size-3.5" />
          {state === 'copied' ? 'Copied' : 'Copy'}
        </button>
      </div>
      {state === 'failed' ? <p className="mt-2 text-bad-ink">Copy failed. Select the text and copy it by hand.</p> : null}
      <button type="button" className="btn mt-2" onClick={onDismiss}>
        I saved it
      </button>
    </section>
  )
}

export function Field({
  label,
  hint,
  className,
  children,
}: {
  label: string
  hint?: string
  className?: string
  children: (props: { id: string; 'aria-describedby'?: string }) => ReactNode
}) {
  const id = useId()
  return (
    <div className={cx('flex min-w-0 flex-col gap-1', className)}>
      <label htmlFor={id} className="label">
        {label}
      </label>
      {children({ id, ...(hint ? { 'aria-describedby': `${id}-hint` } : {}) })}
      {hint ? (
        <p id={`${id}-hint`} className="text-xs text-ink-3">
          {hint}
        </p>
      ) : null}
    </div>
  )
}

export function Check({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <label className="flex min-h-7 cursor-pointer items-center gap-2">
      <input type="checkbox" className="size-3.5" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{children}</span>
    </label>
  )
}

export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  className,
}: {
  label: string
  value: T
  options: readonly (readonly [T, ReactNode, string?])[]
  onChange: (v: T) => void
  className?: string
}) {
  const name = useId()
  return (
    <fieldset className={cx('seg max-w-full overflow-x-auto', className)}>
      <legend className="sr-only">{label}</legend>
      {options.map(([v, content, title]) => (
        <label key={v} title={title}>
          <input type="radio" name={name} value={v} checked={value === v} onChange={() => onChange(v)} className="sr-only" />
          {content}
        </label>
      ))}
    </fieldset>
  )
}

export function Json({ value, label }: { value: unknown; label: string }) {
  const text = JSON.stringify(value, null, 2) ?? 'null'
  return (
    <div className="relative min-w-0">
      <pre
        tabIndex={0}
        aria-label={label}
        className="max-h-80 overflow-auto rounded-ctl border border-rule bg-ground p-2.5 pr-9 leading-[1.125rem] whitespace-pre text-ink"
      >
        {text}
      </pre>
      <div className="absolute top-1.5 right-1.5">
        <CopyButton value={text} label={`Copy ${label}`} />
      </div>
    </div>
  )
}

export function Details({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    <details className="group min-w-0">
      <summary className="inline-flex min-h-6 cursor-pointer items-center gap-1 text-xs font-semibold text-ink-2 select-none hover:text-ink">
        <Icon name="back" className="size-3 rotate-180 transition-transform group-open:-rotate-90" />
        {summary}
      </summary>
      <div className="mt-1">{children}</div>
    </details>
  )
}

const nowListeners = new Set<(n: number) => void>()
let nowTimer: ReturnType<typeof setInterval> | null = null

export function useNow(): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    nowListeners.add(setNow)
    if (!nowTimer) nowTimer = setInterval(() => nowListeners.forEach((l) => l(Date.now())), 15_000)
    return () => {
      nowListeners.delete(setNow)
      if (nowListeners.size === 0 && nowTimer) {
        clearInterval(nowTimer)
        nowTimer = null
      }
    }
  }, [])
  return now
}

export const fmtDate = (iso: string | null) => (iso ? `${new Date(iso).toISOString().slice(0, 23).replace('T', ' ')} UTC` : '—')

export function relative(iso: string, now: number, bare?: boolean): string {
  const s = Math.round((now - new Date(iso).getTime()) / 1000)
  const future = s < 0
  const a = Math.abs(s)
  const v = a < 45 ? `${a}s` : a < 3600 ? `${Math.round(a / 60)}m` : a < 86_400 ? `${Math.round(a / 3600)}h` : a < 30 * 86_400 ? `${Math.round(a / 86_400)}d` : null
  if (!v) return new Date(iso).toLocaleDateString()
  return future ? `in ${v}` : bare ? v : `${v} ago`
}

export function Time({ iso, className, bare, abs: show }: { iso: string | null; className?: string; bare?: boolean; abs?: boolean }) {
  const now = useNow()
  if (!iso) return <span className={cx('text-ink-3', className)}>—</span>
  const abs = fmtDate(iso)
  return (
    <time dateTime={iso} title={abs} className={cx('whitespace-nowrap', className)}>
      {relative(iso, now, bare)}
      {show ? <span className="ml-2 font-mono text-xs text-ink-3">{abs}</span> : <span className="sr-only">{bare ? ' ago' : ''}, {abs}</span>}
    </time>
  )
}

export function Facts({ children }: { children: ReactNode }) {
  return <dl className="grid grid-cols-[max-content_minmax(0,1fr)] items-baseline gap-x-4 gap-y-1">{children}</dl>
}

export function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-xs text-ink-3">{term}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  )
}

export const splitList = (s: string): string[] | null => {
  const list = s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
  return list.length ? list : null
}
