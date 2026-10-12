import type { SendMessage, SendProvider } from "../providers/send-port";

// An in-memory SendProvider for tests of the send paths (sendMail, the send
// job, reconcile_send_log). Like a real provider it dedupes on the
// idempotency key: a repeat send with the same key returns the original
// message id without recording a second send, which is what lets a test
// prove the key actually closes the duplicate-send gap.
export interface FakeSendProviderOptions {
  id?: string;
  // Message id for each send; a fresh sequential one when omitted.
  providerMessageId?: string;
  // Make send() throw this message.
  sendError?: string;
  // providerMessageId -> delivery state status() reports (default "delivered").
  statuses?: Record<string, string>;
  // status() rejects for these provider message ids.
  failStatusFor?: ReadonlySet<string>;
  // status() never settles for these provider message ids.
  hangStatusFor?: ReadonlySet<string>;
  // Omit status() entirely, like a provider with no read-back.
  withoutStatus?: boolean;
}

export interface FakeSendProvider extends SendProvider {
  readonly sent: SendMessage[];
  readonly statusCalls: string[];
}

export function createFakeSendProvider({
  id = "fake",
  providerMessageId,
  sendError,
  statuses = {},
  failStatusFor = new Set<string>(),
  hangStatusFor = new Set<string>(),
  withoutStatus = false,
}: FakeSendProviderOptions = {}): FakeSendProvider {
  const sent: SendMessage[] = [];
  const statusCalls: string[] = [];
  const idsByKey = new Map<string, string>();

  const provider: FakeSendProvider = {
    id,
    sent,
    statusCalls,
    async send(message) {
      if (sendError) throw new Error(sendError);

      const key = message.idempotencyKey;
      const existing = key ? idsByKey.get(key) : undefined;
      if (existing) return { providerMessageId: existing };

      const messageId = providerMessageId ?? `${id}_msg_${sent.length + 1}`;
      sent.push(message);
      if (key) idsByKey.set(key, messageId);
      return { providerMessageId: messageId };
    },
  };

  if (withoutStatus) return provider;

  provider.status = async (messageId) => {
    statusCalls.push(messageId);
    if (hangStatusFor.has(messageId)) return new Promise<never>(() => {});
    if (failStatusFor.has(messageId)) {
      throw new Error(`${id} status error for ${messageId}`);
    }
    const status = statuses[messageId] ?? "delivered";
    return { status, lastEvent: status };
  };
  return provider;
}
