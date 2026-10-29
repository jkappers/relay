import { describe, expect, it } from 'vitest'
import { discordAppInput, MAX_ALLOWED_USER_IDS, slackAppInput } from '@relay/core'
import { SLACK_USER_SCOPES as SERVER_SCOPES } from '../../../packages/providers/slack/src/oauth'
import {
  badgeOf,
  clientIdConflict,
  confirmMatches,
  conflictText,
  emptyForm,
  formBody,
  formProblems,
  gatewayLine,
  MAX_MEMBERS,
  publicUrlWarning,
  secretMode,
  secretNote,
  setupHint,
  SLACK_USER_SCOPES,
  slackManifest,
  slackManifestLink,
  sourceText,
  testSummary,
  validationText,
  type AppForm,
  type ProviderId,
  type ProviderView,
} from '../src/integrations'

const SLACK_ID = '1111111111.2222222222'
const DISCORD_ID = '110000000000000001'

const view = (provider: ProviderId, o: Partial<ProviderView> = {}): ProviderView => ({
  provider,
  state: 'needs_setup',
  source: null,
  version: 0,
  clientId: null,
  secrets: {},
  allowedUserIds: [],
  updatedAt: null,
  updatedBy: null,
  urls: provider === 'slack' ? { redirect: 'https://r.example/oauth/slack/callback', events: 'https://r.example/hooks/slack' } : { redirect: 'https://r.example/oauth/discord/callback' },
  status: null,
  connections: 0,
  ...o,
})

const saved = (provider: ProviderId, o: Partial<ProviderView> = {}) =>
  view(provider, {
    state: 'ready',
    source: 'db',
    version: 3,
    clientId: provider === 'slack' ? SLACK_ID : DISCORD_ID,
    updatedAt: '2026-10-01T00:00:00.000Z',
    updatedBy: 'admin@example.com',
    secrets: Object.fromEntries(
      (provider === 'slack' ? ['clientSecret', 'signingSecret'] : ['clientSecret', 'botToken']).map((f) => [
        f,
        { set: true, source: 'db', updatedAt: '2026-10-01T00:00:00.000Z', updatedBy: 'admin@example.com' },
      ]),
    ),
    ...o,
  })

const form = (provider: ProviderId, o: Partial<AppForm> = {}): AppForm => ({
  clientId: provider === 'slack' ? SLACK_ID : DISCORD_ID,
  secrets: {},
  who: 'anyone',
  members: '',
  ...o,
})

const schemaFor = (p: ProviderId) => (p === 'slack' ? slackAppInput : discordAppInput)

