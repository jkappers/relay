import { REST } from '@discordjs/rest'
import { DefaultWebSocketManagerOptions, WebSocketManager, WebSocketShardEvents } from '@discordjs/ws'
import type { GatewaySessionFactory } from './controller'

/**
 * One WebSocketManager per token: the library fixes the token at construction (setToken throws once set).
 * Resume, heartbeats, and reconnects are the library's job. Relay never re-identifies on its own: the IDENTIFY budget is 1000 a day.
 */
export function discordSessionFactory(opts: { intents: number }): GatewaySessionFactory {
  return (token, events) => {
    const rest = new REST({ version: '10' }).setToken(token)
    const manager = new WebSocketManager({
      token,
      intents: opts.intents,
      rest,
      async buildIdentifyThrottler(m) {
        const inner = await DefaultWebSocketManagerOptions.buildIdentifyThrottler(m)
        return {
          async waitForIdentify(shardId: number, signal: AbortSignal) {
            await inner.waitForIdentify(shardId, signal)
            events.identify(shardId)
          },
        }
      },
    })
    manager.on(WebSocketShardEvents.Dispatch, (payload) => events.dispatch({ t: payload.t, d: payload.d }))
    manager.on(WebSocketShardEvents.Ready, () => events.ready())
    manager.on(WebSocketShardEvents.Resumed, () => events.resumed())
    manager.on(WebSocketShardEvents.Closed, (code) => events.closed(code))
    manager.on(WebSocketShardEvents.Error, (err) => events.error(err))
    return {
      connect: () => manager.connect(),
      async destroy(reason) {
        try {
          await manager.destroy({ reason })
        } finally {
          rest.clearHashSweeper()
          rest.clearHandlerSweeper()
        }
      },
    }
  }
}
