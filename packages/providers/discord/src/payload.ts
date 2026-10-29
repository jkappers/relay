import { z } from 'zod'

export const discordUserSchema = z.looseObject({
  id: z.string().min(1),
  username: z.string().optional(),
  global_name: z.string().nullish(),
  bot: z.boolean().optional(),
})

export const messageCreateSchema = z.looseObject({
  id: z.string().min(1),
  channel_id: z.string().min(1),
  guild_id: z.string().optional(),
  channel_type: z.number().int().optional(),
  type: z.number().int(),
  author: discordUserSchema,
  content: z.string().default(''),
  timestamp: z.string(),
  mentions: z.array(discordUserSchema).default([]),
  webhook_id: z.string().optional(),
})

export const guildDeleteSchema = z.looseObject({
  id: z.string().min(1),
  unavailable: z.boolean().optional(),
})

export const readySchema = z.looseObject({
  user: discordUserSchema,
  session_id: z.string().optional(),
})

export type DiscordMessage = z.infer<typeof messageCreateSchema>

// docs.discord.com/developers/resources/channel#channel-object-channel-types
export const CHANNEL_TYPE = { DM: 1, GROUP_DM: 3, ANNOUNCEMENT_THREAD: 10, PUBLIC_THREAD: 11, PRIVATE_THREAD: 12 } as const
const THREAD_TYPES: ReadonlySet<number> = new Set([CHANNEL_TYPE.ANNOUNCEMENT_THREAD, CHANNEL_TYPE.PUBLIC_THREAD, CHANNEL_TYPE.PRIVATE_THREAD])
export const isThreadChannel = (channelType: number | undefined) => channelType !== undefined && THREAD_TYPES.has(channelType)

// docs.discord.com/developers/resources/message#message-object-message-types
export const MESSAGE_TYPE = { DEFAULT: 0, REPLY: 19 } as const
