import { createHmac } from 'node:crypto'
import { and, count, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { AdminError } from './admin'
import { createCipher, DecryptError, type Cipher } from './crypto'
import type { Db, Tx } from './db/client'
import { connections, providerApps, type ProviderAppRow } from './db/schema'
import { log } from './log'
import type { Counter } from './metrics'

export const PROVIDER_APP_IDS = ['slack', 'discord'] as const
export type ProviderAppId = (typeof PROVIDER_APP_IDS)[number]

export const SIGNING_SECRET_OVERLAP_MS = 24 * 60 * 60 * 1000
export const MAX_ALLOWED_USER_IDS = 100

export interface SlackAppConfig {
  clientId: string
  clientSecret: string
  signingSecret: string
  /** The signing secret before the last change, while it is still accepted. */
  previousSigningSecret: string | null
  previousExpiresAt: Date | null
  allowedUserIds: string[]
}

/** From env, any field may be missing (the worker and gateway only need the bot token). A saved row has all three. */
export interface DiscordAppConfig {
  clientId: string | null
  clientSecret: string | null
  botToken: string | null
  allowedUserIds: string[]
}

export interface ProviderAppConfigs {
  slack: SlackAppConfig
  discord: DiscordAppConfig
}

export interface ProviderAppEnv {
  slack: SlackAppConfig | null
  discord: DiscordAppConfig | null
}

export type ProviderAppSource = 'db' | 'env'
export type ProviderAppInvalidReason = 'decrypt' | 'validate'

export type ProviderAppResult<P extends ProviderAppId = ProviderAppId> =
  | { state: 'ready'; source: ProviderAppSource; config: ProviderAppConfigs[P]; version: number }
  | { state: 'missing'; source: null; config: null; version: 0 }
  | { state: 'invalid'; source: 'db'; config: null; version: number; reason: ProviderAppInvalidReason }

export function deriveProviderAppKey(masterKey: Uint8Array): Buffer {
  return createHmac('sha256', masterKey).update('relay/provider-apps/v1').digest()
}

export function createProviderAppCipher(masterKey: Uint8Array): Promise<Cipher> {
  return createCipher(deriveProviderAppKey(masterKey))
}

const trimmed = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined)

/** Builds the env fallback from already-parsed config values. Slack needs all three settings, as before. */
export function providerAppEnv(input: {
  SLACK_SIGNING_SECRET?: string | undefined
  SLACK_CLIENT_ID?: string | undefined
  SLACK_CLIENT_SECRET?: string | undefined
  SLACK_ALLOWED_USER_IDS?: readonly string[] | undefined
  DISCORD_CLIENT_ID?: string | undefined
  DISCORD_CLIENT_SECRET?: string | undefined
  DISCORD_BOT_TOKEN?: string | undefined
  DISCORD_ALLOWED_USER_IDS?: readonly string[] | undefined
}): ProviderAppEnv {
  const signingSecret = trimmed(input.SLACK_SIGNING_SECRET)
  const slackId = trimmed(input.SLACK_CLIENT_ID)
  const slackSecret = trimmed(input.SLACK_CLIENT_SECRET)
  const discordId = trimmed(input.DISCORD_CLIENT_ID)
  const discordSecret = trimmed(input.DISCORD_CLIENT_SECRET)
  const botToken = trimmed(input.DISCORD_BOT_TOKEN)
  return {
    slack:
      signingSecret && slackId && slackSecret
        ? {
            clientId: slackId,
            clientSecret: slackSecret,
            signingSecret,
            previousSigningSecret: null,
            previousExpiresAt: null,
            allowedUserIds: [...(input.SLACK_ALLOWED_USER_IDS ?? [])],
          }
        : null,
    discord:
      discordId || discordSecret || botToken
        ? {
            clientId: discordId ?? null,
            clientSecret: discordSecret ?? null,
            botToken: botToken ?? null,
            allowedUserIds: [...(input.DISCORD_ALLOWED_USER_IDS ?? [])],
          }
        : null,
  }
}

/** Signing secrets a Slack request may be signed with right now: the current one, then the previous one until it expires. */
export function activeSlackSigningSecrets(config: SlackAppConfig, now: Date = new Date()): string[] {
  const out = [config.signingSecret]
  if (config.previousSigningSecret && config.previousExpiresAt && config.previousExpiresAt.getTime() > now.getTime()) {
    out.push(config.previousSigningSecret)
  }
  return out
}

