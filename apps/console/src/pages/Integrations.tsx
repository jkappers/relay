import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { ApiError, connectionsChanged, del, get, post, put } from '../api'
import { Async, ConfirmButton, CopyId, cx, Details, Field, FormError, Notice, Page, SkeletonRows, Time } from '../components'
import { errorText, useLoad } from '../hooks'
import { Icon } from '../icons'
import { ACTIONS, FIELD_GRID, FORM } from './new/layout'
import {
  badgeOf,
  BADGE_TEXT,
  clientIdConflict,
  confirmMatches,
  confirmWord,
  conflictText,
  emptyForm,
  formBody,
  formProblems,
  gatewayLine,
  PROVIDER_NAME,
  problemText,
  publicUrlWarning,
  savedInRelay,
  SECRET_FIELDS,
  SECRET_LABEL,
  secretMode,
  secretNote,
  slackManifestLink,
  sourceText,
  testSummary,
  type AppForm,
  type Badge,
  type IntegrationsView,
  type ProviderId,
  type ProviderView,
  type TestResponse,
  type TestSummary,
  type Tone,
  validationText,
} from '../integrations'
import { Lamp } from '../trace'

const fmt = (iso: string) => new Date(iso).toLocaleString()
const TONE_TEXT: Record<Tone, string> = { ok: 'text-ok-ink', warn: 'text-warn-ink', bad: 'text-bad-ink', off: 'text-ink-3' }
const BADGE_TONE: Record<Badge, Tone> = { ready: 'ok', needs_setup: 'warn', problem: 'bad' }

function Ext({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  )
}

function StatusBadge({ badge }: { badge: Badge }) {
  const tone = BADGE_TONE[badge]
  return (
    <span className={cx('inline-flex h-5 items-center gap-1.5 rounded-jack border border-line px-1.5 text-xs font-medium', TONE_TEXT[tone])}>
      <Lamp state={tone} className="size-2" />
      {BADGE_TEXT[badge]}
    </span>
  )
}

function SlackGuide({ view }: { view: ProviderView }) {
  return (
    <ol className="flex list-decimal flex-col gap-2 pl-5 marker:text-ink-3">
      <li>
        <Ext href={slackManifestLink(view.urls)}>Create Relay’s Slack app</Ext>. Slack opens with the settings filled in. Pick your workspace, click{' '}
        <b>Next</b>, then <b>Create</b>.
        <p className="mt-0.5 text-xs text-ink-3">
          Prefer to do it by hand? Go to <Ext href="https://api.slack.com/apps">your Slack apps</Ext>, click <b>Create New App</b>, and use the two addresses
          below.
        </p>
      </li>
      <li>
        On the app’s <b>Basic Information</b> page, under <b>App Credentials</b>, copy the <b>Client ID</b>, <b>Client Secret</b>, and{' '}
        <b>Signing Secret</b> into the form below (click <b>Show</b> to see each secret). Click <b>Save</b>.
      </li>
      <li>
        Only now, back in Slack, open <b>Event Subscriptions</b>. Next to the Request URL, click <b>Retry</b>. It turns green because Relay has your
        signing secret. The Request URL is
        <span className="ml-1 inline-flex max-w-full align-middle">
          <CopyId value={view.urls.events ?? ''} label="Slack event address" />
        </span>
      </li>
      <li>
        Open <b>OAuth &amp; Permissions</b> and check that the Redirect URL is
        <span className="ml-1 inline-flex max-w-full align-middle">
          <CopyId value={view.urls.redirect} label="Slack redirect address" />
        </span>
      </li>
      <li>
        Open <b>Manage Distribution</b>. Under <b>Share Your App with Other Workspaces</b>, check each item, then click{' '}
        <b>Activate Public Distribution</b>. Skip this only if everyone who connects is in your own workspace.
      </li>
      <li>
        Click <b>Test</b> below. When it passes, everyone sees <b>Connect Slack</b> in Relay.
      </li>
    </ol>
  )
}

