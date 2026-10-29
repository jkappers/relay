export type ProviderId = 'slack' | 'discord'
export type SecretField = 'clientSecret' | 'signingSecret' | 'botToken'

export const PROVIDER_NAME: Record<ProviderId, string> = { slack: 'Slack', discord: 'Discord' }
export const SECRET_FIELDS: Record<ProviderId, readonly SecretField[]> = {
  slack: ['clientSecret', 'signingSecret'],
  discord: ['clientSecret', 'botToken'],
}
export const SECRET_LABEL: Record<SecretField, string> = { clientSecret: 'Client secret', signingSecret: 'Signing secret', botToken: 'Bot token' }
export const MAX_MEMBERS = 100

export interface SecretInfo {
  set: boolean
  source: 'db' | 'env' | null
  updatedAt: string | null
  updatedBy: string | null
}

export type GatewayState = 'not_configured' | 'connecting' | 'ready' | 'reconnecting' | 'auth_failed' | 'closed' | 'error'

export interface ProviderStatus {
  state: GatewayState
  lastReadyAt: string | null
  lastCloseCode: number | null
  lastSignedOkAt: string | null
  updatedAt: string
}

export interface ProviderView {
  provider: ProviderId
  state: 'ready' | 'needs_setup' | 'invalid'
  source: 'db' | 'env' | null
  invalidReason?: 'decrypt' | 'validate'
  version: number
  clientId: string | null
  secrets: Partial<Record<SecretField, SecretInfo>>
  allowedUserIds: string[]
  updatedAt: string | null
  updatedBy: string | null
  urls: { redirect: string; events?: string }
  status: ProviderStatus | null
  connections: number
}

export interface IntegrationsView {
  publicUrl: string
  warnings: string[]
  providers: Record<ProviderId, ProviderView>
}

export type Who = 'anyone' | 'only'

export interface AppForm {
  clientId: string
  secrets: Partial<Record<SecretField, string>>
  who: Who
  members: string
}

export const emptyForm = (v: ProviderView): AppForm => ({
  clientId: v.clientId ?? '',
  secrets: {},
  who: v.allowedUserIds.length ? 'only' : 'anyone',
  members: v.allowedUserIds.join('\n'),
})

/** Saved settings exist in Relay (not only server env). */
export const savedInRelay = (v: ProviderView) => v.updatedAt !== null

export type SecretMode = 'keep' | 'required'

/** A first save in Relay needs every secret. After that, a blank secret keeps the stored one. */
export function secretMode(v: ProviderView, field: SecretField): SecretMode {
  return savedInRelay(v) && v.secrets[field]?.set ? 'keep' : 'required'
}

export const parseMembers = (s: string): string[] => [...new Set(s.split(/[\s,]+/).filter(Boolean))]

const CLIENT_ID: Record<ProviderId, RegExp> = { slack: /^\d{1,20}\.\d{1,20}$/, discord: /^\d{17,20}$/ }
const MEMBER_ID: Record<ProviderId, RegExp> = { slack: /^[A-Z0-9]{2,32}$/, discord: /^\d{17,20}$/ }
const SECRET = /^[\x21-\x7e]{8,512}$/

export function formProblems(p: ProviderId, v: ProviderView, f: AppForm): string[] {
  const out: string[] = []
  const name = PROVIDER_NAME[p]
  if (!CLIENT_ID[p].test(f.clientId.trim())) {
    out.push(p === 'slack' ? 'Client ID should look like 1234567890.1234567890.' : 'Client ID (Application ID) should be 17 to 20 digits.')
  }
  for (const field of SECRET_FIELDS[p]) {
    const value = (f.secrets[field] ?? '').trim()
    if (!value) {
      if (secretMode(v, field) === 'required') out.push(`${SECRET_LABEL[field]} is required.`)
    } else if (!SECRET.test(value)) out.push(`${SECRET_LABEL[field]} doesn't look right. Copy it again from ${name}.`)
  }
  if (f.who === 'only') {
    const ids = parseMembers(f.members)
    if (ids.length === 0) out.push('Add at least one member ID, or let anyone with a Relay account connect.')
    else if (ids.length > MAX_MEMBERS) out.push(`Add at most ${MAX_MEMBERS} member IDs.`)
    const bad = ids.filter((id) => !MEMBER_ID[p].test(id))
    if (bad.length) out.push(`These don't look like ${name} member IDs: ${bad.slice(0, 5).join(', ')}${bad.length > 5 ? '…' : ''}`)
  }
  return out
}

export interface AppBody {
  clientId: string
  clientSecret?: string
  signingSecret?: string
  botToken?: string
  allowedUserIds: string[]
  confirmClientIdChange?: true
}

/** Blank secrets are left out, so the stored value stays. */
export function formBody(p: ProviderId, f: AppForm, confirmClientIdChange = false): AppBody {
  const body: AppBody = { clientId: f.clientId.trim(), allowedUserIds: f.who === 'only' ? parseMembers(f.members) : [] }
  for (const field of SECRET_FIELDS[p]) {
    const value = (f.secrets[field] ?? '').trim()
    if (value) body[field] = value
  }
  if (confirmClientIdChange) body.confirmClientIdChange = true
  return body
}

