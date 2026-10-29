import { useState, type FormEvent } from 'react'
import { ApiError, post, type SignupMode } from '../api'
import { Field, FormError } from '../components'
import { errorText } from '../hooks'
import { RelayMark } from '../icons'

const authError = (e: unknown) => {
  if (!(e instanceof ApiError)) return errorText(e)
  if (e.status === 429) return 'Too many tries. Wait 15 minutes, then try again.'
  if (e.status === 401) return 'Wrong email or password. Check them and try again.'
  if (e.status === 409) return 'An account with that email already exists. Sign in instead.'
  if (e.status === 503) return 'Relay is busy checking other sign-ins. Try again in a few seconds.'
  return e.describe()
}

export function Login({ signup, onLogin }: { signup: SignupMode; onLogin: () => void }) {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const creating = mode === 'signup'

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await post(creating ? '/api/users' : '/api/session', { email, password })
      onLogin()
    } catch (err) {
      setError(authError(err))
    } finally {
      setBusy(false)
    }
  }

  const switchTo = (next: 'signin' | 'signup') => {
    setMode(next)
    setError(null)
  }

  return (
    <div className="grid min-h-dvh grid-rows-[auto_1fr] bg-ground">
      <header className="flex h-12 items-center gap-2 border-b border-rule bg-rail px-4">
        <RelayMark className="size-5" />
        <span className="font-semibold tracking-tight">Relay</span>
      </header>
      <main className="flex items-start justify-center px-4 pt-[14vh] pb-10">
        <div className="w-full max-w-xs">
          <form onSubmit={submit} className="rounded-ctl border border-rule bg-raised p-5 shadow-panel">
            <h1 className="text-lg font-semibold tracking-tight">{creating ? 'Create your account' : 'Sign in to Relay'}</h1>
            <p className="mt-1 text-xs text-ink-3">
              {creating ? 'Next, you will add your first connection.' : 'Use the email and password for your Relay account.'}
            </p>
            <div className="mt-4 flex flex-col gap-3">
              <Field label="Email">
                {(p) => (
                  <input
                    {...p}
                    type="email"
                    className="input h-8"
                    autoComplete="username"
                    autoFocus
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                )}
              </Field>
              <Field label="Password" {...(creating ? { hint: 'At least 12 characters.' } : {})}>
                {(p) => (
                  <input
                    {...p}
                    type="password"
                    className="input h-8"
                    autoComplete={creating ? 'new-password' : 'current-password'}
                    required
                    minLength={creating ? 12 : undefined}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                )}
              </Field>
              <FormError error={error} />
              <button className="btn btn-primary h-8" disabled={busy || email === '' || password === ''}>
                {busy ? (creating ? 'Creating…' : 'Signing in…') : creating ? 'Create account' : 'Sign in'}
              </button>
            </div>
          </form>
          {signup === 'open' ? (
            <p className="mt-3 text-center text-xs text-ink-3">
              {creating ? 'Have an account? ' : 'New to Relay? '}
              <button type="button" className="font-medium text-accent underline underline-offset-3 hover:text-accent-hover" onClick={() => switchTo(creating ? 'signin' : 'signup')}>
                {creating ? 'Sign in' : 'Create an account'}
              </button>
            </p>
          ) : null}
        </div>
      </main>
    </div>
  )
}