function DiscordGuide({ view }: { view: ProviderView }) {
  return (
    <ol className="flex list-decimal flex-col gap-2 pl-5 marker:text-ink-3">
      <li>
        Open the <Ext href="https://discord.com/developers/applications">Discord Developer Portal</Ext>. Click <b>New Application</b>, name it Relay,
        agree to the terms, and click <b>Create</b>.
      </li>
      <li>
        Open the <b>OAuth2</b> page. Copy the <b>Client ID</b> into the form below. Click <b>Reset Secret</b> and copy the <b>Client Secret</b>.
      </li>
      <li>
        On the same page, under <b>Redirects</b>, click <b>Add Redirect</b>, paste
        <span className="mx-1 inline-flex max-w-full align-middle">
          <CopyId value={view.urls.redirect} label="Discord redirect address" />
        </span>
        and click <b>Save Changes</b>.
      </li>
      <li>
        Open the <b>Bot</b> page. Click <b>Reset Token</b> and copy the <b>Bot token</b>. Leave every <b>Privileged Gateway Intent</b> off. Relay
        needs none.
      </li>
      <li>
        Click <b>Save</b> below, then <b>Test</b>. The bot comes online within a minute.
      </li>
      <li>
        Everyone then sees <b>Add Discord server</b> in Relay, which invites the bot to a server they manage.
      </li>
    </ol>
  )
}

function ConfirmChange({
  provider,
  count,
  action,
  onConfirm,
  onCancel,
}: {
  provider: ProviderId
  count: number
  action: 'save' | 'remove'
  onConfirm: () => Promise<void>
  onCancel: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const id = useId()
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ok = confirmMatches(provider, typed)

  useEffect(() => {
    const d = ref.current
    if (d && !d.open) d.showModal()
    return () => d?.close()
  }, [])

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!ok || busy) return
    setBusy(true)
    setError(null)
    try {
      await onConfirm()
    } catch (err) {
      setError(errorText(err))
      setBusy(false)
    }
  }

  return (
    <dialog
      ref={ref}
      aria-labelledby={`${id}-t`}
      aria-describedby={`${id}-d`}
      onCancel={(e) => {
        e.preventDefault()
        if (!busy) onCancel()
      }}
      className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-ctl border border-line bg-raised p-4 text-ink shadow-panel backdrop:bg-[rgb(10_11_13/0.5)]"
    >
      <form onSubmit={submit} className="flex flex-col gap-3">
        <h2 id={`${id}-t`} className="font-semibold">
          {action === 'save' ? `Switch to a different ${PROVIDER_NAME[provider]} app?` : `Remove the ${PROVIDER_NAME[provider]} settings?`}
        </h2>
        <p id={`${id}-d`} className="text-ink-2">
          {conflictText(provider, count)}
        </p>
        <Field label={`Type ${confirmWord(provider)}`}>
          {(p) => <input {...p} autoFocus autoComplete="off" className="input" value={typed} onChange={(e) => setTyped(e.target.value)} />}
        </Field>
        <FormError error={error} />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button className="btn btn-danger-solid" disabled={!ok || busy}>
            {busy ? 'Working…' : action === 'save' ? 'Save and disconnect' : 'Remove and disconnect'}
          </button>
        </div>
      </form>
    </dialog>
  )
}

