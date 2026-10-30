import { SendEmailCommand } from '@aws-sdk/client-sesv2'
import { describe, expect, test } from 'bun:test'
import { createSesSendProvider, sanitizeSesTag } from './send'

const message = {
  from: 'Sender <sender@example.com>',
  to: 'guest@example.com',
  replyTo: 'reply@example.com',
  subject: 'Hello',
  html: '<p>Hello</p>',
  text: 'Hello',
}

function fakeClient(response: { MessageId?: string }) {
  const commands: SendEmailCommand[] = []
  return {
    commands,
    client: {
      send: async (command: SendEmailCommand) => {
        commands.push(command)
        return response
      },
    } as never,
  }
}

describe('createSesSendProvider', () => {
  test('is the ses provider', () => {
    const provider = createSesSendProvider({
      client: fakeClient({ MessageId: 'x' }).client,
      configurationSetName: 'events',
    })

    expect(provider.id).toBe('ses')
  })

  test('send() builds a simple SendEmailCommand and returns the MessageId', async () => {
    const fake = fakeClient({ MessageId: 'ses-msg-1' })
    const provider = createSesSendProvider({
      client: fake.client,
      configurationSetName: 'events',
    })

    await expect(provider.send(message)).resolves.toEqual({
      providerMessageId: 'ses-msg-1',
    })
    expect(fake.commands).toHaveLength(1)
    expect(fake.commands[0]).toBeInstanceOf(SendEmailCommand)
    expect(fake.commands[0]!.input).toEqual({
      FromEmailAddress: 'Sender <sender@example.com>',
      Destination: { ToAddresses: ['guest@example.com'] },
      ReplyToAddresses: ['reply@example.com'],
      ConfigurationSetName: 'events',
      Content: {
        Simple: {
          Subject: { Data: 'Hello', Charset: 'UTF-8' },
          Body: {
            Html: { Data: '<p>Hello</p>', Charset: 'UTF-8' },
            Text: { Data: 'Hello', Charset: 'UTF-8' },
          },
        },
      },
    })
  })

  test('send() omits ReplyToAddresses when there is no replyTo', async () => {
    const fake = fakeClient({ MessageId: 'ses-msg-1' })
    const provider = createSesSendProvider({
      client: fake.client,
      configurationSetName: 'events',
    })

    const { replyTo: _replyTo, ...withoutReplyTo } = message
    await provider.send(withoutReplyTo)

    expect(fake.commands[0]!.input).not.toHaveProperty('ReplyToAddresses')
  })

  test('send() ignores the idempotency key — SES has none', async () => {
    const fake = fakeClient({ MessageId: 'ses-msg-1' })
    const provider = createSesSendProvider({
      client: fake.client,
      configurationSetName: 'events',
    })

    await provider.send({ ...message, idempotencyKey: 'send-42' })

    expect(JSON.stringify(fake.commands[0]!.input)).not.toContain('send-42')
  })

  test('send() passes tags as EmailTags', async () => {
    const fake = fakeClient({ MessageId: 'ses-msg-1' })
    const provider = createSesSendProvider({
      client: fake.client,
      configurationSetName: 'events',
    })

    await provider.send({
      ...message,
      tags: { template: 'fpp-sender', source: 'route' },
    })

    expect(fake.commands[0]!.input.EmailTags).toEqual([
      { Name: 'template', Value: 'fpp-sender' },
      { Name: 'source', Value: 'route' },
    ])
  })

  test('send() sanitizes tag names and values to what SES accepts', async () => {
    const fake = fakeClient({ MessageId: 'ses-msg-1' })
    const provider = createSesSendProvider({
      client: fake.client,
      configurationSetName: 'events',
    })

    await provider.send({
      ...message,
      tags: { 'my tag': 'a b/c:d' },
    })

    expect(fake.commands[0]!.input.EmailTags).toEqual([{ Name: 'my_tag', Value: 'a_b_c_d' }])
  })

  test('send() omits EmailTags without tags', async () => {
    const fake = fakeClient({ MessageId: 'ses-msg-1' })
    const provider = createSesSendProvider({
      client: fake.client,
      configurationSetName: 'events',
    })

    await provider.send(message)
    await provider.send({ ...message, tags: {} })

    for (const command of fake.commands) {
      expect(command.input).not.toHaveProperty('EmailTags')
    }
  })

  test('send() throws when SES returns no MessageId', async () => {
    const provider = createSesSendProvider({
      client: fakeClient({}).client,
      configurationSetName: 'events',
    })

    await expect(provider.send(message)).rejects.toThrow('no MessageId')
  })

  test('send() propagates a client failure', async () => {
    const provider = createSesSendProvider({
      client: {
        send: async () => {
          throw new Error('MessageRejected')
        },
      } as never,
      configurationSetName: 'events',
    })

    await expect(provider.send(message)).rejects.toThrow('MessageRejected')
  })
})

describe('sanitizeSesTag', () => {
  test('keeps the allowed characters', () => {
    expect(sanitizeSesTag('Aa09_-.@')).toBe('Aa09_-.@')
  })

  test('replaces everything else with an underscore', () => {
    expect(sanitizeSesTag('a b+c/d\u00e9')).toBe('a_b_c_d_')
  })

  test('caps the length at 256', () => {
    expect(sanitizeSesTag('x'.repeat(300))).toHaveLength(256)
  })
})
