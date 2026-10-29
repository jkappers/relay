import { useState, type FormEvent } from 'react'
import { ApiError, post } from '../api'
import { Field, FormError } from '../components'
import { errorText, navigate } from '../hooks'
import { RelayMark } from '../icons'

const loginError = (e: unknown) => {
  if (e instanceof ApiError && e.status === 429) return 'Too many failed sign-ins from this address. Wait 15 minutes, then try again.'
  if (e instanceof ApiError && e.status === 401) return 'Wrong password. Check it and try again.'
  return errorText(e)
}

export function Login({ onLogin }: { onLogin: () => void }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await post('/api/session', { password })
      onLogin()
      navigate('/')
    } catch (err) {
      setError(loginError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid min-h-dvh grid-rows-[auto_1fr] bg-ground">
      <header className="flex h-12 items-center gap-2 border-b border-rule bg-rail px-4">
        <RelayMark className="size-5" />
        <span className="font-semibold tracking-tight">Relay</span>
      </header>
      <main className="flex items-start justify-center px-4 pt-[14vh] pb-10">
        <form onSubmit={submit} className="w-full max-w-xs rounded-ctl border border-rule bg-raised p-5 shadow-panel">
          <h1 className="text-lg font-semibold tracking-tight">Sign in to the console</h1>
          <p className="mt-1 text-xs text-ink-3">
            Use the password set in <code>CONSOLE_PASSWORD</code> on the server.
          </p>
          <div className="mt-4 flex flex-col gap-3">
            <Field label="Password">
              {(p) => (
                <input
                  {...p}
                  type="password"
                  className="input h-8"
                  autoComplete="current-password"
                  autoFocus
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              )}
            </Field>
            <FormError error={error} />
            <button className="btn btn-primary h-8" disabled={busy || password === ''}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </div>
        </form>
      </main>
    </div>
  )
}
