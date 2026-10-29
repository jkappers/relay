import { coreEnvSchema } from '@relay/core'
import { z } from 'zod'

export const serverEnvSchema = coreEnvSchema.extend({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  PUBLIC_URL: z.url().transform((u) => u.replace(/\/+$/, '')),
  SLACK_API_BASE_URL: z.url().default('https://slack.com/api'),
  SMS_API_BASE_URL: z.url().default('https://api.twilio.com'),
  SIGNUP_MODE: z.enum(['closed', 'open']).default('closed'),
  SLACK_SIGNING_SECRET: z.string().min(1),
  SLACK_CLIENT_ID: z.string().min(1),
  SLACK_CLIENT_SECRET: z.string().min(1),
  SLACK_ALLOWED_USER_IDS: z
    .string()
    .default('')
    .transform((v) => v.split(',').map((id) => id.trim()).filter(Boolean)),
})

export type ServerConfig = z.infer<typeof serverEnvSchema>
