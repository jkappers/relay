import { coreEnvSchema } from '@relay/core'
import { z } from 'zod'

export const workerEnvSchema = coreEnvSchema.extend({
  PUBLIC_URL: z.url().transform((u) => u.replace(/\/+$/, '')),
  SLACK_API_BASE_URL: z.url().default('https://slack.com/api'),
  REPLY_TOKEN_TTL_SECONDS: z.coerce.number().int().min(1).default(3600),
  WORKER_METRICS_PORT: z.coerce.number().int().min(1).max(65535).default(9465),
  DISPATCH_BACKOFF_BASE_MS: z.coerce.number().int().min(1).default(5_000),
  DISPATCH_BACKOFF_CAP_MS: z.coerce.number().int().min(1).default(900_000),
  SWEEP_INTERVAL_SECONDS: z.coerce.number().min(1).default(60),
  SWEEP_GRACE_SECONDS: z.coerce.number().min(0).default(300),
  WORKER_POLL_SECONDS: z.coerce.number().min(0.5).default(2),
})

export type WorkerConfig = z.infer<typeof workerEnvSchema>
