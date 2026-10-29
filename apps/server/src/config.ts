import { coreEnvSchema } from '@relay/core'
import { z } from 'zod'

const optional = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : undefined))

const SLACK_KEYS = ['SLACK_SIGNING_SECRET', 'SLACK_CLIENT_ID', 'SLACK_CLIENT_SECRET'] as const
const DISCORD_KEYS = ['DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET'] as const

const idList = z
  .string()
  .default('')
  .transform((v) => v.split(',').map((id) => id.trim()).filter(Boolean))

export const serverEnvSchema = coreEnvSchema
  .extend({
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    PUBLIC_URL: z.url().transform((u) => u.replace(/\/+$/, '')),
    SLACK_API_BASE_URL: z.url().default('https://slack.com/api'),
    SMS_API_BASE_URL: z.url().default('https://api.twilio.com'),
    SIGNUP_MODE: z.enum(['closed', 'open']).default('closed'),
    // Slack is enabled only when all three are set.
    SLACK_SIGNING_SECRET: optional,
    SLACK_CLIENT_ID: optional,
    SLACK_CLIENT_SECRET: optional,
    SLACK_ALLOWED_USER_IDS: idList,
    // Discord install (OAuth) is enabled only when both are set. The bot token is for actions (/actions).
    DISCORD_CLIENT_ID: optional,
    DISCORD_CLIENT_SECRET: optional,
    DISCORD_BOT_TOKEN: optional,
    DISCORD_API_BASE_URL: z.url().default('https://discord.com/api/v10'),
    DISCORD_ALLOWED_USER_IDS: idList,
  })
  .superRefine((c, ctx) => {
    for (const [keys, prefix] of [[SLACK_KEYS, 'SLACK'], [DISCORD_KEYS, 'DISCORD']] as const) {
      const set = keys.filter((k) => c[k] !== undefined)
      if (set.length === 0 || set.length === keys.length) continue
      for (const k of keys.filter((k) => c[k] === undefined)) {
        ctx.addIssue({ code: 'custom', path: [k], message: `required when any ${prefix}_* app setting is set` })
      }
    }
  })

export type ServerConfig = z.infer<typeof serverEnvSchema>
