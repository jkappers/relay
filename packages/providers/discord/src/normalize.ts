import type { Envelope } from '@relay/core'
import { CHANNEL_TYPE, isThreadChannel, MESSAGE_TYPE, type DiscordMessage } from './payload'

export type MessageKind = 'dm' | 'mention'

export type Classification = { ingest: true; kind: MessageKind } | { ingest: false; reason: 'bot_author' | 'unsupported_type' | 'not_mentioned' | 'no_bot_user' }

/** Without the MESSAGE_CONTENT intent, only DMs and messages that mention the bot carry content, so only those are ingested. */
export function classifyMessage(msg: DiscordMessage, botUserId: string | null): Classification {
  if (msg.author.bot || msg.webhook_id) return { ingest: false, reason: 'bot_author' }
  if (msg.type !== MESSAGE_TYPE.DEFAULT && msg.type !== MESSAGE_TYPE.REPLY) return { ingest: false, reason: 'unsupported_type' }
  if (!botUserId) return { ingest: false, reason: 'no_bot_user' }
  if (msg.author.id === botUserId) return { ingest: false, reason: 'bot_author' }
  const isDm = msg.channel_type === CHANNEL_TYPE.DM || (msg.channel_type === undefined && msg.guild_id === undefined)
  if (isDm) return { ingest: true, kind: 'dm' }
  if (msg.guild_id !== undefined && msg.mentions.some((u) => u.id === botUserId)) return { ingest: true, kind: 'mention' }
  return { ingest: false, reason: 'not_mentioned' }
}

export function stripBotMention(content: string, botUserId: string): string {
  return content.replaceAll(`<@${botUserId}>`, '').replaceAll(`<@!${botUserId}>`, '').trim()
}

export function normalizeDiscord(
  msg: DiscordMessage,
  ids: { eventId: string; connectionId: string; kind: MessageKind; botUserId: string },
): Omit<Envelope, 'raw'> {
  const text = stripBotMention(msg.content, ids.botUserId)
  const occurred = new Date(msg.timestamp)
  return {
    id: ids.eventId,
    provider: 'discord',
    connectionId: ids.connectionId,
    type: `discord.message.${ids.kind}`,
    subtype: null,
    occurredAt: Number.isNaN(occurred.getTime()) ? new Date().toISOString() : occurred.toISOString(),
    actor: msg.author.id,
    context: {
      channelId: msg.channel_id,
      threadId: isThreadChannel(msg.channel_type) ? msg.channel_id : null,
      messageId: msg.id,
    },
    text: text === '' ? null : text,
  }
}
