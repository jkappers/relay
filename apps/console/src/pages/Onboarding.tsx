import { Icon, RelayMark } from '../icons'
import type { Viewer } from '../connect-wizard'
import { ProviderList } from './new/parts'
import { useInstalls } from './connection-forms'

export function Onboarding({ email, viewer, onSignOut }: { email: string; viewer: Viewer; onSignOut: () => void }) {
  const installs = useInstalls()

  return (
    <div className="grid min-h-dvh grid-rows-[auto_1fr] bg-ground">
      <header className="flex h-12 items-center justify-between gap-3 border-b border-rule bg-rail px-4">
        <span className="flex items-center gap-2">
          <RelayMark className="size-5" />
          <span className="font-semibold tracking-tight">Relay</span>
        </span>
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate text-xs text-ink-3">{email}</span>
          {viewer.isAdmin ? (
            <a className="btn btn-quiet btn-sm" href="#/settings">
              <Icon name="settings" className="size-3.5" />
              Settings
            </a>
          ) : null}
          <button type="button" className="btn btn-quiet btn-sm" onClick={onSignOut}>
            <Icon name="exit" className="size-3.5" />
            Sign out
          </button>
        </span>
      </header>
      <main id="main" tabIndex={-1} className="mx-auto w-full max-w-xl px-4 pt-[10vh] pb-10 outline-none">
        <h1 className="text-lg font-semibold tracking-tight">Add a connection</h1>
        <p className="mt-1 max-w-[60ch] text-ink-2">
          A connection is a line that brings events in. Its routes, destinations, and events belong to it alone. Add one to start.
        </p>
        <div className="mt-4">
          <ProviderList installs={installs} viewer={viewer} />
        </div>
      </main>
    </div>
  )
}