/** A Discord bot token starts with the bot user id in base64. Returns null if it does not parse. */
export function discordBotIdFromToken(token: string): string | null {
  const head = token.split('.')[0]
  if (!head) return null
  const id = Buffer.from(head, 'base64').toString('utf8')
  return /^\d{17,20}$/.test(id) ? id : null
}

const secret = z.string().regex(/^[\x21-\x7e]{8,512}$/)
const slackClientId = z.string().regex(/^\d{1,20}\.\d{1,20}$/)
const snowflake = z.string().regex(/^\d{17,20}$/)
const slackUserId = z.string().regex(/^[A-Z0-9]{2,32}$/)

const idList = (id: z.ZodString) =>
  z
    .array(z.string().trim().pipe(id))
    .max(MAX_ALLOWED_USER_IDS)
    .transform((ids) => [...new Set(ids)])

const optionalSecret = z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : typeof v === 'string' ? v.trim() : v), secret.optional())

export const slackAppInput = z.strictObject({
  clientId: z.string().trim().pipe(slackClientId),
  clientSecret: optionalSecret,
  signingSecret: optionalSecret,
  allowedUserIds: idList(slackUserId).optional(),
})
export type SlackAppInput = z.input<typeof slackAppInput>

export const discordAppInput = z.strictObject({
  clientId: z.string().trim().pipe(snowflake),
  clientSecret: optionalSecret,
  botToken: optionalSecret,
  allowedUserIds: idList(snowflake).optional(),
})
export type DiscordAppInput = z.input<typeof discordAppInput>

export interface ProviderAppInputs {
  slack: SlackAppInput
  discord: DiscordAppInput
}

const storedSlack = z.object({
  clientId: slackClientId,
  clientSecret: secret,
  signingSecret: secret,
  previousSigningSecret: secret.nullable(),
  previousExpiresAt: z.date().nullable(),
  allowedUserIds: z.array(slackUserId).max(MAX_ALLOWED_USER_IDS),
})

const storedDiscord = z.object({
  clientId: snowflake,
  clientSecret: secret,
  botToken: secret,
  allowedUserIds: z.array(snowflake).max(MAX_ALLOWED_USER_IDS),
})

/** A new row is missing a secret. Lists field names only. */
export class ProviderAppFieldsError extends AdminError {
  override name = 'ProviderAppFieldsError'
  constructor(readonly fields: string[]) {
    super(`missing fields: ${fields.join(', ')}`, 'invalid')
  }
}

/** The change points relay at a different app while connections exist, and was not confirmed. */
export class ClientIdChangeError extends AdminError {
  override name = 'ClientIdChangeError'
  constructor(readonly connections: number) {
    super(`changing the app cuts off ${connections} connection(s); confirm to proceed`, 'conflict')
  }
}

export interface ProviderAppStoreOptions {
  db: Db
  masterKey: Uint8Array
  env: ProviderAppEnv
  /** How long a value is served from memory. Default 5000. */
  ttlMs?: number
  nowMs?: () => number
  counters?: { configErrors: Counter<'provider' | 'reason'> }
}

export interface SaveOptions {
  updatedBy: string | null
  confirmClientIdChange?: boolean
}

export interface SaveResult {
  version: number
  /** Names of the fields this write set. Never values. */
  fields: string[]
}

export interface ProviderAppStore {
  get<P extends ProviderAppId>(provider: P, opts?: { fresh?: boolean }): Promise<ProviderAppResult<P>>
  save<P extends ProviderAppId>(provider: P, input: ProviderAppInputs[P], opts: SaveOptions): Promise<SaveResult>
  /** Deletes the row, so env applies again. Returns false if there was no row. */
  remove(provider: ProviderAppId, opts?: { confirmClientIdChange?: boolean }): Promise<boolean>
  invalidate(provider?: ProviderAppId): void
  activeConnections(provider: ProviderAppId): Promise<number>
}

type Cached = { value: ProviderAppResult; at: number }

