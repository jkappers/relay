import { setupHint, type ProviderId, type SetupHint } from './integrations'

/** Which OAuth providers have app settings. Matches `InstallUrls` in api.ts, which this file can't import (it needs the DOM lib). */
type Installs = Record<ProviderId, string | null>

export type WizardProvider = ProviderId | 'sms' | 'webhook'
export type FormProvider = 'sms' | 'webhook'

export type NewRoute =
  | { kind: 'pick' }
  | { kind: 'connect'; provider: ProviderId }
  | { kind: 'setup'; provider: ProviderId }
  | { kind: 'form'; provider: FormProvider }

export interface Viewer {
  isAdmin: boolean
  adminExists: boolean
}

export interface ProviderCard {
  id: WizardProvider
  title: string
  blurb: string
  /** Null when nothing is needed first. */
  needsSetup: SetupHint | null
}

const CARDS: readonly Omit<ProviderCard, 'needsSetup'>[] = [
  { id: 'slack', title: 'Slack', blurb: 'Sign in with Slack. Relay gets your messages and can reply as you.' },
  { id: 'discord', title: 'Discord', blurb: 'Add the Relay bot to a server. It gets DMs and messages that mention it, and replies as the bot.' },
  { id: 'sms', title: 'SMS', blurb: 'A Twilio number. Texts come in, and Relay can reply from the number.' },
  { id: 'webhook', title: 'Signed webhook', blurb: 'For any service that can send an HTTP POST. You get a URL and a signing secret.' },
]

export const isOAuth = (p: WizardProvider): p is ProviderId => p === 'slack' || p === 'discord'

export const isNewPath = (path: string) => path === '/new' || path.startsWith('/new/')

/** A `#/new...` path as a route. Null for anything the wizard doesn't own. */
export function parseNewPath(path: string): NewRoute | null {
  const m = /^\/new(?:\/(slack|discord|sms|webhook)(\/setup)?)?$/.exec(path)
  if (!m) return null
  const provider = m[1] as WizardProvider | undefined
  if (!provider) return { kind: 'pick' }
  if (isOAuth(provider)) return m[2] ? { kind: 'setup', provider } : { kind: 'connect', provider }
  return m[2] ? null : { kind: 'form', provider }
}

export function newPath(route: NewRoute): string {
  switch (route.kind) {
    case 'pick':
      return '/new'
    case 'setup':
      return `/new/${route.provider}/setup`
    default:
      return `/new/${route.provider}`
  }
}

/**
 * Where a route should really land for this viewer: admins go to setup when the app isn't set up,
 * and members can't open setup. Null `installs` means not loaded yet, so nothing moves.
 */
export function guard(route: NewRoute, installs: Installs | null, viewer: Viewer): NewRoute {
  if (route.kind === 'setup' && !viewer.isAdmin) return { kind: 'connect', provider: route.provider }
  if (route.kind === 'connect' && installs && !installs[route.provider] && viewer.isAdmin) return { kind: 'setup', provider: route.provider }
  return route
}

/** Null `installs` means not loaded yet: show OAuth providers as ready so the picker doesn't flash a warning. */
export function providerCards(installs: Installs | null, viewer: Viewer): ProviderCard[] {
  return CARDS.map((c) => ({
    ...c,
    needsSetup: isOAuth(c.id) && installs && !installs[c.id] ? setupHint(viewer) : null,
  }))
}

export const oauthStartPath = (provider: ProviderId) => `/oauth/${provider}/start`