export type Badge = 'ready' | 'needs_setup' | 'problem'
export const BADGE_TEXT: Record<Badge, string> = { ready: 'Ready', needs_setup: 'Needs setup', problem: 'Problem' }

export function badgeOf(v: ProviderView): Badge {
  if (v.state === 'invalid') return 'problem'
  if (v.state === 'needs_setup') return 'needs_setup'
  if (v.provider === 'discord' && v.status?.state === 'auth_failed') return 'problem'
  return 'ready'
}

export function problemText(v: ProviderView): string | null {
  if (v.state === 'invalid') {
    return v.invalidReason === 'decrypt'
      ? 'Relay can no longer read the saved settings. This happens when the server’s encryption key changes. Paste the secrets again and save.'
      : 'The saved settings are incomplete or damaged. Paste the secrets again and save.'
  }
  if (v.provider === 'discord' && v.status?.state === 'auth_failed') return 'Discord rejected the bot token. Reset it on the Bot page and paste the new one here.'
  return null
}

export function gatewayLine(v: ProviderView): { tone: 'ok' | 'warn' | 'bad' | 'off'; text: string } | null {
  if (v.provider !== 'discord' || v.state === 'needs_setup') return null
  const s = v.status
  const code = s?.lastCloseCode != null ? ` (code ${s.lastCloseCode})` : ''
  if (!s) return { tone: 'off', text: 'The bot hasn’t reported in yet. Make sure the Discord gateway is running.' }
  switch (s.state) {
    case 'ready':
      return { tone: 'ok', text: 'Bot online' }
    case 'connecting':
      return { tone: 'warn', text: 'Bot connecting' }
    case 'reconnecting':
      return { tone: 'warn', text: `Bot reconnecting${code}` }
    case 'auth_failed':
      return { tone: 'bad', text: `Discord rejected the bot token${code || ' (code 4004)'}` }
    case 'closed':
      return { tone: 'bad', text: `Bot stopped${code}` }
    case 'not_configured':
      return { tone: 'off', text: 'Bot waiting for a bot token' }
    default:
      return { tone: 'bad', text: 'Bot could not connect' }
  }
}

export function publicUrlWarning(view: Pick<IntegrationsView, 'publicUrl' | 'warnings'>): string | null {
  const w = new Set(view.warnings)
  if (w.has('invalid')) return 'Relay’s public address is not a valid web address. Slack and Discord can’t reach Relay until the person who runs the server fixes it.'
  if (w.has('localhost')) return `Relay’s public address is ${view.publicUrl}, which only works on this computer. Slack and Discord can’t reach it. Ask the person who runs the server to give Relay a public https address.`
  if (w.has('not_https')) return `Relay’s public address is ${view.publicUrl}, which is not https. Slack and Discord need https. Ask the person who runs the server to change it.`
  return null
}

export function sourceText(v: ProviderView): string {
  if (v.source === 'db' || savedInRelay(v)) return 'Set in Relay'
  if (v.source === 'env') return 'From server environment'
  return 'Not set'
}

export function secretNote(info: SecretInfo | undefined, fmt: (iso: string) => string): string {
  if (!info?.set) return 'Not set'
  if (info.source === 'env') return 'From server environment'
  const when = info.updatedAt ? ` on ${fmt(info.updatedAt)}` : ''
  const who = info.updatedBy ? ` by ${info.updatedBy}` : ''
  return `Set${when}${who}`
}

/** The 409 for a client ID change. Returns the number of connections that will break, or null for any other error. */
export function clientIdConflict(status: number, body: unknown): number | null {
  if (status !== 409 || typeof body !== 'object' || body === null) return null
  const b = body as { error?: unknown; connections?: unknown }
  return b.error === 'client_id_change' && typeof b.connections === 'number' ? b.connections : null
}

export const confirmWord = (p: ProviderId) => PROVIDER_NAME[p]

export const confirmMatches = (p: ProviderId, typed: string) => typed.trim().toLowerCase() === confirmWord(p).toLowerCase()

export function conflictText(p: ProviderId, n: number): string {
  return `${n} ${n === 1 ? 'connection' : 'connections'} will stop working and must reconnect. Type ${confirmWord(p)} to continue.`
}

/** Field names from a 400 response, in plain words. */
export function validationText(body: unknown): string | null {
  const fields = (body as { fields?: unknown } | null)?.fields
  if (!Array.isArray(fields) || fields.length === 0) return null
  const label = (f: string) =>
    f === 'clientId' ? 'Client ID' : f in SECRET_LABEL ? SECRET_LABEL[f as SecretField] : f.startsWith('allowedUserIds') ? 'Member IDs' : 'A field'
  return `Check these and try again: ${[...new Set(fields.map((f) => label(String(f))))].join(', ')}.`
}

export type CheckName = 'client_id' | 'client_secret' | 'signing_secret' | 'bot_token' | 'application'

