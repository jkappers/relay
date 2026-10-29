import { describe, expect, it } from 'vitest'
import { classifyMessage, messageCreateSchema, normalizeDiscord, stripBotMention } from '../src'
import { BOT_ID, fixture } from './fixtures'

const msg = (name: string, patch: Record<string, unknown> = {}) => messageCreateSchema.parse({ ...fixture(name).d, ...patch })
const ids = { eventId: '00000000-0000-4000-8000-000000000001', connectionId: '00000000-0000-4000-8000-000000000002', botUserId: BOT_ID }

describe('classifyMessage', () => {
  it('ingests a server message that mentions the bot', () => {
    expect(classifyMessage(msg('message_create_mention'), BOT_ID)).toEqual({ ingest: true, kind: 'mention' })
  })

  it('ingests a DM', () => {
    expect(classifyMessage(msg('message_create_dm'), BOT_ID)).toEqual({ ingest: true, kind: 'dm' })
  })

  it('drops server messages without a mention', () => {
    expect(classifyMessage(msg('message_create_no_mention'), BOT_ID)).toEqual({ ingest: false, reason: 'not_mentioned' })
  })

  it('drops messages from bots, webhooks, and the bot itself', () => {
    expect(classifyMessage(msg('message_create_bot_author'), BOT_ID)).toEqual({ ingest: false, reason: 'bot_author' })
    expect(classifyMessage(msg('message_create_mention', { webhook_id: '1' }), BOT_ID)).toEqual({ ingest: false, reason: 'bot_author' })
    expect(classifyMessage(msg('message_create_dm', { author: { id: BOT_ID, username: 'relay' } }), BOT_ID)).toEqual({ ingest: false, reason: 'bot_author' })
  })

  it('drops system message types and waits for READY', () => {
    expect(classifyMessage(msg('message_create_mention', { type: 18 }), BOT_ID)).toEqual({ ingest: false, reason: 'unsupported_type' })
    expect(classifyMessage(msg('message_create_mention', { type: 19 }), BOT_ID)).toEqual({ ingest: true, kind: 'mention' })
    expect(classifyMessage(msg('message_create_mention'), null)).toEqual({ ingest: false, reason: 'no_bot_user' })
  })

  it('does not treat a server message with no channel_type as a DM', () => {
    const m = msg('message_create_no_mention')
    delete (m as { channel_type?: number }).channel_type
    expect(classifyMessage(m, BOT_ID)).toEqual({ ingest: false, reason: 'not_mentioned' })
  })
})

describe('normalizeDiscord', () => {
  it('maps a mention and strips the bot mention from the text', () => {
    expect(normalizeDiscord(msg('message_create_mention'), { ...ids, kind: 'mention' })).toEqual({
      id: ids.eventId,
      provider: 'discord',
      connectionId: ids.connectionId,
      type: 'discord.message.mention',
      subtype: null,
      occurredAt: '2017-07-11T17:27:07.299Z',
      actor: '53908099506183680',
      context: { channelId: '290926798999357250', threadId: null, messageId: '334385199974967042' },
      text: 'Supa Hot',
    })
  })

  it('sets threadId to the thread channel for a message in a thread', () => {
    const env = normalizeDiscord(msg('message_create_thread_mention'), { ...ids, kind: 'mention' })
    expect(env.context).toEqual({ channelId: '334385199974967000', threadId: '334385199974967000', messageId: '334385199974967043' })
    expect(env.text).toBe('thoughts ?')
  })

  it('maps a DM', () => {
    const env = normalizeDiscord(msg('message_create_dm'), { ...ids, kind: 'dm' })
    expect(env.type).toBe('discord.message.dm')
    expect(env.context.threadId).toBeNull()
    expect(env.text).toBe('Supa Hot')
  })

  it('strips the legacy <@!id> form and leaves other mentions', () => {
    expect(stripBotMention(`<@!${BOT_ID}> hi <@123>`, BOT_ID)).toBe('hi <@123>')
  })
})