describe('settings form', () => {
  it('leaves blank secrets out so the stored ones stay, and never prefills them', () => {
    const v = saved('slack')
    expect(emptyForm(v)).toEqual({ clientId: SLACK_ID, secrets: {}, who: 'anyone', members: '' })
    expect(formBody('slack', form('slack', { secrets: { clientSecret: '  ', signingSecret: 'new-signing-secret ' } }))).toEqual({
      clientId: SLACK_ID,
      signingSecret: 'new-signing-secret',
      allowedUserIds: [],
    })
    expect(formProblems('slack', v, form('slack'))).toEqual([])
  })

  it('needs every secret on the first save in Relay, even when the server environment has them', () => {
    const env = view('discord', {
      state: 'ready',
      source: 'env',
      clientId: DISCORD_ID,
      secrets: { clientSecret: { set: true, source: 'env', updatedAt: null, updatedBy: null }, botToken: { set: true, source: 'env', updatedAt: null, updatedBy: null } },
    })
    expect(secretMode(env, 'botToken')).toBe('required')
    expect(formProblems('discord', env, form('discord'))).toEqual(['Client secret is required.', 'Bot token is required.'])
    expect(secretMode(saved('discord'), 'botToken')).toBe('keep')
    expect(sourceText(env)).toBe('From server environment')
    expect(sourceText(saved('discord'))).toBe('Set in Relay')
  })

  it('maps who can connect to the allow-list', () => {
    expect(formBody('slack', form('slack', { who: 'anyone', members: 'U1AAA' })).allowedUserIds).toEqual([])
    expect(formBody('slack', form('slack', { who: 'only', members: 'U1AAA, U2BBB\nU1AAA' })).allowedUserIds).toEqual(['U1AAA', 'U2BBB'])
    expect(emptyForm(saved('slack', { allowedUserIds: ['U1AAA', 'U2BBB'] }))).toMatchObject({ who: 'only', members: 'U1AAA\nU2BBB' })
    expect(formProblems('slack', saved('slack'), form('slack', { who: 'only', members: ' ' }))[0]).toMatch(/at least one/)
  })

  it('adds confirmClientIdChange only when confirmed', () => {
    expect(formBody('discord', form('discord'))).not.toHaveProperty('confirmClientIdChange')
    expect(formBody('discord', form('discord'), true)).toMatchObject({ confirmClientIdChange: true })
  })

  it('uses the server limit for member IDs', () => {
    expect(MAX_MEMBERS).toBe(MAX_ALLOWED_USER_IDS)
  })

  it.each<[string, ProviderId, Partial<AppForm>, boolean]>([
    ['slack, all secrets', 'slack', { secrets: { clientSecret: 'abcdefgh1', signingSecret: 'abcdefgh2' } }, true],
    ['slack, bad client id', 'slack', { clientId: '12345', secrets: { clientSecret: 'abcdefgh1', signingSecret: 'abcdefgh2' } }, true],
    ['slack, short secret', 'slack', { secrets: { clientSecret: 'short', signingSecret: 'abcdefgh2' } }, true],
    ['slack, secret with a space', 'slack', { secrets: { clientSecret: 'abcd efgh', signingSecret: 'abcdefgh2' } }, true],
    ['slack, lower-case member', 'slack', { who: 'only', members: 'u1abc', secrets: { clientSecret: 'abcdefgh1', signingSecret: 'abcdefgh2' } }, true],
    ['slack, good members', 'slack', { who: 'only', members: 'U1ABC W2DEF', secrets: { clientSecret: 'abcdefgh1', signingSecret: 'abcdefgh2' } }, true],
    ['discord, all secrets', 'discord', { secrets: { clientSecret: 'abcdefgh1', botToken: 'abc.def.ghi' } }, true],
    ['discord, short client id', 'discord', { clientId: '1234', secrets: { clientSecret: 'abcdefgh1', botToken: 'abc.def.ghi' } }, true],
    ['discord, bad member', 'discord', { who: 'only', members: 'U1ABC', secrets: { clientSecret: 'abcdefgh1', botToken: 'abc.def.ghi' } }, true],
    ['slack, blank secrets on edit', 'slack', {}, false],
    ['discord, blank secrets on edit', 'discord', {}, false],
  ])('agrees with the server schema: %s', (_, p, o, first) => {
    const f = form(p, o)
    const v = first ? view(p) : saved(p)
    expect(formProblems(p, v, f).length === 0).toBe(schemaFor(p).safeParse(formBody(p, f)).success)
  })

  it('names fields from a 400 without echoing values', () => {
    expect(validationText({ error: 'validation', fields: ['clientId', 'botToken', 'allowedUserIds.0'] })).toBe('Check these and try again: Client ID, Bot token, Member IDs.')
    expect(validationText({ error: 'validation' })).toBeNull()
  })

  it('formats who set a secret and when', () => {
    expect(secretNote({ set: true, source: 'db', updatedAt: '2026-10-01T00:00:00.000Z', updatedBy: 'a@b.c' }, () => 'Oct 1')).toBe('Set on Oct 1 by a@b.c')
    expect(secretNote({ set: true, source: 'env', updatedAt: null, updatedBy: null }, () => 'x')).toBe('From server environment')
    expect(secretNote(undefined, () => 'x')).toBe('Not set')
  })
})

describe('status', () => {
  it('derives the badge', () => {
    expect(badgeOf(view('slack'))).toBe('needs_setup')
    expect(badgeOf(saved('slack'))).toBe('ready')
    expect(badgeOf(saved('slack', { state: 'invalid', invalidReason: 'decrypt' }))).toBe('problem')
    const status = { lastReadyAt: null, lastCloseCode: 4004, lastSignedOkAt: null, updatedAt: '2026-10-01T00:00:00.000Z' }
    expect(badgeOf(saved('discord', { status: { ...status, state: 'auth_failed' } }))).toBe('problem')
    expect(badgeOf(saved('discord', { status: { ...status, state: 'reconnecting' } }))).toBe('ready')
  })

  it('describes the Discord bot', () => {
    const status = { lastReadyAt: null, lastCloseCode: null, lastSignedOkAt: null, updatedAt: '2026-10-01T00:00:00.000Z' }
    expect(gatewayLine(saved('slack'))).toBeNull()
    expect(gatewayLine(view('discord'))).toBeNull()
    expect(gatewayLine(saved('discord'))?.tone).toBe('off')
    expect(gatewayLine(saved('discord', { status: { ...status, state: 'ready' } }))).toEqual({ tone: 'ok', text: 'Bot online' })
    expect(gatewayLine(saved('discord', { status: { ...status, state: 'auth_failed', lastCloseCode: 4004 } }))).toEqual({
      tone: 'bad',
      text: 'Discord rejected the bot token (code 4004)',
    })
  })

  it('warns about a public address Slack and Discord cannot reach', () => {
    expect(publicUrlWarning({ publicUrl: 'https://relay.example', warnings: [] })).toBeNull()
    expect(publicUrlWarning({ publicUrl: 'http://localhost:3000', warnings: ['not_https', 'localhost'] })).toMatch(/only works on this computer/)
    expect(publicUrlWarning({ publicUrl: 'http://relay.example', warnings: ['not_https'] })).toMatch(/not https/)
    expect(publicUrlWarning({ publicUrl: 'nope', warnings: ['invalid'] })).toMatch(/not a valid/)
  })
})

