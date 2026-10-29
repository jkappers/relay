import { createHash } from 'node:crypto'
import { log } from '@relay/core'
import type { GatewayMetrics } from './metrics'

export interface GatewaySessionEvents {
  dispatch(payload: { t: string; d: unknown }): void
  ready(): void
  resumed(): void
  closed(code: number): void
  error(err: Error): void
  /** The session is about to send IDENTIFY. Each one spends the daily session-start budget. */
  identify(shardId: number): void
}

export interface GatewaySession {
  connect(): Promise<void>
  destroy(reason: string): Promise<void>
}

export type GatewaySessionFactory = (token: string, events: GatewaySessionEvents) => GatewaySession

export type GatewayStatusState = 'not_configured' | 'connecting' | 'ready' | 'reconnecting' | 'auth_failed' | 'closed' | 'error'

export interface GatewayStatusPatch {
  state: GatewayStatusState
  lastReadyAt?: Date
  lastCloseCode?: number | null
}

export interface GatewayStatusWriter {
  write(patch: GatewayStatusPatch): Promise<void>
}

/** `unknown` means the settings could not be read or are invalid: keep whatever runs now. */
export type TokenRead = { kind: 'token'; token: string } | { kind: 'none' } | { kind: 'unknown' }

export interface GatewayControllerDeps {
  readToken: () => Promise<TokenRead>
  factory: GatewaySessionFactory
  metrics: Pick<GatewayMetrics, 'configured' | 'connected' | 'tokenSwaps' | 'closes'>
  status: GatewayStatusWriter
  onDispatch: (payload: { t: string; d: unknown }) => void
  /** Called before each new session, so stale per-bot state (the bot user id) can be dropped. */
  onNewSession?: () => void
  minSwapMs?: number
  nowMs?: () => number
}

// The library stops on these without reconnecting (docs.discord.com/developers/topics/opcodes-and-status-codes#gateway-gateway-close-event-codes).
export const FATAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014])
export const AUTH_FAILED_CLOSE_CODE = 4004
export const DEFAULT_MIN_SWAP_MS = 60_000

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

/**
 * Runs at most one Gateway session for the bot token in the app settings.
 * Each tick reads the token. No token: wait. A new token: destroy the session and start one for it,
 * at most once per minSwapMs, so a burst of saves costs one IDENTIFY. Tokens are compared by SHA-256 and never logged.
 */
export function createGatewayController(deps: GatewayControllerDeps) {
  const nowMs = deps.nowMs ?? Date.now
  const minSwapMs = deps.minSwapMs ?? DEFAULT_MIN_SWAP_MS
  const { metrics } = deps
  let generation = 0
  let session: GatewaySession | null = null
  let tokenHash: string | null = null
  let lastStartAt = Number.NEGATIVE_INFINITY
  let halted = false
  let deferredHash: string | null = null
  let stopped = false
  let waiting = false
  let running: Promise<void> | null = null
  let statusChain = Promise.resolve()

  const writeStatus = (patch: GatewayStatusPatch) => {
    statusChain = statusChain
      .then(() => deps.status.write(patch))
      .catch((err: unknown) => log.warn('gateway: could not write status', { err: err instanceof Error ? err.message : String(err) }))
  }
  const due = () => nowMs() - lastStartAt >= minSwapMs

  async function teardown(reason: string) {
    generation++
    const old = session
    session = null
    metrics.connected.set(0)
    if (!old) return
    try {
      await old.destroy(reason)
    } catch (err) {
      log.warn('gateway: destroy failed', { err: err instanceof Error ? err.message : String(err) })
    }
  }

  function start(token: string) {
    const gen = ++generation
    const live = () => gen === generation && !stopped
    lastStartAt = nowMs()
    halted = false
    waiting = false
    deps.onNewSession?.()
    const s = deps.factory(token, {
      dispatch: (payload) => {
        if (live()) deps.onDispatch(payload)
      },
      ready: () => {
        if (!live()) return
        metrics.connected.set(1)
        writeStatus({ state: 'ready', lastReadyAt: new Date(nowMs()) })
      },
      resumed: () => {
        if (!live()) return
        metrics.connected.set(1)
        writeStatus({ state: 'ready', lastReadyAt: new Date(nowMs()) })
      },
      closed: (code) => {
        if (!live()) return
        metrics.connected.set(0)
        metrics.closes.inc({ code: String(code) })
        const fatal = FATAL_CLOSE_CODES.has(code)
        if (fatal) halted = true
        log.warn('gateway: socket closed', { code, fatal })
        writeStatus({ state: code === AUTH_FAILED_CLOSE_CODE ? 'auth_failed' : fatal ? 'closed' : 'reconnecting', lastCloseCode: code })
      },
      error: (err) => {
        if (live()) log.error('gateway: shard error', { err: err.message })
      },
      identify: (shardId) => {
        if (live()) log.info('gateway: sending IDENTIFY', { shardId })
      },
    })
    session = s
    writeStatus({ state: 'connecting' })
    // connect() settles only on the first READY or RESUMED, and never after a fatal close, so it is not awaited.
    s.connect().catch(async (err: unknown) => {
      if (!live()) return
      const auth = (err as { status?: unknown } | null)?.status === 401
      log.error('gateway: could not connect', { err: err instanceof Error ? err.message : String(err), authFailed: auth })
      await teardown('connect failed')
      if (auth) {
        halted = true
        writeStatus({ state: 'auth_failed' })
      } else if (!halted) writeStatus({ state: 'error' })
    })
  }

  async function run() {
    let read: TokenRead
    try {
      read = await deps.readToken()
    } catch (err) {
      log.warn('gateway: could not read the bot token', { err: err instanceof Error ? err.message : String(err) })
      return
    }
    if (stopped || read.kind === 'unknown') return
    const token = read.kind === 'token' ? read.token : null
    const next = token ? sha256(token) : null
    metrics.configured.set(next ? 1 : 0)

    if (!token) {
      if (tokenHash !== null || session) await teardown('bot token removed')
      tokenHash = null
      deferredHash = null
      halted = false
      if (!waiting) {
        waiting = true
        log.info('gateway: no Discord bot token is set; waiting for one')
        writeStatus({ state: 'not_configured' })
      }
      return
    }

    if (next === tokenHash) {
      if (!session && !halted && due()) {
        log.info('gateway: retrying the connection')
        start(token)
      }
      return
    }

    if (!due()) {
      if (deferredHash !== next) log.info('gateway: bot token changed; reconnecting once the swap limit allows', { inMs: lastStartAt + minSwapMs - nowMs() })
      deferredHash = next
      return
    }

    const swap = tokenHash !== null
    await teardown(swap ? 'bot token changed' : 'starting')
    if (stopped) return
    tokenHash = next
    deferredHash = null
    if (swap) {
      metrics.tokenSwaps.inc({})
      log.info('gateway: bot token changed; starting a new session')
    } else log.info('gateway: bot token found; connecting')
    start(token)
  }

  return {
    /** Reads the token and reacts. Concurrent calls share one run. */
    tick(): Promise<void> {
      if (stopped) return Promise.resolve()
      running ??= run()
        .catch((err: unknown) => log.error('gateway: token check failed', { err: err instanceof Error ? err.message : String(err) }))
        .finally(() => {
          running = null
        })
      return running
    },

    async stop(reason = 'shutdown'): Promise<void> {
      stopped = true
      await teardown(reason)
      await statusChain
    },

    /** Resolves once every status write queued so far has finished. */
    flushStatus: () => statusChain,
  }
}
