import { coreEnvSchema } from '@relay/core'
import { z } from 'zod'

export const gatewayEnvSchema = coreEnvSchema.extend({
  DISCORD_BOT_TOKEN: z.string().trim().min(1),
  GATEWAY_METRICS_PORT: z.coerce.number().int().min(1).max(65535).default(9466),
  /** How often a waiting copy retries the leader lock, and how often the leader checks it still holds it. */
  GATEWAY_LOCK_POLL_SECONDS: z.coerce.number().min(1).default(15),
})

export type GatewayConfig = z.infer<typeof gatewayEnvSchema>

// docs.discord.com/developers/events/gateway#gateway-intents: GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES.
// Never MESSAGE_CONTENT (1 << 15): it is privileged and needs Discord review past 100 servers.
export const GATEWAY_INTENTS = (1 << 0) | (1 << 9) | (1 << 12)
