import { describe, expect, it } from 'vitest'
import {
  createGatewayController,
  type GatewaySessionEvents,
  type GatewayStatusPatch,
  type TokenRead,
} from '../src/controller'
import { createGatewayMetrics } from '../src/metrics'

interface FakeSession {
  token: string
  events: GatewaySessionEvents
  connects: number
  destroyed: string | null
  connectResult: { resolve: () => void; reject: (err: unknown) => void }
}

function setup(initial: TokenRead = { kind: 'none' }) {
  let read: TokenRead | Error = initial
  let now = 1_000_000
  const sessions: FakeSession[] = []
  const status: GatewayStatusPatch[] = []
  const dispatched: string[] = []
  let newSessions = 0
  const metrics = createGatewayMetrics()
  const controller = createGatewayController({
    readToken: async () => {
      if (read instanceof Error) throw read
      return read
    },
    factory: (token, events) => {
      const s: FakeSession = { token, events, connects: 0, destroyed: null, connectResult: { resolve: () => {}, reject: () => {} } }
      sessions.push(s)
      return {
        connect: () =>
          new Promise<void>((resolve, reject) => {
            s.connects++
            s.connectResult = { resolve, reject }
          }),
        destroy: async (reason) => {
          s.destroyed = reason
        },
      }
    },
    metrics,
    status: {
      write: async (patch) => {
        status.push(patch)
      },
    },
    onDispatch: (p) => dispatched.push(p.t),
    onNewSession: () => newSessions++,
    minSwapMs: 60_000,
    nowMs: () => now,
  })
  const tick = async () => {
    await controller.tick()
    await controller.flushStatus()
  }
  return {
    controller,
    tick,
    metrics,
    sessions,
    status,
    dispatched,
    newSessions: () => newSessions,
    setToken: (token: string | null) => {
      read = token === null ? { kind: 'none' } : { kind: 'token', token }
    },
    setRead: (r: TokenRead | Error) => {
      read = r
    },
    advance: (ms: number) => {
      now += ms
    },
    now: () => now,
  }
}

const settle = () => new Promise((r) => setImmediate(r))

