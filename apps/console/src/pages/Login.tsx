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
      <header className="flex h-14 items-center gap-2 border-b border-edge bg-rail px-4">
        <RelayMark />
        <span className="font-bold tracking-tight">Relay</span>
      </header>
      <main className="flex items-start justify-center px-4 pt-[12vh] pb-10">
        <form onSubmit={submit} className="w-full max-w-sm">
          <h1 className="text-lg font-bold tracking-tight">Sign in to the console</h1>
          <p className="mt-1 text-sm text-ink-2">Use the console password set in CONSOLE_PASSWORD on the server.</p>
          <div className="mt-6 flex flex-col gap-4 border-t border-rule pt-5">
            <Field label="Password">
              {(p) => (
                <input
                  {...p}
                  type="password"
                  className="input h-10"
                  autoComplete="current-password"
                  autoFocus
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              )}
            </Field>
            <FormError error={error} />
            <button className="btn btn-primary h-10" disabled={busy || password === ''}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </div>
        </form>
      </main>
    </div>
  )
}