export interface TestCheck {
  check: CheckName
  result: 'ok' | 'failed' | 'error' | 'skipped'
  code?: string
}

export interface TestResponse {
  provider: ProviderId
  ok: boolean
  result?: 'ok' | 'failed' | 'error' | 'incomplete'
  state?: 'needs_setup' | 'invalid'
  checks: TestCheck[]
  lastSignedOkAt?: string | null
}

export const CHECK_LABEL: Record<CheckName, string> = {
  client_id: 'Client ID',
  client_secret: 'Client secret',
  signing_secret: 'Signing secret',
  bot_token: 'Bot token',
  application: 'Bot belongs to this app',
}

export type Tone = 'ok' | 'warn' | 'bad' | 'off'

export interface TestLine {
  check: CheckName
  label: string
  tone: Tone
  text: string
}

export interface TestSummary {
  tone: Tone
  headline: string
  lines: TestLine[]
}

function checkText(p: ProviderId, c: TestCheck): [Tone, string] {
  const name = PROVIDER_NAME[p]
  const http = /^http_(\d{3})$/.exec(c.code ?? '')
  if (c.result === 'ok') return ['ok', 'Works']
  if (c.result === 'skipped') {
    if (c.code === 'not_testable') return ['off', 'Can’t be tested directly. See when Relay last accepted a signed request from Slack.']
    if (c.code === 'bot_token') return ['off', 'Not checked, because the bot token didn’t work']
    if (c.code === 'missing_client_id') return ['warn', 'Not checked, because the client ID is missing']
    return ['warn', 'Not set']
  }
  if (c.result === 'failed') {
    if (c.code === 'invalid_client_id') return ['bad', `${name} doesn’t recognize this client ID`]
    if (c.code === 'bad_client_secret') return ['bad', `${name} rejected the client secret`]
    if (c.code === 'app_mismatch') return ['bad', 'The bot token belongs to a different Discord app than this client ID']
    if (c.code === 'invalid_client') return ['bad', `${name} rejected the client ID or client secret`]
    if (http && (http[1] === '401' || http[1] === '403')) return ['bad', `${name} rejected it`]
    return ['bad', `${name} rejected it`]
  }
  if (c.code === 'timeout') return ['warn', `${name} didn’t answer in time. Try again.`]
  if (c.code === 'network') return ['warn', `Relay couldn’t reach ${name}. Check the server’s internet access and try again.`]
  if (http && http[1]!.startsWith('5')) return ['warn', `${name} had a problem on its side. Try again later.`]
  if (http && http[1] === '429') return ['warn', `${name} asked Relay to slow down. Try again in a minute.`]
  return ['warn', `${name} gave an unexpected answer${c.code ? ` (${c.code})` : ''}`]
}

export function testSummary(p: ProviderId, r: TestResponse): TestSummary {
  if (r.state === 'needs_setup') return { tone: 'warn', headline: 'Nothing to test yet. Save the settings first.', lines: [] }
  if (r.state === 'invalid') return { tone: 'bad', headline: 'The saved settings can’t be read. Paste the secrets again and save.', lines: [] }
  const lines = r.checks.map((c) => {
    const [tone, text] = checkText(p, c)
    return { check: c.check, label: CHECK_LABEL[c.check], tone, text }
  })
  const headline =
    r.result === 'ok'
      ? `Everything checks out with ${PROVIDER_NAME[p]}.`
      : r.result === 'failed'
        ? `${PROVIDER_NAME[p]} rejected part of the settings.`
        : r.result === 'incomplete'
          ? 'Some settings are missing.'
          : 'The test couldn’t finish.'
  const tone: Tone = r.result === 'ok' ? 'ok' : r.result === 'failed' ? 'bad' : 'warn'
  return { tone, headline, lines }
}

export type SetupHint = 'set_up' | 'ask_admin' | 'no_admin'

export function setupHint(who: { isAdmin: boolean; adminExists: boolean }): SetupHint {
  if (who.isAdmin) return 'set_up'
  return who.adminExists ? 'ask_admin' : 'no_admin'
}

export const SLACK_USER_SCOPES = ['chat:write', 'im:history', 'channels:history', 'groups:history', 'reactions:write', 'users:read'] as const
export const SLACK_USER_EVENTS = ['message.im', 'message.channels', 'message.groups', 'tokens_revoked'] as const

export function slackManifest(urls: { redirect: string; events?: string }) {
  return {
    _metadata: { major_version: 1 },
    display_information: { name: 'Relay', description: 'Sends your Slack messages to Relay and lets Relay reply as you.' },
    oauth_config: { redirect_urls: [urls.redirect], scopes: { user: [...SLACK_USER_SCOPES] } },
    settings: {
      event_subscriptions: { ...(urls.events ? { request_url: urls.events } : {}), user_events: [...SLACK_USER_EVENTS] },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  }
}

/** Slack's "create app from manifest" link: https://docs.slack.dev/app-manifests/configuring-apps-with-app-manifests */
export const slackManifestLink = (urls: { redirect: string; events?: string }) =>
  `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(slackManifest(urls)))}`
