import type { SESv2Client } from "@aws-sdk/client-sesv2";
import { env } from "../env";
import { createSesSendProvider } from "./ses/send";
import type { SendProvider } from "./send-port";

// Composition root for the one SendProvider (SES): built once, lazily, from
// the process-wide env.
let built: SendProvider | undefined;

export function sendProvider(): SendProvider {
  if (built) return built;

  let client: SESv2Client | undefined;
  built = createSesSendProvider({
    // Built on first send so the SDK is not loaded at boot. Explicit
    // credentials only — no ambient AWS credential chain.
    client: {
      send: async (command: Parameters<SESv2Client["send"]>[0]) => {
        if (!client) {
          const { SESv2Client } = await import("@aws-sdk/client-sesv2");
          client = new SESv2Client({
            region: env.SES_REGION,
            credentials: {
              accessKeyId: env.SES_ACCESS_KEY_ID,
              secretAccessKey: env.SES_SECRET_ACCESS_KEY,
            },
          });
        }
        return client.send(command);
      },
    } as Pick<SESv2Client, "send">,
    configurationSetName: env.SES_CONFIGURATION_SET,
  });
  return built;
}

// Null for a name no provider is registered under (e.g. a send_log row
// written by a build that knew a provider this one does not).
export function sendProviderByName(name: string): SendProvider | null {
  if (name !== "ses") return null;
  return sendProvider();
}
