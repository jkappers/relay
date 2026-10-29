import { z } from 'zod'

export const MASTER_KEY_BYTES = 32

export const masterKeySchema = z.string().transform((value, ctx) => {
  const trimmed = value.trim()
  const bytes = Buffer.from(trimmed, 'base64')
  const canonical = bytes.toString('base64')
  if (canonical.replace(/=+$/, '') !== trimmed.replace(/=+$/, '') || bytes.length !== MASTER_KEY_BYTES) {
    ctx.addIssue({ code: 'custom', message: `must be ${MASTER_KEY_BYTES} bytes encoded as base64` })
    return z.NEVER
  }
  return new Uint8Array(bytes)
})

export const coreEnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  RELAY_MASTER_KEY: masterKeySchema,
})

export type CoreConfig = z.infer<typeof coreEnvSchema>

export class ConfigError extends Error {
  override name = 'ConfigError'
}

export function loadConfig<S extends z.ZodType>(schema: S, env: Record<string, string | undefined> = process.env): z.infer<S> {
  const result = schema.safeParse(env)
  if (!result.success) {
    const problems = result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    throw new ConfigError(`Invalid configuration:\n  ${problems.join('\n  ')}`)
  }
  return result.data
}
