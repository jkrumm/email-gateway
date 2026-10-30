import type { SendMessage, SendProvider } from '../providers/send-port'

// An in-memory SendProvider for tests of the send paths (sendMail, the send
// job). Like a real provider it dedupes on the
// idempotency key: a repeat send with the same key returns the original
// message id without recording a second send, which is what lets a test
// prove the key actually closes the duplicate-send gap.
export interface FakeSendProviderOptions {
  id?: string
  // Message id for each send; a fresh sequential one when omitted.
  providerMessageId?: string
  // Make send() throw this message.
  sendError?: string
}

export interface FakeSendProvider extends SendProvider {
  readonly sent: SendMessage[]
}

export function createFakeSendProvider({
  id = 'fake',
  providerMessageId,
  sendError,
}: FakeSendProviderOptions = {}): FakeSendProvider {
  const sent: SendMessage[] = []
  const idsByKey = new Map<string, string>()

  return {
    id,
    sent,
    async send(message) {
      if (sendError) throw new Error(sendError)

      const key = message.idempotencyKey
      const existing = key ? idsByKey.get(key) : undefined
      if (existing) return { providerMessageId: existing }

      const messageId = providerMessageId ?? `${id}_msg_${sent.length + 1}`
      sent.push(message)
      if (key) idsByKey.set(key, messageId)
      return { providerMessageId: messageId }
    },
  }
}