describe('client ID change', () => {
  it('reads the 409 and ignores other errors', () => {
    expect(clientIdConflict(409, { error: 'client_id_change', connections: 3 })).toBe(3)
    expect(clientIdConflict(409, { error: 'other', connections: 3 })).toBeNull()
    expect(clientIdConflict(400, { error: 'client_id_change', connections: 3 })).toBeNull()
    expect(clientIdConflict(409, null)).toBeNull()
  })

  it('unlocks only when the provider name is typed', () => {
    expect(confirmMatches('discord', '')).toBe(false)
    expect(confirmMatches('discord', 'discor')).toBe(false)
    expect(confirmMatches('discord', 'slack')).toBe(false)
    expect(confirmMatches('discord', ' Discord ')).toBe(true)
    expect(confirmMatches('slack', 'slack')).toBe(true)
    expect(conflictText('slack', 1)).toBe('1 connection will stop working and must reconnect. Type Slack to continue.')
    expect(conflictText('discord', 4)).toBe('4 connections will stop working and must reconnect. Type Discord to continue.')
  })
})

describe('test results', () => {
  it('puts each check in plain words', () => {
    const s = testSummary('slack', {
      provider: 'slack',
      ok: true,
      result: 'ok',
      checks: [
        { check: 'client_id', result: 'ok' },
        { check: 'client_secret', result: 'ok' },
        { check: 'signing_secret', result: 'skipped', code: 'not_testable' },
      ],
    })
    expect(s.tone).toBe('ok')
    expect(s.lines.map((l) => l.tone)).toEqual(['ok', 'ok', 'off'])
  })

  it.each<[string, string, RegExp]>([
    ['failed', 'bad_client_secret', /rejected the client secret/],
    ['failed', 'invalid_client_id', /doesn’t recognize this client ID/],
    ['failed', 'app_mismatch', /different Discord app/],
    ['error', 'timeout', /didn’t answer in time/],
    ['error', 'network', /couldn’t reach/],
    ['error', 'http_503', /problem on its side/],
    ['error', 'weird_code', /unexpected answer \(weird_code\)/],
  ])('%s %s', (result, code, text) => {
    const s = testSummary('discord', { provider: 'discord', ok: false, result: result as 'failed', checks: [{ check: 'bot_token', result: result as 'failed', code }] })
    expect(s.lines[0]!.text).toMatch(text)
  })

  it('says to save first when nothing is set up', () => {
    expect(testSummary('discord', { provider: 'discord', ok: false, state: 'needs_setup', checks: [] }).headline).toMatch(/Save the settings first/)
  })
})

describe('setup hints', () => {
  it('tells each viewer what to do', () => {
    expect(setupHint({ isAdmin: true, adminExists: true })).toBe('set_up')
    expect(setupHint({ isAdmin: false, adminExists: true })).toBe('ask_admin')
    expect(setupHint({ isAdmin: false, adminExists: false })).toBe('no_admin')
  })
})

describe('slack manifest', () => {
  it('asks for the same user scopes as the OAuth flow', () => {
    expect([...SLACK_USER_SCOPES]).toEqual([...SERVER_SCOPES])
  })

  it('fills in the Relay addresses and encodes the manifest into the link', () => {
    const urls = { redirect: 'https://r.example/oauth/slack/callback', events: 'https://r.example/hooks/slack' }
    const m = slackManifest(urls)
    expect(m.oauth_config.redirect_urls).toEqual([urls.redirect])
    expect(m.settings.event_subscriptions.request_url).toBe(urls.events)
    const link = new URL(slackManifestLink(urls))
    expect(link.origin + link.pathname).toBe('https://api.slack.com/apps')
    expect(link.searchParams.get('new_app')).toBe('1')
    expect(JSON.parse(link.searchParams.get('manifest_json')!)).toEqual(m)
  })
})