function TestResult({ summary }: { summary: TestSummary }) {
  return (
    <div role="status" className="flex flex-col gap-1 border-y border-rule px-3 py-2">
      <p className={cx('font-medium', TONE_TEXT[summary.tone])}>{summary.headline}</p>
      {summary.lines.length ? (
        <ul className="flex flex-col gap-0.5">
          {summary.lines.map((l) => (
            <li key={l.check} className="flex flex-wrap items-baseline gap-x-2">
              <Lamp state={l.tone} className="size-2 self-center" />
              <span className="w-40 shrink-0 text-ink-2">{l.label}</span>
              <span className={cx('min-w-0 flex-1', TONE_TEXT[l.tone])}>{l.text}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function SettingsForm({ view, onSaved }: { view: ProviderView; onSaved: () => void }) {
  const p = view.provider
  const name = PROVIDER_NAME[p]
  const [form, setForm] = useState<AppForm>(() => emptyForm(view))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [conflict, setConflict] = useState<number | null>(null)

  const setSecret = (field: keyof AppForm['secrets'], value: string) => setForm((f) => ({ ...f, secrets: { ...f.secrets, [field]: value } }))

  async function send(confirm: boolean) {
    await put(`/api/admin/integrations/${p}`, formBody(p, form, confirm))
    setForm((f) => ({ ...f, secrets: {} }))
    setConflict(null)
    onSaved()
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    const problems = formProblems(p, view, form)
    if (problems.length) {
      setError(problems.join(' '))
      return
    }
    setBusy(true)
    setError(null)
    try {
      await send(false)
    } catch (err) {
      const n = err instanceof ApiError ? clientIdConflict(err.status, err.body) : null
      if (n !== null) setConflict(n)
      else setError(saveError(err))
    } finally {
      setBusy(false)
    }
  }

  const memberHelp =
    p === 'slack'
      ? 'One Slack member ID per line, like U012AB3CD. To find one: in Slack, open the person’s profile, click the ⋮ (More) button, then Copy member ID.'
      : 'One Discord user ID per line, like 123456789012345678. First turn on Developer Mode in Discord (User Settings, Advanced, Developer Mode). Then right-click the person and choose Copy User ID.'

  return (
    <form onSubmit={submit} aria-label={`${name} settings`} className={FORM}>
        <Field label="Client ID" hint={p === 'discord' ? 'Same as the Application ID.' : undefined}>
          {(fp) => (
            <input
              {...fp}
              required
              autoComplete="off"
              spellCheck={false}
              className="input font-mono"
              value={form.clientId}
              onChange={(e) => setForm((f) => ({ ...f, clientId: e.target.value }))}
            />
          )}
        </Field>
      <div className={FIELD_GRID}>
        {SECRET_FIELDS[p].map((field) => {
          const mode = secretMode(view, field)
          const info = view.secrets[field]
          const hint =
            mode === 'keep'
              ? `${secretNote(info, fmt)}. Leave blank to keep it.`
              : info?.set && info.source === 'env'
                ? 'Now from the server environment. Paste it to keep it in Relay.'
                : 'Required.'
          return (
            <Field key={field} label={SECRET_LABEL[field]} hint={hint}>
              {(fp) => (
                <input
                  {...fp}
                  type="password"
                  autoComplete="new-password"
                  spellCheck={false}
                  required={mode === 'required'}
                  placeholder={mode === 'keep' ? '••••••••  (saved)' : undefined}
                  className="input font-mono"
                  value={form.secrets[field] ?? ''}
                  onChange={(e) => setSecret(field, e.target.value)}
                />
              )}
            </Field>
          )
        })}
      </div>
      <Details summary="Advanced: who can connect">
        <fieldset className="flex flex-col gap-1 pl-4">
          <legend className="label mb-1">Who can connect {name}</legend>
          <label className="flex min-h-7 cursor-pointer items-center gap-2">
            <input type="radio" name={`${p}-who`} checked={form.who === 'anyone'} onChange={() => setForm((f) => ({ ...f, who: 'anyone' }))} />
            Anyone with a Relay account (recommended)
          </label>
          <label className="flex min-h-7 cursor-pointer items-center gap-2">
            <input type="radio" name={`${p}-who`} checked={form.who === 'only'} onChange={() => setForm((f) => ({ ...f, who: 'only' }))} />
            Only these members
          </label>
          {form.who === 'only' ? (
            <Field label={`${name} member IDs`} hint={memberHelp} className="max-w-xl">
              {(fp) => (
                <textarea
                  {...fp}
                  rows={4}
                  spellCheck={false}
                  className="input font-mono"
                  value={form.members}
                  onChange={(e) => setForm((f) => ({ ...f, members: e.target.value }))}
                />
              )}
            </Field>
          ) : null}
        </fieldset>
      </Details>
      <FormError error={error} />
      <div className={ACTIONS}>
        <button className="btn btn-primary" disabled={busy}>
          <Icon name="check" className="size-3.5" />
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
      {conflict !== null ? (
        <ConfirmChange provider={p} count={conflict} action="save" onCancel={() => setConflict(null)} onConfirm={() => send(true)} />
      ) : null}
    </form>
  )
}

const saveError = (err: unknown) => (err instanceof ApiError && err.status === 400 ? validationText(err.body) : null) ?? errorText(err)

export function ProviderCard({ view, onChanged, bare }: { view: ProviderView; onChanged: () => void; bare?: boolean }) {
  const p = view.provider
  const name = PROVIDER_NAME[p]
  const badge = badgeOf(view)
  const problem = problemText(view)
  const gateway = gatewayLine(view)
  const [saved, setSaved] = useState(false)
  const [testing, setTesting] = useState(false)
  const [test, setTest] = useState<TestSummary | null>(null)
  const [testError, setTestError] = useState<string | null>(null)
  const [removeConflict, setRemoveConflict] = useState<number | null>(null)

  async function runTest() {
    setTesting(true)
    setTest(null)
    setTestError(null)
    try {
      setTest(testSummary(p, await post<TestResponse>(`/api/admin/integrations/${p}/test`)))
    } catch (err) {
      setTestError(errorText(err))
    } finally {
      setTesting(false)
    }
  }

  async function remove(confirm: boolean) {
    await del(`/api/admin/integrations/${p}${confirm ? '?confirmClientIdChange=true' : ''}`)
    setRemoveConflict(null)
    setTest(null)
    setSaved(false)
    onChanged()
  }

  return (
    <section aria-labelledby={`${p}-title`} className={cx('flex flex-col gap-4', !bare && 'rounded-ctl border border-line bg-raised p-4')}>
      <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h2 id={`${p}-title`} className="font-semibold">
            {name}
          </h2>
          <StatusBadge badge={badge} />
          <span className="text-xs text-ink-3">{sourceText(view)}</span>
          <span className="text-xs text-ink-3">
            {view.connections} {view.connections === 1 ? 'connection' : 'connections'}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn btn-sm" disabled={testing || view.state === 'needs_setup'} onClick={runTest}>
            <Icon name="refresh" className="size-3.5" />
            {testing ? 'Testing…' : 'Test'}
          </button>
          {savedInRelay(view) ? (
            <ConfirmButton
              small
              quiet
              danger
              label="Remove"
              question="Go back to the server’s own settings?"
              confirmLabel="Remove"
              onConfirm={async () => {
                try {
                  await remove(false)
                } catch (err) {
                  const n = err instanceof ApiError ? clientIdConflict(err.status, err.body) : null
                  if (n === null) throw err
                  setRemoveConflict(n)
                }
              }}
            />
          ) : null}
        </div>
      </header>

      {problem ? <Notice tone="error">{problem}</Notice> : null}
      {gateway ? (
        <p className={cx('flex items-center gap-2', TONE_TEXT[gateway.tone])}>
          <Lamp state={gateway.tone} className="size-2" />
          <span>
            {gateway.text}
            {gateway.tone === 'ok' && view.status?.lastReadyAt ? (
              <>
                {' since '}
                <Time iso={view.status.lastReadyAt} />
              </>
            ) : null}
          </span>
        </p>
      ) : null}
      {p === 'slack' && view.state !== 'needs_setup' ? (
        <p className="text-ink-2">
          Last signed request accepted:{' '}
          {view.status?.lastSignedOkAt ? <Time iso={view.status.lastSignedOkAt} /> : <span className="text-ink-3">none yet</span>}
        </p>
      ) : null}
      {saved ? <Notice tone="ok">Saved. Changes apply within a few seconds.</Notice> : null}
      {testError ? <Notice tone="error">Test failed to run: {testError}</Notice> : null}
      {test ? <TestResult summary={test} /> : null}

      <details open={badge !== 'ready'} className="group min-w-0">
        <summary className="inline-flex min-h-6 cursor-pointer items-center gap-1 text-xs font-semibold text-ink-2 select-none hover:text-ink">
          <Icon name="back" className="size-3 rotate-180 transition-transform group-open:-rotate-90" />
          How to set up {name}
        </summary>
        <div className="mt-2 max-w-[75ch]">{p === 'slack' ? <SlackGuide view={view} /> : <DiscordGuide view={view} />}</div>
      </details>

      <SettingsForm
        key={view.version}
        view={view}
        onSaved={() => {
          setSaved(true)
          setTest(null)
          onChanged()
        }}
      />
      {removeConflict !== null ? (
        <ConfirmChange provider={p} count={removeConflict} action="remove" onCancel={() => setRemoveConflict(null)} onConfirm={() => remove(true)} />
      ) : null}
    </section>
  )
}

export function Integrations() {
  const state = useLoad(() => get<IntegrationsView>('/api/admin/integrations'), [])
  const onChanged = () => {
    state.reload()
    connectionsChanged()
  }
  return (
    <Page title="Settings" meta="The Slack and Discord apps everyone on this Relay connects through. Only admins see this page.">
      <Async state={state} skeleton={<SkeletonRows rows={6} />}>
        {(d) => {
          const warning = publicUrlWarning(d)
          return (
            <>
              {warning ? <Notice tone="error">{warning}</Notice> : null}
              <ProviderCard view={d.providers.slack} onChanged={onChanged} />
              <ProviderCard view={d.providers.discord} onChanged={onChanged} />
            </>
          )
        }}
      </Async>
    </Page>
  )
}
