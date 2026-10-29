import type { Context } from 'hono'
import {
  activeSlackSigningSecrets,
  log,
  schema,
  type ConnectionStore,
  type Db,
  type DiscordAppConfig,
  type ProviderAppId,
  type ProviderAppConfigs,
  type ProviderAppStore,
  type SlackAppConfig,
} from '@relay/core'
import { createSlackAdapter } from '@relay/provider-slack'
import { ingressHandler, type IngressDeps } from './ingress'
import type { ServerMetrics } from './metrics'
import { discordOAuthProvider, slackOAuthProvider, type OAuthProvider, type OAuthResolution } from './oauth'

export const SIGNED_OK_WRITE_INTERVAL_MS = 60_000

export interface LiveAppsDeps {
  db: Db
  store: ProviderAppStore
  connections: ConnectionStore
  metrics: ServerMetrics
  ingress: IngressDeps
  nowSeconds: () => number
  discordApiBase?: string | undefined
  discordBotToken?: () => Promise<string | undefined>
  fetch?: typeof fetch | undefined
}

type Ready<C> = { kind: 'ready'; config: C; key: string } | { kind: 'missing' } | { kind: 'invalid' }

/** Keeps the one value built for the newest settings version of a provider. */
function latest<T>() {
  let held: { key: string; value: T } | null = null
  return (key: string, build: () => T): T => {
    if (held?.key !== key) held = { key, value: build() }
    return held.value
  }
}

const discordOAuthReady = (c: DiscordAppConfig): c is DiscordAppConfig & { clientId: string; clientSecret: string } => !!c.clientId && !!c.clientSecret

/**
 * Builds Slack ingress and the OAuth providers from the app settings in force for each request,
 * so a change saved in the console applies within the store TTL, without a restart.
 */
export function createLiveApps(deps: LiveAppsDeps) {
  const { store, metrics } = deps
  const fetchOpt = deps.fetch ? { fetch: deps.fetch } : {}
  const slackBundle = latest<{ handle: (c: Context) => Promise<Response>; oauth: OAuthProvider }>()
  const discordBundle = latest<OAuthProvider>()
  let lastSignedWriteMs = Number.NEGATIVE_INFINITY

  async function current<P extends ProviderAppId>(provider: P): Promise<Ready<ProviderAppConfigs[P]>> {
    const got = await store.get(provider)
    if (got.state === 'missing') return { kind: 'missing' }
    if (got.state === 'invalid') {
      metrics.providerAppConfigErrors.inc({ provider, reason: 'unavailable' })
      return { kind: 'invalid' }
    }
    return { kind: 'ready', config: got.config, key: `${got.source}:${got.version}` }
  }

  function markSlackSigned() {
    const nowMs = deps.nowSeconds() * 1000
    if (nowMs - lastSignedWriteMs < SIGNED_OK_WRITE_INTERVAL_MS) return
    lastSignedWriteMs = nowMs
    const at = new Date(nowMs)
    const { providerAppStatus } = schema
    deps.db
      .insert(providerAppStatus)
      .values({ provider: 'slack', state: 'ready', lastSignedOkAt: at, updatedAt: at })
      .onConflictDoUpdate({ target: providerAppStatus.provider, set: { lastSignedOkAt: at, updatedAt: at } })
      .catch((err: unknown) => log.warn('could not record the last signed Slack request', { err: err instanceof Error ? err.message : String(err) }))
  }

  function buildSlack(config: SlackAppConfig) {
    const adapter = createSlackAdapter({
      signingSecrets: async () => activeSlackSigningSecrets(config, new Date(deps.nowSeconds() * 1000)),
      connections: deps.connections,
      nowSeconds: deps.nowSeconds,
      onVerified: (index) => {
        if (index > 0) metrics.slackSignaturePrevious.inc({})
        markSlackSigned()
      },
    })
    return {
      handle: ingressHandler(adapter, deps.ingress),
      oauth: slackOAuthProvider({ clientId: config.clientId, clientSecret: config.clientSecret, allowedUserIds: config.allowedUserIds, connections: deps.connections, ...fetchOpt }),
    }
  }

  async function slack() {
    const got = await current('slack')
    return got.kind === 'ready' ? { kind: 'ready' as const, bundle: slackBundle(got.key, () => buildSlack(got.config)) } : got
  }

  async function discord(): Promise<OAuthResolution> {
    const got = await current('discord')
    if (got.kind !== 'ready') return got
    const config = got.config
    if (!discordOAuthReady(config)) return { kind: 'missing' }
    const provider = discordBundle(got.key, () =>
      discordOAuthProvider({
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        allowedUserIds: config.allowedUserIds,
        connections: deps.connections,
        ...(deps.discordBotToken ? { botToken: deps.discordBotToken } : {}),
        ...(deps.discordApiBase ? { apiBase: deps.discordApiBase } : {}),
        ...fetchOpt,
      }),
    )
    return { kind: 'ready', provider }
  }

  return {
    async slackIngress(c: Context): Promise<Response> {
      const got = await slack()
      if (got.kind === 'missing') return c.notFound()
      if (got.kind === 'invalid') return c.text('Slack is not available: its app settings need attention', 503)
      return got.bundle.handle(c)
    },

    async slackOAuth(): Promise<OAuthResolution> {
      const got = await slack()
      return got.kind === 'ready' ? { kind: 'ready', provider: got.bundle.oauth } : got
    },

    discordOAuth: discord,

    /** Which OAuth installs can start right now. */
    async enabled(): Promise<{ slack: boolean; discord: boolean }> {
      const [s, d] = await Promise.all([store.get('slack'), store.get('discord')])
      return {
        slack: s.state === 'ready',
        discord: d.state === 'ready' && discordOAuthReady(d.config),
      }
    },
  }
}
