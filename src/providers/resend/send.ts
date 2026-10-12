import type { Resend } from "resend";
import type { SendProvider } from "../send-port";

// Only what each half calls — narrower than the full SDK so a provider-scoped
// client (src/providers/resend/client.ts) or a test fake can be injected.
// Separate send/read clients because the send key is restricted: reading a
// message back needs the full-access key (src/utils/resend.ts's adminResend).
type ResendSendOnly = { emails: Pick<Resend["emails"], "send"> };
type ResendReadOnly = { emails: Pick<Resend["emails"], "get"> };

export function createResendSendProvider({
  sendClient,
  readClient,
}: {
  sendClient: ResendSendOnly;
  readClient: ResendReadOnly;
}): SendProvider {
  return {
    id: "resend",
    async send({ idempotencyKey, ...message }) {
      const email = await sendClient.emails.send(
        message,
        idempotencyKey ? { idempotencyKey } : undefined,
      );
      if (email.error) {
        throw new Error(
          `${email.error.statusCode ?? ""} - ${email.error.name} - ${email.error.message}`,
        );
      }
      return { providerMessageId: email.data.id };
    },
    async status(providerMessageId) {
      const response = await readClient.emails.get(providerMessageId);
      if (response.error) throw new Error(response.error.message);
      return {
        status: response.data.last_event,
        lastEvent: response.data.last_event,
      };
    },
  };
}
