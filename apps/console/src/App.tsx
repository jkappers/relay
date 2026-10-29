import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, CONNECTIONS_CHANGED_EVENT, del, get, setTenant, UNAUTHORIZED_EVENT, type Connection, type Session, type SignupMode } from './api'
import { cx } from './components'
import { at, focusRow, navigate, parseRoute, splitTenant, useHashPath } from './hooks'
import { Icon, RelayMark, type IconName } from './icons'
import { Onboarding } from './pages/Onboarding'
import { jackCode, lineLabel } from './patch'
import { Lamp } from './trace'
import { isNewPath, type Viewer } from './connect-wizard'
import { Connections } from './pages/Connections'
import { Deliveries } from './pages/Deliveries'
import { Destinations } from './pages/Destinations'
import { EventPanel, Events } from './pages/Events'
import { Integrations } from './pages/Integrations'
import { NewFlow } from './pages/new'
import { Login } from './pages/Login'
import { Overview } from './pages/Overview'
import { Routes } from './pages/Routes'
import { useTheme, type ThemeChoice } from './theme'

const NAV: readonly (readonly [string, string, IconName])[] = [
  ['/', 'Overview', 'overview'],
  ['/events', 'Events', 'calls'],
  ['/deliveries', 'Deliveries', 'send'],
  ['/routes', 'Routes', 'patch'],
  ['/connections', 'Connections', 'line'],
  ['/destinations', 'Destinations', 'jack'],
]

function view(path: string, open: string | null, viewer: Viewer) {
  switch (path) {
    case '/connections':
      return <Connections />
    case '/destinations':
      return <Destinations />
    case '/routes':
      return <Routes />
    case '/events':
      return <Events open={open} />
    case '/deliveries':
      return <Deliveries open={open} />
    default:
      return <Overview open={open} />
  }
}

const THEMES: [ThemeChoice, string, IconName][] = [
  ['light', 'Light', 'sun'],
  ['dark', 'Dark', 'moon'],
  ['system', 'System', 'system'],
]

function ThemeSwitch() {
  const [theme, setTheme] = useTheme()
  return (
    <fieldset className="seg grid grid-cols-3">
      <legend className="sr-only">Theme</legend>
        {THEMES.map(([value, label, icon]) => (
          <label key={value} title={label} className="justify-center">
            <input type="radio" name="theme" value={value} checked={theme === value} onChange={() => setTheme(value)} className="sr-only" />
            <Icon name={icon} className={cx('size-3.5', theme === value && 'text-accent')} />
            <span className="sr-only">{label}</span>
          </label>
        ))}
    </fieldset>
  )
}

function Switcher({ connections, current }: { connections: Connection[]; current: Connection }) {
  const ref = useRef<HTMLDetailsElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.open = false
  }, [current.id])
  return (
    <details ref={ref} className="group relative px-2 pb-2">
      <summary className="flex h-8 cursor-pointer list-none items-center gap-2 rounded-ctl border border-line bg-raised px-2 hover:border-edge [&::-webkit-details-marker]:hidden">
        <span className="sr-only">Connection: </span>
        <span className="jack-code" title={current.provider}>
          {jackCode(current.provider)}
        </span>
        <span className="min-w-0 flex-1 truncate font-medium" title={lineLabel(current)}>
          {lineLabel(current)}
        </span>
        <Lamp state={current.status === 'active' ? 'ok' : 'off'} className="size-2" />
        <span className="sr-only">{current.status}</span>
        <Icon name="back" className="size-3 -rotate-90 text-ink-3 group-open:rotate-90" />
      </summary>
      <div className="absolute inset-x-2 top-9 z-40 rounded-ctl border border-line bg-raised py-1 shadow-panel">
        <ul aria-label="Your connections" className="max-h-80 overflow-y-auto">
          {connections.map((c) => (
            <li key={c.id}>
              <a
                href={`#/c/${c.id}`}
                aria-current={c.id === current.id ? 'true' : undefined}
                className={cx('flex h-7 items-center gap-2 px-2 text-ink no-underline hover:bg-hover hover:text-ink', c.id === current.id && 'bg-sel')}
              >
                <span className="jack-code" title={c.provider}>
                  {jackCode(c.provider)}
                </span>
                <span className="min-w-0 flex-1 truncate" title={lineLabel(c)}>
                  {lineLabel(c)}
                </span>
                <Lamp state={c.status === 'active' ? 'ok' : 'off'} className="size-2" />
                <span className="sr-only">{c.status}</span>
              </a>
            </li>
          ))}
        </ul>
        <a href="#/new" className="mt-1 flex h-7 items-center gap-2 border-t border-rule px-2 pt-1 text-xs font-medium no-underline">
          <Icon name="plus" className="size-3" />
          Add a connection
        </a>
      </div>
    </details>
  )
}

