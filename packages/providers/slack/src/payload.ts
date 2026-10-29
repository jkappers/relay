import { z } from 'zod'

export const authorizationSchema = z.looseObject({
  enterprise_id: z.string().nullish(),
  team_id: z.string().nullish(),
  user_id: z.string().nullish(),
  is_bot: z.boolean().optional(),
})

const messageFields = {
  type: z.string(),
  subtype: z.string().optional(),
  channel: z.string().optional(),
  channel_type: z.string().optional(),
  user: z.string().optional(),
  bot_id: z.string().nullish(),
  text: z.string().optional(),
  ts: z.string().optional(),
  thread_ts: z.string().optional(),
  event_ts: z.string().optional(),
}

export const innerMessageSchema = z.looseObject(messageFields)

export const slackEventSchema = z.looseObject({
  ...messageFields,
  message: innerMessageSchema.optional(),
  previous_message: innerMessageSchema.optional(),
  deleted_ts: z.string().optional(),
  tokens: z
    .looseObject({
      oauth: z.array(z.string()).optional(),
      bot: z.array(z.string()).optional(),
    })
    .optional(),
})

export const eventCallbackSchema = z.looseObject({
  type: z.literal('event_callback'),
  team_id: z.string(),
  api_app_id: z.string().optional(),
  event_id: z.string(),
  event_time: z.number(),
  authorizations: z.array(authorizationSchema).optional(),
  event: slackEventSchema,
})

export const urlVerificationSchema = z.looseObject({
  type: z.literal('url_verification'),
  challenge: z.string(),
})

export type EventCallback = z.infer<typeof eventCallbackSchema>
export type SlackEvent = z.infer<typeof slackEventSchema>
