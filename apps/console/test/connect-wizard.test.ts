import { describe, expect, it } from 'vitest'
import { discordInvitePath, discordLinkPath, guard, isNewPath, newPath, oauthStartPath, parseNewPath, providerCards, type NewRoute } from '../src/connect-wizard'

const ready = { slack: '/oauth/slack/start', discord: '/oauth/discord/start' }
const none = { slack: null, discord: null }
const admin = { isAdmin: true, adminExists: true }
const member = { isAdmin: false, adminExists: true }
const orphan = { isAdmin: false, adminExists: false }

const ROUTES: NewRoute[] = [
  { kind: 'pick' },
  { kind: 'connect', provider: 'slack' },
  { kind: 'connect', provider: 'discord' },
  { kind: 'setup', provider: 'slack' },
  { kind: 'setup', provider: 'discord' },
  { kind: 'servers', provider: 'discord', grant: 'eyJ1IjoiYSJ9.abc_-123' },
  { kind: 'form', provider: 'sms' },
  { kind: 'form', provider: 'webhook' },
]

describe('paths', () => {
  it.each(ROUTES)('round trips %j', (route) => {
    expect(parseNewPath(newPath(route))).toEqual(route)
  })

  it.each(['/new/', '/new/other', '/new/sms/setup', '/new/webhook/setup', '/new/slack/setup/x', '/new/discord/servers', '/new/discord/servers/', '/new/slack/servers/abc', '/new/discord/servers/a/b', '/new/discord/servers/a b', '/newer', '/settings', '/'])(
    'rejects %s',
    (path) => {
      expect(parseNewPath(path)).toBeNull()
    },
  )

  it('knows which paths belong to the wizard', () => {
    expect(isNewPath('/new')).toBe(true)
    expect(isNewPath('/new/sms')).toBe(true)
    expect(isNewPath('/newer')).toBe(false)
  })
})

describe('guard', () => {
  const connect: NewRoute = { kind: 'connect', provider: 'slack' }
  const setup: NewRoute = { kind: 'setup', provider: 'slack' }

  it('sends an admin from connect to setup when the app is not set up', () => {
    expect(guard(connect, none, admin)).toEqual(setup)
  })

  it('leaves connect alone when the app is set up', () => {
    expect(guard(connect, ready, admin)).toEqual(connect)
    expect(guard(connect, ready, member)).toEqual(connect)
  })

  it('leaves connect alone for members, who see a hint there', () => {
    expect(guard(connect, none, member)).toEqual(connect)
    expect(guard(connect, none, orphan)).toEqual(connect)
  })

  it('does not move before installs load', () => {
    expect(guard(connect, null, admin)).toEqual(connect)
  })

  it('keeps admins on setup, even once the app is set up', () => {
    expect(guard(setup, none, admin)).toEqual(setup)
    expect(guard(setup, ready, admin)).toEqual(setup)
  })

  it('sends non-admins from setup to connect', () => {
    expect(guard(setup, none, member)).toEqual(connect)
    expect(guard(setup, null, orphan)).toEqual(connect)
  })

  it('never moves the picker or the forms', () => {
    for (const r of ROUTES.filter((r) => r.kind === 'pick' || r.kind === 'form')) expect(guard(r, none, member)).toEqual(r)
  })

  it('treats the server picker like connect', () => {
    const servers: NewRoute = { kind: 'servers', provider: 'discord', grant: 'g.m' }
    expect(guard(servers, ready, member)).toEqual(servers)
    expect(guard(servers, null, member)).toEqual(servers)
    expect(guard(servers, none, admin)).toEqual({ kind: 'setup', provider: 'discord' })
    expect(guard(servers, none, member)).toEqual({ kind: 'connect', provider: 'discord' })
  })
})

describe('providerCards', () => {
  it('lists the four providers in order', () => {
    expect(providerCards(ready, admin).map((c) => c.id)).toEqual(['slack', 'discord', 'sms', 'webhook'])
  })

  it('flags only unconfigured OAuth providers, with the hint for this viewer', () => {
    const by = (v: typeof admin) => Object.fromEntries(providerCards({ slack: null, discord: ready.discord }, v).map((c) => [c.id, c.needsSetup]))
    expect(by(admin)).toEqual({ slack: 'set_up', discord: null, sms: null, webhook: null })
    expect(by(member).slack).toBe('ask_admin')
    expect(by(orphan).slack).toBe('no_admin')
  })

  it('flags nothing before installs load', () => {
    expect(providerCards(null, member).every((c) => c.needsSetup === null)).toBe(true)
  })
})

it('oauthStartPath', () => {
  expect(oauthStartPath('slack')).toBe('/oauth/slack/start')
})

it('discord easy-connect paths', () => {
  expect(discordLinkPath()).toBe('/oauth/discord/start?step=identify')
  expect(discordInvitePath('2909267986347357250')).toBe('/oauth/discord/start?guild_id=2909267986347357250')
})
