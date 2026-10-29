import { useCallback, useEffect, useRef, useState } from 'react'
import { del, get, UNAUTHORIZED_EVENT } from './api'
import { cx } from './components'
import { focusRow, navigate, parseRoute, useHashPath } from './hooks'
import { Icon, RelayMark, type IconName } from './icons'
import { Connections } from './pages/Connections'
import { Deliveries } from './pages/Deliveries'
import { Destinations } from './pages/Destinations'
import { EventPanel, Events } from './pages/Events'
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

function view(path: string, open: string | null) {
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

export function App() {
  const path = useHashPath()
  const { base, event } = parseRoute(path)
  const fromList = useRef(false)
  const prev = useRef(event)
  if (prev.current !== event) {
    fromList.current = event !== null && (prev.current === null || fromList.current)
    prev.current = event
  }
  const [authed, setAuthed] = useState<boolean | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)

  const check = useCallback(() => {
    get('/api/session').then(
      () => setAuthed(true),
      () => setAuthed(false),
    )
  }, [])

  useEffect(() => {
    check()
    const on = () => {
      setAuthed(false)
      navigate('/login')
    }
    window.addEventListener(UNAUTHORIZED_EVENT, on)
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, on)
  }, [check])

  useEffect(() => {
    if (authed === false && path !== '/login') navigate('/login')
    if (authed === true && path === '/login') navigate('/')
  }, [authed, path])

  useEffect(() => {
    setMenuOpen(false)
    document.getElementById('main')?.focus({ preventScroll: true })
    window.scrollTo(0, 0)
  }, [base])

  const closePanel = useCallback(() => {
    if (!event) return
    if (fromList.current) window.history.back()
    else window.location.replace(`#${base}`)
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
  if (!authed) return <Login onLogin={() => setAuthed(true)} />

  const active = NAV.find(([p]) => p === base)?.[0] ?? null

  const signOut = async () => {
    await del('/api/session').catch(() => undefined)
    setAuthed(false)
    navigate('/login')
  }

  return (
    <div className="min-h-dvh md:grid md:grid-cols-[var(--spacing-rail)_minmax(0,1fr)]">
      <div className="md:border-r md:border-rule md:bg-rail">
        <a href="#main" onClick={(e) => { e.preventDefault(); document.getElementById('main')?.focus() }} className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:bg-raised focus:p-2">
          Skip to content
        </a>
        <header className="sticky top-0 z-30 border-b border-rule bg-rail md:flex md:h-dvh md:flex-col md:border-b-0">
          <div className="flex h-12 items-center justify-between gap-3 px-3 md:h-13 md:px-4">
            <a href="#/" className="flex items-center gap-2 text-ink no-underline hover:text-ink">
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
          <div id="rail-nav" className={cx('flex-1 flex-col justify-between gap-6 px-2 pb-3 md:flex', menuOpen ? 'flex' : 'hidden')}>
            <nav aria-label="Main">
              <ul className="flex flex-col gap-px">
                {NAV.map(([p, label, icon]) => (
                  <li key={p}>
                    <a
                      href={`#${p}`}
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
              <ThemeSwitch />
              <button type="button" className="btn btn-quiet justify-start px-2" onClick={signOut}>
                <Icon name="exit" className="size-3.5" />
                Sign out
              </button>
            </div>
          </div>
        </header>
      </div>
      <main id="main" tabIndex={-1} className={cx('min-w-0 px-4 py-3 outline-none md:px-6 md:py-4', event && 'xl:mr-panel')}>
        <div className="mx-auto max-w-[90rem]">{view(base, event)}</div>
      </main>
      {event ? <EventPanel id={event} onClose={closePanel} /> : null}
    </div>
  )
}