export function createProviderAppStore(opts: ProviderAppStoreOptions): ProviderAppStore {
  const { db, env } = opts
  const ttlMs = opts.ttlMs ?? 5000
  const nowMs = opts.nowMs ?? Date.now
  const cipherReady = createProviderAppCipher(opts.masterKey)
  cipherReady.catch(() => {})
  const cache = new Map<ProviderAppId, Cached>()
  const inflight = new Map<ProviderAppId, Promise<ProviderAppResult>>()

  const configError = (provider: ProviderAppId, reason: string) => opts.counters?.configErrors.inc({ provider, reason })

  const fromEnv = (provider: ProviderAppId): ProviderAppResult => {
    const config = env[provider]
    return config ? { state: 'ready', source: 'env', config, version: 0 } : { state: 'missing', source: null, config: null, version: 0 }
  }

  function decode(cipher: Cipher, row: ProviderAppRow): ProviderAppResult {
    const provider = row.provider as ProviderAppId
    const invalid = (reason: ProviderAppInvalidReason): ProviderAppResult => {
      configError(provider, reason)
      log.warn('provider app settings are invalid', { provider, reason })
      return { state: 'invalid', source: 'db', config: null, version: row.version, reason }
    }
    const open = (ct: string | null) => (ct === null ? null : cipher.decrypt(ct))
    let plain: Record<string, unknown>
    try {
      if (provider === 'slack') {
        const live = row.previousExpiresAt !== null && row.previousExpiresAt.getTime() > nowMs()
        plain = {
          clientId: row.clientId,
          clientSecret: open(row.clientSecretCt),
          signingSecret: open(row.signingSecretCt),
          previousSigningSecret: live ? open(row.previousSigningSecretCt) : null,
          previousExpiresAt: live ? row.previousExpiresAt : null,
          allowedUserIds: row.allowedUserIds,
        }
      } else {
        plain = { clientId: row.clientId, clientSecret: open(row.clientSecretCt), botToken: open(row.botTokenCt), allowedUserIds: row.allowedUserIds }
      }
    } catch (err) {
      if (err instanceof DecryptError) return invalid('decrypt')
      throw err
    }
    const parsed = (provider === 'slack' ? storedSlack : storedDiscord).safeParse(plain)
    if (!parsed.success) return invalid('validate')
    return { state: 'ready', source: 'db', config: parsed.data as ProviderAppConfigs[typeof provider], version: row.version }
  }

  async function load(provider: ProviderAppId): Promise<ProviderAppResult> {
    const [row] = await db.select().from(providerApps).where(eq(providerApps.provider, provider))
    if (!row) return fromEnv(provider)
    return decode(await cipherReady, row)
  }

  async function refresh(provider: ProviderAppId): Promise<ProviderAppResult> {
    const running = inflight.get(provider)
    if (running) return running
    const p = (async () => {
      try {
        const value = await load(provider)
        cache.set(provider, { value, at: nowMs() })
        return value
      } catch (err) {
        const last = cache.get(provider)
        configError(provider, 'db')
        log.warn('provider app settings could not be read', { provider, err: err instanceof Error ? err.message : String(err), kept: last !== undefined })
        if (last) return last.value
        throw err
      } finally {
        inflight.delete(provider)
      }
    })()
    inflight.set(provider, p)
    return p
  }

  const countActive = async (q: Pick<Db, 'select'>, provider: ProviderAppId) => {
    const [row] = await q
      .select({ n: count() })
      .from(connections)
      .where(and(eq(connections.provider, provider), eq(connections.status, 'active')))
    return row?.n ?? 0
  }

  const lock = (tx: Tx, provider: ProviderAppId) => tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`relay:provider_apps:${provider}`}))`)

  const tryOpen = (cipher: Cipher, ct: string | null) => {
    if (ct === null) return null
    try {
      return cipher.decrypt(ct)
    } catch {
      return null
    }
  }

  return {
    async get(provider, getOpts) {
      const hit = cache.get(provider)
      if (!getOpts?.fresh && hit && nowMs() - hit.at < ttlMs) return hit.value as ProviderAppResult<typeof provider>
      return (await refresh(provider)) as ProviderAppResult<typeof provider>
    },

    async save(provider, rawInput, saveOpts) {
      const input = (provider === 'slack' ? slackAppInput : discordAppInput).parse(rawInput) as z.output<typeof slackAppInput> &
        z.output<typeof discordAppInput>
      const cipher = await cipherReady
      const result = await db.transaction(async (tx) => {
        await lock(tx, provider)
        const [row] = await tx.select().from(providerApps).where(eq(providerApps.provider, provider))
        const envConfig = env[provider]

        if (!row) {
          const required: ('clientSecret' | 'signingSecret' | 'botToken')[] = provider === 'slack' ? ['clientSecret', 'signingSecret'] : ['clientSecret', 'botToken']
          const missing = required.filter((k) => input[k] === undefined)
          if (missing.length) throw new ProviderAppFieldsError(missing)
        }

        const currentClientId = row ? row.clientId : (envConfig?.clientId ?? null)
        let appChanges = currentClientId !== null && currentClientId !== input.clientId
        if (provider === 'discord' && input.botToken !== undefined) {
          const oldToken = row ? tryOpen(cipher, row.botTokenCt) : (env.discord?.botToken ?? null)
          const oldBot = oldToken ? discordBotIdFromToken(oldToken) : null
          const newBot = discordBotIdFromToken(input.botToken)
          if (oldBot && newBot && oldBot !== newBot) appChanges = true
        }
        if (appChanges && !saveOpts.confirmClientIdChange) {
          const n = await countActive(tx, provider)
          if (n > 0) throw new ClientIdChangeError(n)
        }

        const fields: string[] = []
        if (!row || row.clientId !== input.clientId) fields.push('clientId')
        const values: Partial<typeof providerApps.$inferInsert> = { clientId: input.clientId }
        if (input.clientSecret !== undefined) {
          values.clientSecretCt = cipher.encrypt(input.clientSecret)
          fields.push('clientSecret')
        }
        if (input.allowedUserIds !== undefined) {
          values.allowedUserIds = input.allowedUserIds
          fields.push('allowedUserIds')
        }
        if (provider === 'discord' && input.botToken !== undefined) {
          values.botTokenCt = cipher.encrypt(input.botToken)
          fields.push('botToken')
        }
        if (provider === 'slack') {
          const sameApp = row !== undefined && row.clientId === input.clientId
          if (input.signingSecret !== undefined) {
            values.signingSecretCt = cipher.encrypt(input.signingSecret)
            fields.push('signingSecret')
            const old = sameApp ? tryOpen(cipher, row!.signingSecretCt) : null
            if (old !== null && old !== input.signingSecret) {
              values.previousSigningSecretCt = row!.signingSecretCt
              values.previousExpiresAt = new Date(nowMs() + SIGNING_SECRET_OVERLAP_MS)
            } else if (!sameApp) {
              values.previousSigningSecretCt = null
              values.previousExpiresAt = null
            }
          } else if (!sameApp) {
            values.previousSigningSecretCt = null
            values.previousExpiresAt = null
          }
        }

        const stamp = { updatedBy: saveOpts.updatedBy, updatedAt: new Date(nowMs()), version: sql`nextval('provider_app_versions')` }
        const [saved] = row
          ? await tx
              .update(providerApps)
              .set({ ...values, ...stamp })
              .where(eq(providerApps.provider, provider))
              .returning({ version: providerApps.version })
          : await tx
              .insert(providerApps)
              .values({ ...values, ...stamp, provider, clientId: input.clientId, clientSecretCt: values.clientSecretCt! })
              .returning({ version: providerApps.version })
        return { version: saved!.version, fields }
      })
      cache.delete(provider)
      return result
    },

    async remove(provider, removeOpts) {
      const removed = await db.transaction(async (tx) => {
        await lock(tx, provider)
        const [row] = await tx.select({ clientId: providerApps.clientId }).from(providerApps).where(eq(providerApps.provider, provider))
        if (!row) return false
        const next = env[provider]?.clientId ?? null
        if (next !== row.clientId && !removeOpts?.confirmClientIdChange) {
          const n = await countActive(tx, provider)
          if (n > 0) throw new ClientIdChangeError(n)
        }
        await tx.delete(providerApps).where(eq(providerApps.provider, provider))
        return true
      })
      cache.delete(provider)
      return removed
    },

    invalidate(provider) {
      if (provider) cache.delete(provider)
      else cache.clear()
    },

    activeConnections: (provider) => countActive(db, provider),
  }
}