export function App() {
  const path = useHashPath()
  const { connectionId: pathTenant, inner } = splitTenant(path)
  const [session, setSession] = useState<Session | null>(null)
  const [signup, setSignup] = useState<SignupMode>('closed')
  const settings = path === '/settings' && session?.user.isAdmin === true
  const newFlow = isNewPath(path)
  const account = settings || newFlow
  const lastTenant = useRef<string | null>(null)
  const refreshed = useRef(new Set<string>())
  const pathConnection = session?.connections.find((c) => c.id === pathTenant) ?? null
  if (pathConnection) lastTenant.current = pathConnection.id
  const tenant = account
    ? (session?.connections.find((c) => c.id === lastTenant.current) ?? session?.connections[0] ?? null)
    : pathConnection
  setTenant(tenant?.id ?? null)
  const { base, event } = parseRoute(inner)
  const fromList = useRef(false)
  const prev = useRef(event)
  if (prev.current !== event) {
    fromList.current = event !== null && (prev.current === null || fromList.current)
    prev.current = event
  }
  const [authed, setAuthed] = useState<boolean | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)

  const check = useCallback(() => {
    get<Session>('/api/session').then(
      (s) => {
        setSession(s)
        setSignup(s.signup)
        setAuthed(true)
      },
      (e: unknown) => {
        const body = e instanceof ApiError ? (e.body as { signup?: SignupMode } | null) : null
        setSignup(body?.signup === 'open' ? 'open' : 'closed')
        setSession(null)
        setAuthed(false)
      },
    )
  }, [])

  useEffect(() => {
    check()
    const on = () => {
      setAuthed(false)
      setSession(null)
      navigate('/login')
    }
    window.addEventListener(UNAUTHORIZED_EVENT, on)
    window.addEventListener(CONNECTIONS_CHANGED_EVENT, check)
    return () => {
      window.removeEventListener(UNAUTHORIZED_EVENT, on)
      window.removeEventListener(CONNECTIONS_CHANGED_EVENT, check)
    }
  }, [check])

  const first = session?.connections[0]
  useEffect(() => {
    if (authed === false && path !== '/login') navigate('/login')
    if (authed !== true || !session) return
    if (path === '/settings') {
      if (!session.user.isAdmin) navigate(first ? `/c/${first.id}` : '/')
      return
    }
    if (isNewPath(path)) return
    if (pathTenant && !pathConnection && !refreshed.current.has(pathTenant)) {
      refreshed.current.add(pathTenant)
      check()
      return
    }
    if (!first) {
      if (path !== '/') navigate('/')
      return
    }
    if (!tenant) navigate(`/c/${first.id}${path === '/login' || pathTenant ? '' : path === '/' ? '' : path}`)
  }, [authed, path, session, first, tenant, pathTenant, pathConnection, check])

  useEffect(() => {
    setMenuOpen(false)
    document.getElementById('main')?.focus({ preventScroll: true })
    window.scrollTo(0, 0)
  }, [base])

  const closePanel = useCallback(() => {
    if (!event) return
    if (fromList.current) window.history.back()
    else window.location.replace(`#${at(base)}`)
    fromList.current = false
  }, [base, event])

  const lastOpen = useRef(event)
  useEffect(() => {
    if (!event && lastOpen.current) focusRow(lastOpen.current)
    lastOpen.current = event
  }, [event])

  if (authed === null) {
    return (
      <p role="status" className="p-6 text-sm text-ink-2">
        Checking session…
      </p>
    )
  }
  if (!authed) return <Login signup={signup} onLogin={check} />

  const signOut = async () => {
    await del('/api/session').catch(() => undefined)
    setSession(null)
    setAuthed(false)
    navigate('/login')
  }

  const viewer: Viewer = { isAdmin: session?.user.isAdmin === true, adminExists: session?.adminExists === true }
  if (session && session.connections.length === 0 && !account) return <Onboarding email={session.user.email} viewer={viewer} onSignOut={signOut} />
  if (!session || (!tenant && !account)) {
    return (
      <p role="status" className="p-6 text-sm text-ink-2">
        Opening connection…
      </p>
    )
  }

  const active = NAV.find(([p]) => p === base)?.[0] ?? null

  return (
    <div className="min-h-dvh md:grid md:grid-cols-[var(--spacing-rail)_minmax(0,1fr)]">
      <div className="md:border-r md:border-rule md:bg-rail">
        <a href="#main" onClick={(e) => { e.preventDefault(); document.getElementById('main')?.focus() }} className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:bg-raised focus:p-2">
          Skip to content
        </a>
        <header className="sticky top-0 z-30 border-b border-rule bg-rail md:flex md:h-dvh md:flex-col md:border-b-0">
          <div className="flex h-12 items-center justify-between gap-3 px-3 md:h-13 md:px-4">
            <a href={`#${at('/')}`} className="flex items-center gap-2 text-ink no-underline hover:text-ink">
              <RelayMark className="size-5" />
              <span className="font-semibold tracking-tight">Relay</span>
            </a>
            <button
              type="button"
              className="btn btn-icon btn-quiet md:hidden"
              aria-expanded={menuOpen}
              aria-controls="rail-nav"
              aria-label={menuOpen ? 'Close menu' : 'Open menu'}
              onClick={() => setMenuOpen((o) => !o)}
            >
              <Icon name={menuOpen ? 'close' : 'menu'} />
            </button>
          </div>
          {tenant ? (
            <div className={cx('md:block', menuOpen ? 'block' : 'hidden')}>
              <Switcher connections={session.connections} current={tenant} />
            </div>
          ) : null}
          <div id="rail-nav" className={cx('flex-1 flex-col justify-between gap-6 px-2 pb-3 md:flex', menuOpen ? 'flex' : 'hidden')}>
            <nav aria-label="Main">
              {tenant ? null : (
                <a href="#/new" className="flex h-7 items-center gap-2.5 rounded-ctl px-2 font-medium text-ink-2 no-underline hover:bg-hover hover:text-ink">
                  <Icon name="plus" className="size-4 text-ink-3" />
                  Add a connection
                </a>
              )}
              <ul className={cx('flex flex-col gap-px', !tenant && 'hidden')}>
                {NAV.map(([p, label, icon]) => (
                  <li key={p}>
                    <a
                      href={`#${at(p)}`}
                      aria-current={active === p ? 'page' : undefined}
                      className={cx(
                        'flex h-7 items-center gap-2.5 rounded-ctl px-2 font-medium no-underline',
                        active === p ? 'bg-hover text-ink hover:text-ink' : 'text-ink-2 hover:bg-hover hover:text-ink',
                      )}
                    >
                      <Icon name={icon} className={cx('size-4', active === p ? 'text-accent' : 'text-ink-3')} />
                      {label}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
            <div className="flex flex-col gap-2 border-t border-rule pt-3">
              {viewer.isAdmin ? (
                <a
                  href="#/settings"
                  aria-current={settings ? 'page' : undefined}
                  className={cx(
                    'flex h-7 items-center gap-2.5 rounded-ctl px-2 font-medium no-underline',
                    settings ? 'bg-hover text-ink hover:text-ink' : 'text-ink-2 hover:bg-hover hover:text-ink',
                  )}
                >
                  <Icon name="settings" className={cx('size-4', settings ? 'text-accent' : 'text-ink-3')} />
                  Settings
                </a>
              ) : null}
              <p className="truncate px-2 text-xs text-ink-3" title={session.user.email}>
                {session.user.email}
              </p>
              <ThemeSwitch />
              <button type="button" className="btn btn-quiet justify-start px-2" onClick={signOut}>
                <Icon name="exit" className="size-3.5" />
                Sign out
              </button>
            </div>
          </div>
        </header>
      </div>
      <main id="main" tabIndex={-1} className={cx('min-w-0 px-4 py-3 outline-none md:px-6 md:py-4', event && !account && 'xl:mr-panel')}>
        <div key={account ? 'account' : tenant?.id} className="mx-auto max-w-[90rem]">
          {newFlow ? <NewFlow path={path} viewer={viewer} /> : settings ? <Integrations /> : view(base, event, viewer)}
        </div>
      </main>
      {event && tenant && !account ? <EventPanel key={tenant.id} id={event} onClose={closePanel} /> : null}
    </div>
  )
}
