import { useCallback, useEffect, useState } from 'react'
import { del, get, UNAUTHORIZED_EVENT } from './api'
import { navigate, useHashPath } from './hooks'
import { Connections } from './pages/Connections'
import { Deliveries } from './pages/Deliveries'
import { Destinations } from './pages/Destinations'
import { EventPage, Events } from './pages/Events'
import { Login } from './pages/Login'
import { Overview } from './pages/Overview'
import { Routes } from './pages/Routes'

const NAV = [
  ['/', 'Overview'],
  ['/connections', 'Connections'],
  ['/destinations', 'Destinations'],
  ['/routes', 'Routes'],
  ['/events', 'Events'],
  ['/deliveries', 'Deliveries'],
] as const

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

export function App() {
  const path = useHashPath()
  const [authed, setAuthed] = useState<boolean | null>(null)

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

  if (authed === null) return <p className="muted pad">Loading…</p>
  if (!authed) return <Login onLogin={() => setAuthed(true)} />

  const active = NAV.find(([p]) => p !== '/' && (path === p || path.startsWith(`${p}/`)))?.[0] ?? (path === '/' ? '/' : null)

  return (
    <div className="shell">
      <nav className="nav" aria-label="Main">
        <span className="brand">Relay</span>
        <div className="links">
          {NAV.map(([p, label]) => (
            <a key={p} href={`#${p}`} aria-current={active === p ? 'page' : undefined}>
              {label}
            </a>
          ))}
        </div>
        <button
          onClick={async () => {
            await del('/api/session').catch(() => undefined)
            setAuthed(false)
            navigate('/login')
          }}
        >
          Sign out
        </button>
      </nav>
      <main className="content">{view(path)}</main>
    </div>
  )
}
