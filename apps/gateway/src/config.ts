import { coreEnvSchema } from '@relay/core'
import { z } from 'zod'

export const gatewayEnvSchema = coreEnvSchema.extend({
  /** Fallback when no Discord app is saved in Relay. Without any token the gateway waits for one. */
  DISCORD_BOT_TOKEN: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? v.trim() : undefined)),
  GATEWAY_METRICS_PORT: z.coerce.number().int().min(1).max(65535).default(9466),
  /** How often a waiting copy retries the leader lock, and how often the leader checks it still holds it. */
  GATEWAY_LOCK_POLL_SECONDS: z.coerce.number().min(1).default(15),
  /** How often the leader reads the bot token from the app settings. */
  GATEWAY_TOKEN_POLL_SECONDS: z.coerce.number().min(1).default(30),
  /** At most one new session (IDENTIFY) per this many seconds when the token changes or a connect failed. */
  GATEWAY_MIN_SWAP_SECONDS: z.coerce.number().min(1).default(60),
})

export type GatewayConfig = z.infer<typeof gatewayEnvSchema>

// docs.discord.com/developers/events/gateway#gateway-intents: GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES.
// Never MESSAGE_CONTENT (1 << 15): it is privileged and needs Discord review past 100 servers.
export const GATEWAY_INTENTS = (1 << 0) | (1 << 9) | (1 << 12)
