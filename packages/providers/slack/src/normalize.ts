import type { Envelope } from '@relay/core'
import type { EventCallback } from './payload'

const CHANNEL_TYPES: Record<string, string> = {
  im: 'im',
  channel: 'channels',
  group: 'groups',
  mpim: 'mpim',
}

const CHANNEL_PREFIXES: Record<string, string> = { D: 'im', C: 'channels', G: 'groups' }

export function messageKind(channelType: string | undefined, channelId: string | undefined): string | null {
  if (channelType && CHANNEL_TYPES[channelType]) return CHANNEL_TYPES[channelType]
  const prefix = channelId?.charAt(0)
  return prefix ? (CHANNEL_PREFIXES[prefix] ?? null) : null
}

function tsToIso(ts: string | undefined, fallbackSeconds: number): string {
  const seconds = ts !== undefined && /^\d+(\.\d+)?$/.test(ts) ? Number(ts) : fallbackSeconds
  return new Date(Math.round(seconds * 1000)).toISOString()
}

export function normalizeSlack(payload: EventCallback, ids: { eventId: string; connectionId: string }): Omit<Envelope, 'raw'> {
  const ev = payload.event
  const base = { id: ids.eventId, provider: 'slack', connectionId: ids.connectionId }
  const occurredAt = tsToIso(ev.event_ts ?? ev.ts, payload.event_time)

  if (ev.type !== 'message') {
    return {
      ...base,
      type: `slack.${ev.type}`,
      subtype: ev.subtype ?? null,
      occurredAt,
      actor: ev.user ?? null,
      context: { channelId: ev.channel ?? null, threadId: null, messageId: null },
      text: null,
    }
  }

  const subtype = ev.subtype ?? null
  const kind = messageKind(ev.channel_type, ev.channel)
  const type = kind ? `slack.message.${kind}` : 'slack.message'
  const channelId = ev.channel ?? null

  if (subtype === 'message_deleted') {
    const prev = ev.previous_message
    const messageId = ev.deleted_ts ?? prev?.ts ?? null
    return {
      ...base,
      type,
      subtype,
      occurredAt,
      actor: prev?.user ?? prev?.bot_id ?? null,
      context: { channelId, threadId: prev?.thread_ts ?? messageId, messageId },
      text: null,
    }
  }

  const msg = subtype === 'message_changed' && ev.message ? ev.message : ev
  const messageId = msg.ts ?? null
  return {
    ...base,
    type,
    subtype,
    occurredAt,
    actor: msg.user ?? msg.bot_id ?? null,
    context: { channelId, threadId: msg.thread_ts ?? messageId, messageId },
    text: msg.text ?? null,
  }
}
