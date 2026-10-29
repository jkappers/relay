import { coreEnvSchema } from '@relay/core'
import { z } from 'zod'

export const workerEnvSchema = coreEnvSchema
  .extend({
    PUBLIC_URL: z.url().transform((u) => u.replace(/\/+$/, '')),
    SLACK_API_BASE_URL: z.url().default('https://slack.com/api'),
    SMS_API_BASE_URL: z.url().default('https://api.twilio.com'),
    // Discord actions need the app's bot token. Without it they fail with no_credentials.
    DISCORD_BOT_TOKEN: z
      .string()
      .optional()
      .transform((v) => (v && v.trim() ? v.trim() : undefined)),
    DISCORD_API_BASE_URL: z.url().default('https://discord.com/api/v10'),
    REPLY_TOKEN_TTL_SECONDS: z.coerce.number().int().min(1).default(3600),
    WORKER_METRICS_PORT: z.coerce.number().int().min(1).max(65535).default(9465),
    DISPATCH_BACKOFF_BASE_MS: z.coerce.number().int().min(1).default(5_000),
    DISPATCH_BACKOFF_CAP_MS: z.coerce.number().int().min(1).default(900_000),
    SWEEP_INTERVAL_SECONDS: z.coerce.number().min(1).default(60),
    SWEEP_GRACE_SECONDS: z.coerce.number().min(0).default(300),
    WORKER_POLL_SECONDS: z.coerce.number().min(0.5).default(2),
    AGENT_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(1),
    AGENT_BACKOFF_BASE_MS: z.coerce.number().int().min(1).default(15_000),
    AGENT_BACKOFF_CAP_MS: z.coerce.number().int().min(1).default(300_000),
    RELAY_AGENT_RUNNER: z.enum(['sdk', 'fake']).default('sdk'),
    RELAY_CLASSIFIER: z.enum(['anthropic', 'fake']).default('anthropic'),
    NODE_ENV: z.string().optional(),
  })
  .refine((c) => !(c.RELAY_AGENT_RUNNER === 'fake' && c.NODE_ENV === 'production'), {
    message: 'RELAY_AGENT_RUNNER=fake is for tests and is refused when NODE_ENV=production',
    path: ['RELAY_AGENT_RUNNER'],
  })
  .refine((c) => !(c.RELAY_CLASSIFIER === 'fake' && c.NODE_ENV === 'production'), {
    message: 'RELAY_CLASSIFIER=fake is for tests and is refused when NODE_ENV=production',
    path: ['RELAY_CLASSIFIER'],
  })

export type WorkerConfig = z.infer<typeof workerEnvSchema>
