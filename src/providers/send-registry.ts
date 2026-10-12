import type { SESv2Client } from "@aws-sdk/client-sesv2";
import { env } from "../env";
import { adminResend, resend } from "../utils/resend";
import { createResendSendProvider } from "./resend/send";
import { createSesSendProvider } from "./ses/send";
import type { SendProvider } from "./send-port";
import {
  resolveSendProviderName,
  SEND_PROVIDER_NAMES,
  sesConfigured,
  type SendProviderName,
} from "./send-select";

// Provider-selection composition root: builds each SendProvider once, lazily,
// from the process-wide clients. The pure parse/resolve half lives in
// send-select.ts so env.ts can validate SEND_PROVIDERS without importing this.
const builders: Record<SendProviderName, () => SendProvider> = {
  resend: () =>
    createResendSendProvider({ sendClient: resend, readClient: adminResend }),
  ses: () => {
    const {
      SES_REGION,
      SES_ACCESS_KEY_ID,
      SES_SECRET_ACCESS_KEY,
      SES_CONFIGURATION_SET,
    } = env;
    if (
      !SES_REGION ||
      !SES_ACCESS_KEY_ID ||
      !SES_SECRET_ACCESS_KEY ||
      !SES_CONFIGURATION_SET
    ) {
      throw new Error(
        "SES is not configured: set SES_REGION, SES_ACCESS_KEY_ID, SES_SECRET_ACCESS_KEY and SES_CONFIGURATION_SET",
      );
    }
    let client: SESv2Client | undefined;
    return createSesSendProvider({
      // Built on first send so the SDK is not loaded at boot. Explicit
      // credentials only — no ambient AWS credential chain.
      client: {
        send: async (command: Parameters<SESv2Client["send"]>[0]) => {
          if (!client) {
            const { SESv2Client } = await import("@aws-sdk/client-sesv2");
            client = new SESv2Client({
              region: SES_REGION,
              credentials: {
                accessKeyId: SES_ACCESS_KEY_ID,
                secretAccessKey: SES_SECRET_ACCESS_KEY,
              },
            });
          }
          return client.send(command);
        },
      } as Pick<SESv2Client, "send">,
      configurationSetName: SES_CONFIGURATION_SET,
    });
  },
};

const built = new Map<string, SendProvider>();

// Null for a name no provider is registered under (e.g. a send_log row
// written by a build that knew a provider this one does not).
export function sendProviderByName(name: string): SendProvider | null {
  const cached = built.get(name);
  if (cached) return cached;
  if (!(SEND_PROVIDER_NAMES as readonly string[]).includes(name)) return null;

  const provider = builders[name as SendProviderName]();
  // send_log.provider is written from provider.id and read back by name
  // (reconcile, the send job), so the two must be the same string.
  if (provider.id !== name) {
    throw new Error(
      `send provider "${name}" identifies as "${provider.id}"; ids must match their registry name`,
    );
  }
  built.set(name, provider);
  return provider;
}

// The provider name SEND_PROVIDERS picks for a template id — what
// enqueueTemplateSend stores in send_log.provider.
export function sendProviderNameFor(
  templateId: string | undefined,
): SendProviderName {
  return resolveSendProviderName(templateId, env.SEND_PROVIDERS);
}

export function sendProviderFor(templateId: string | undefined): SendProvider {
  return sendProviderByName(sendProviderNameFor(templateId))!;
}

// Every registered provider that can read delivery state back, keyed by id —
// the reconcile_send_log job's default.
export function statusProviders(): Record<string, SendProvider> {
  const providers: Record<string, SendProvider> = {};
  for (const name of SEND_PROVIDER_NAMES) {
    // An unconfigured SES (the default) cannot be built; it has no status()
    // anyway, so reconcile has nothing to ask it.
    if (name === "ses" && !sesConfigured(env)) continue;
    const provider = sendProviderByName(name);
    if (provider?.status) providers[provider.id] = provider;
  }
  return providers;
}
