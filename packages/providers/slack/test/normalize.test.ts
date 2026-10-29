import { readFileSync } from 'node:fs'
import { envelopeSchema } from '@relay/core'
import { describe, expect, it } from 'vitest'
import { eventCallbackSchema, normalizeSlack } from '../src'

const ids = { eventId: '00000000-0000-4000-8000-000000000001', connectionId: '00000000-0000-4000-8000-000000000002' }

function load(name: string) {
  const raw = JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'))
  const env = normalizeSlack(eventCallbackSchema.parse(raw), ids)
  envelopeSchema.parse({ ...env, raw })
  return env
}

describe('normalizeSlack', () => {
  it('plain DM', () => {
    expect(load('message_im')).toMatchObject({
      type: 'slack.message.im',
      subtype: null,
      actor: 'U2147483697',
      text: 'Hello hello can you hear me?',
      occurredAt: '2012-12-14T20:38:43.000Z',
      context: { channelId: 'D024BE91L', threadId: '1355517523.000005', messageId: '1355517523.000005' },
    })
  })

  it('channel message', () => {
    expect(load('message_channels')).toMatchObject({ type: 'slack.message.channels', actor: 'U123ABC456' })
  })

  it('private channel message', () => {
    expect(load('message_groups')).toMatchObject({ type: 'slack.message.groups', context: { channelId: 'G024BE91L' } })
  })

  it('threadId is ts for a top-level message', () => {
    const env = load('message_channels')
    expect(env.context.threadId).toBe(env.context.messageId)
  })

  it('threadId is thread_ts for a reply', () => {
    expect(load('message_channels_thread_reply').context).toEqual({
      channelId: 'C123ABC456',
      threadId: '1355517523.000005',
      messageId: '1355517600.000010',
    })
  })

  it('message_changed uses the edited message', () => {
    expect(load('message_changed')).toMatchObject({
      type: 'slack.message.channels',
      subtype: 'message_changed',
      actor: 'U123ABC456',
      text: 'Hello, world!',
      context: { channelId: 'C123ABC456', threadId: '1355517523.000005', messageId: '1355517523.000005' },
    })
  })

  it('message_deleted points at the deleted message', () => {
    expect(load('message_deleted')).toMatchObject({
      subtype: 'message_deleted',
      actor: null,
      text: null,
      context: { channelId: 'C123ABC456', threadId: '1358878749.000002', messageId: '1358878749.000002' },
    })
  })

  it('thread_broadcast threads under the root', () => {
    expect(load('thread_broadcast')).toMatchObject({
      type: 'slack.message.channels',
      subtype: 'thread_broadcast',
      text: 'broadcasting this reply',
      context: { threadId: '1673464730.703009', messageId: '1673464745.620769' },
    })
  })

  it('bot_message uses bot_id as actor', () => {
    expect(load('bot_message')).toMatchObject({
      type: 'slack.message',
      subtype: 'bot_message',
      actor: 'BB12033',
      context: { channelId: null, threadId: '1358877455.000010', messageId: '1358877455.000010' },
    })
  })

  it('file_share', () => {
    expect(load('file_share')).toMatchObject({
      type: 'slack.message.im',
      subtype: 'file_share',
      actor: 'U123ABC456',
      text: 'We got one!',
      context: { channelId: 'D0L4B9P0Q', threadId: '1529342088.000086' },
    })
  })
})
