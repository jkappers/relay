import { useCallback, useEffect, useState } from 'react'
import { del, get, UNAUTHORIZED_EVENT } from './api'
import { cx } from './components'
import { navigate, useHashPath } from './hooks'
import { Icon, RelayMark, type IconName } from './icons'
import { Connections } from './pages/Connections'
import { Deliveries } from './pages/Deliveries'
import { Destinations } from './pages/Destinations'
import { EventPage, Events } from './pages/Events'
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

function view(path: string) {
  const event = /^\/events\/([0-9a-f-]{36})$/.exec(path)
  if (event?.[1]) return <EventPage id={event[1]} />
  switch (path) {
    case '/connections':
      return <Connections />
    case '/destinations':
      return <Destinations />
    case '/routes':
      return <Routes />
    case '/events':
      return <Events />
    case '/deliveries':
      return <Deliveries />
    default:
      return <Overview />
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
    <fieldset className="min-w-0">
      <legend className="label mb-1.5">Theme</legend>
      <div className="grid grid-cols-3 border border-edge bg-ground">
        {THEMES.map(([value, label, icon]) => (
          <label
            key={value}
            title={label}
            className={cx(
              'flex h-8 cursor-pointer items-center justify-center gap-1 border-l border-rule text-xs font-bold first:border-l-0 has-[:focus-visible]:outline-2 has-[:focus-visible]:-outline-offset-2 has-[:focus-visible]:outline-accent',
              theme === value ? 'bg-accent text-accent-ink' : 'text-ink-2 hover:bg-raised',
            )}
          >
            <input type="radio" name="theme" value={value} checked={theme === value} onChange={() => setTheme(value)} className="sr-only" />
            <Icon name={icon} className="size-3.5" />
            <span className="sr-only">{label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  )
}

export function App() {
  const path = useHashPath()
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
  }, [path])

  if (authed === null) {
    return (
      <p role="status" className="p-6 text-sm text-ink-2">
        Checking session…
      </p>
    )
  }
  if (!authed) return <Login onLogin={() => setAuthed(true)} />

  const active = NAV.find(([p]) => p !== '/' && (path === p || path.startsWith(`${p}/`)))?.[0] ?? (path === '/' ? '/' : null)

  const signOut = async () => {
    await del('/api/session').catch(() => undefined)
    setAuthed(false)
    navigate('/login')
  }

  return (
    <div className="min-h-dvh md:grid md:grid-cols-[var(--spacing-rail)_minmax(0,1fr)]">
      <div className="md:border-r md:border-edge md:bg-rail">
        <a href="#main" onClick={(e) => { e.preventDefault(); document.getElementById('main')?.focus() }} className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:bg-raised focus:p-2">
          Skip to content
        </a>
        <header className="sticky top-0 z-30 border-b border-edge bg-rail md:flex md:h-dvh md:flex-col md:border-b-0">
          <div className="flex h-14 items-center justify-between gap-3 px-4 md:h-16">
            <a href="#/" className="flex items-center gap-2 text-ink no-underline hover:text-ink">
              <RelayMark />
              <span className="text-base font-bold tracking-tight">Relay</span>
            </a>
            <button
              type="button"
              className="btn btn-icon md:hidden"
              aria-expanded={menuOpen}
              aria-controls="rail-nav"
              aria-label={menuOpen ? 'Close menu' : 'Open menu'}
              onClick={() => setMenuOpen((o) => !o)}
            >
              <Icon name={menuOpen ? 'close' : 'menu'} />
            </button>
          </div>
          <div id="rail-nav" className={cx('flex-1 flex-col justify-between gap-6 px-3 pb-4 md:flex', menuOpen ? 'flex' : 'hidden')}>
            <nav aria-label="Main">
              <ul className="flex flex-col gap-0.5">
                {NAV.map(([p, label, icon]) => (
                  <li key={p}>
                    <a
                      href={`#${p}`}
                      aria-current={active === p ? 'page' : undefined}
                      className={cx(
                        'flex h-9 items-center gap-2.5 px-2.5 text-sm font-bold no-underline',
                        active === p ? 'bg-accent-wash text-ink hover:text-ink' : 'text-ink-2 hover:bg-raised hover:text-ink',
                      )}
                    >
                      <Icon name={icon} className={cx('size-4', active === p ? 'text-accent' : '')} />
                      {label}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
            <div className="flex flex-col gap-4 border-t border-rule pt-4">
              <ThemeSwitch />
              <button type="button" className="btn justify-start" onClick={signOut}>
                <Icon name="exit" className="size-3.5" />
                Sign out
              </button>
            </div>
          </div>
        </header>
      </div>
      <main id="main" tabIndex={-1} className="min-w-0 px-4 py-5 outline-none md:px-8 md:py-7">
        <div className="mx-auto max-w-[78rem]">{view(path)}</div>
      </main>
    </div>
  )
}
