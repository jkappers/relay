import { z } from 'zod'

export const envelopeSchema = z.object({
  id: z.uuid(),
  provider: z.string().min(1),
  connectionId: z.uuid(),
  type: z.string().min(1),
  subtype: z.string().nullable(),
  occurredAt: z.iso.datetime({ offset: true }),
  actor: z.string().nullable(),
  context: z.object({
    channelId: z.string().nullable(),
    threadId: z.string().nullable(),
    messageId: z.string().nullable(),
  }),
  text: z.string().nullable(),
  raw: z.unknown(),
  reply: z
    .object({
      actionsUrl: z.url(),
      token: z.string(),
      allowed: z.array(z.string()),
    })
    .optional(),
})

export type Envelope = z.infer<typeof envelopeSchema>