describe('gateway controller', () => {
  it('waits without a token instead of exiting, then connects when one appears', async () => {
    const t = setup()
    await t.tick()
    await t.tick()
    expect(t.sessions).toHaveLength(0)
    expect(t.metrics.configured.get()).toBe(0)
    expect(t.status).toEqual([{ state: 'not_configured' }])

    t.setToken('token-one')
    await t.tick()
    expect(t.sessions).toHaveLength(1)
    expect(t.sessions[0]!.token).toBe('token-one')
    expect(t.sessions[0]!.connects).toBe(1)
    expect(t.metrics.configured.get()).toBe(1)
    expect(t.metrics.tokenSwaps.get({})).toBe(0)
    expect(t.status.at(-1)).toEqual({ state: 'connecting' })
  })

  it('writes ready and close status, and forwards dispatches from the live session only', async () => {
    const t = setup({ kind: 'token', token: 'token-one' })
    await t.tick()
    const s = t.sessions[0]!
    s.events.ready()
    s.events.dispatch({ t: 'MESSAGE_CREATE', d: {} })
    await t.controller.flushStatus()
    expect(t.metrics.connected.get()).toBe(1)
    expect(t.status.at(-1)).toEqual({ state: 'ready', lastReadyAt: new Date(t.now()) })
    expect(t.dispatched).toEqual(['MESSAGE_CREATE'])

    s.events.closed(1006)
    await t.controller.flushStatus()
    expect(t.metrics.connected.get()).toBe(0)
    expect(t.metrics.closes.get({ code: '1006' })).toBe(1)
    expect(t.status.at(-1)).toEqual({ state: 'reconnecting', lastCloseCode: 1006 })
    s.events.resumed()
    await t.controller.flushStatus()
    expect(t.status.at(-1)).toMatchObject({ state: 'ready' })
  })

  it('does nothing while the token is unchanged', async () => {
    const t = setup({ kind: 'token', token: 'token-one' })
    await t.tick()
    for (let i = 0; i < 5; i++) {
      t.advance(120_000)
      await t.tick()
    }
    expect(t.sessions).toHaveLength(1)
    expect(t.sessions[0]!.destroyed).toBeNull()
    expect(t.metrics.tokenSwaps.get({})).toBe(0)
  })

  it('swaps the session when the token changes, at most once per minute', async () => {
    const t = setup({ kind: 'token', token: 'token-one' })
    await t.tick()
    t.sessions[0]!.events.ready()

    t.advance(10_000)
    t.setToken('token-two')
    await t.tick()
    expect(t.sessions).toHaveLength(1)
    expect(t.sessions[0]!.destroyed).toBeNull()

    t.advance(30_000)
    t.setToken('token-three')
    await t.tick()
    expect(t.sessions).toHaveLength(1)

    t.advance(20_000)
    await t.tick()
    expect(t.sessions).toHaveLength(2)
    expect(t.sessions[0]!.destroyed).toBe('bot token changed')
    expect(t.sessions[1]!.token).toBe('token-three')
    expect(t.metrics.tokenSwaps.get({})).toBe(1)
    expect(t.metrics.connected.get()).toBe(0)
    expect(t.newSessions()).toBe(2)

    t.sessions[0]!.events.dispatch({ t: 'MESSAGE_CREATE', d: {} })
    t.sessions[0]!.events.closed(1000)
    expect(t.dispatched).toEqual([])
    expect(t.metrics.closes.get({ code: '1000' })).toBe(0)

    t.setToken('token-four')
    t.advance(59_999)
    await t.tick()
    expect(t.sessions).toHaveLength(2)
    t.advance(1)
    await t.tick()
    expect(t.sessions).toHaveLength(3)
    expect(t.metrics.tokenSwaps.get({})).toBe(2)
  })

  it('stops after authentication fails and waits for a new token', async () => {
    const t = setup({ kind: 'token', token: 'revoked-token' })
    await t.tick()
    t.sessions[0]!.events.closed(4004)
    await t.controller.flushStatus()
    expect(t.status.at(-1)).toEqual({ state: 'auth_failed', lastCloseCode: 4004 })

    t.advance(300_000)
    await t.tick()
    expect(t.sessions).toHaveLength(1)

    t.setToken('fixed-token')
    await t.tick()
    expect(t.sessions).toHaveLength(2)
    expect(t.sessions[0]!.destroyed).toBe('bot token changed')
  })

  it('marks a 401 from the REST lookup as auth failed and does not retry the same token', async () => {
    const t = setup({ kind: 'token', token: 'bad-token' })
    await t.tick()
    t.sessions[0]!.connectResult.reject(Object.assign(new Error('401: Unauthorized'), { status: 401 }))
    await settle()
    await t.controller.flushStatus()
    expect(t.status.at(-1)).toEqual({ state: 'auth_failed' })
    expect(t.sessions[0]!.destroyed).toBe('connect failed')
    t.advance(120_000)
    await t.tick()
    expect(t.sessions).toHaveLength(1)
  })

  it('retries a failed connect for the same token once the swap limit allows', async () => {
    const t = setup({ kind: 'token', token: 'token-one' })
    await t.tick()
    t.sessions[0]!.connectResult.reject(new Error('network down'))
    await settle()
    await t.controller.flushStatus()
    expect(t.status.at(-1)).toEqual({ state: 'error' })
    t.advance(30_000)
    await t.tick()
    expect(t.sessions).toHaveLength(1)
    t.advance(30_000)
    await t.tick()
    expect(t.sessions).toHaveLength(2)
    expect(t.metrics.tokenSwaps.get({})).toBe(0)
  })

  it('disconnects when the token is removed, and keeps running when the settings cannot be read', async () => {
    const t = setup({ kind: 'token', token: 'token-one' })
    await t.tick()
    t.setRead(new Error('db down'))
    await t.tick()
    t.setRead({ kind: 'unknown' })
    await t.tick()
    expect(t.sessions[0]!.destroyed).toBeNull()
    expect(t.metrics.configured.get()).toBe(1)

    t.setToken(null)
    await t.tick()
    expect(t.sessions[0]!.destroyed).toBe('bot token removed')
    expect(t.metrics.configured.get()).toBe(0)
    expect(t.status.at(-1)).toEqual({ state: 'not_configured' })
  })

  it('destroys the session on stop and ignores later ticks', async () => {
    const t = setup({ kind: 'token', token: 'token-one' })
    await t.tick()
    await t.controller.stop('SIGTERM')
    expect(t.sessions[0]!.destroyed).toBe('SIGTERM')
    t.setToken('token-two')
    t.advance(120_000)
    await t.tick()
    expect(t.sessions).toHaveLength(1)
  })

  it('never puts the token in a status write', async () => {
    const t = setup({ kind: 'token', token: 'PLANTED-token-value' })
    await t.tick()
    t.sessions[0]!.events.ready()
    t.sessions[0]!.events.closed(4004)
    await t.controller.flushStatus()
    expect(JSON.stringify(t.status)).not.toContain('PLANTED')
  })
})
