import type { InstallUrls } from '../../api'
import { newPath, providerCards, type NewRoute, type Viewer } from '../../connect-wizard'
import type { ReactNode } from 'react'
import { Page } from '../../components'
import { Icon } from '../../icons'

const HINT_TEXT = {
  set_up: 'Needs setup',
  ask_admin: 'Ask your admin',
  no_admin: 'No admin yet',
} as const

export function BackLink({ to, children }: { to: NewRoute | '/'; children: string }) {
  return (
    <a className="btn btn-quiet btn-sm" href={`#${to === '/' ? '/' : newPath(to)}`}>
      <Icon name="back" className="size-3.5" />
      {children}
    </a>
  )
}

/** The provider rows. Each is a link to that provider's page. */
export function ProviderList({ installs, viewer }: { installs: InstallUrls | null; viewer: Viewer }) {
  return (
    <ul aria-label="Providers" className="flex flex-col divide-y divide-rule border-y border-rule">
      {providerCards(installs, viewer).map((c) => (
        <li key={c.id}>
          <a
            href={`#/new/${c.id}`}
            className="flex items-center justify-between gap-4 px-3 py-3 text-ink no-underline hover:bg-raised hover:text-ink"
          >
            <span className="min-w-0">
              <span className="block font-semibold">{c.title}</span>
              <span className="block text-ink-2">{c.blurb}</span>
            </span>
            <span className="flex shrink-0 items-center gap-2 text-xs text-ink-3">
              {c.needsSetup ? <span>{HINT_TEXT[c.needsSetup]}</span> : null}
              <Icon name="back" className="size-3 rotate-180" />
            </span>
          </a>
        </li>
      ))}
    </ul>
  )
}

/** The one shell for every wizard page: title, one intro line, Back, and a single content column. */
export function WizardPage({ title, intro, back, children }: { title: string; intro: ReactNode; back?: NewRoute | '/'; children: ReactNode }) {
  return (
    <Page title={title} actions={back ? <BackLink to={back}>{back === '/' ? 'Cancel' : 'Back'}</BackLink> : undefined}>
      <div className="flex max-w-2xl flex-col gap-4">
        <p className="text-ink-2">{intro}</p>
        {children}
      </div>
    </Page>
  )
}
