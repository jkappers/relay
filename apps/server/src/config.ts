import { coreEnvSchema } from '@relay/core'
import { z } from 'zod'

export const serverEnvSchema = coreEnvSchema.extend({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  PUBLIC_URL: z.url().transform((u) => u.replace(/\/+$/, '')),
  SLACK_SIGNING_SECRET: z.string().min(1),
  SLACK_CLIENT_ID: z.string().min(1),
  SLACK_CLIENT_SECRET: z.string().min(1),
})

export type ServerConfig = z.infer<typeof serverEnvSchema>
