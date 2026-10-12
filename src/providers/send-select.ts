// Which SendProvider a template sends through. Pure on purpose: src/env.ts
// validates SEND_PROVIDERS with parseSendProviders at import time, so this
// module must not import src/env.ts (or anything that does) — the provider
// registry that builds the real clients lives in send-registry.ts.
import { TEMPLATE_IDS } from "../emails/registry";

export const SEND_PROVIDER_NAMES = ["resend", "ses"] as const;
export type SendProviderName = (typeof SEND_PROVIDER_NAMES)[number];

const DEFAULT_SEND_PROVIDER: SendProviderName = "resend";

// The env keys SES needs to send. Only when all four are set is SES
// "configured": SEND_PROVIDERS may route to it and the registry may build it.
// SES_SNS_TOPIC_ARN is separate — it only gates the event webhook.
export const SES_SEND_ENV_KEYS = [
  "SES_REGION",
  "SES_ACCESS_KEY_ID",
  "SES_SECRET_ACCESS_KEY",
  "SES_CONFIGURATION_SET",
] as const;

type SesSendEnvKey = (typeof SES_SEND_ENV_KEYS)[number];

export function sesConfigured<T extends Partial<Record<SesSendEnvKey, string>>>(
  value: T,
): value is T & Record<SesSendEnvKey, string> {
  return SES_SEND_ENV_KEYS.every((key) => Boolean(value[key]));
}

// template id -> provider name, only for the templates SEND_PROVIDERS lists.
export type SendProviderMap = Readonly<Record<string, SendProviderName>>;

const TEMPLATE_ID_VALUES: readonly string[] = Object.values(TEMPLATE_IDS);

function isSendProviderName(name: string): name is SendProviderName {
  return (SEND_PROVIDER_NAMES as readonly string[]).includes(name);
}

// SEND_PROVIDERS format: `templateId=provider,templateId=provider`. Unset or
// blank -> empty map (everything on the default provider). Every problem is
// collected so a misconfigured env reports all of them at once.
export function parseSendProviders(raw: string | undefined): {
  map: SendProviderMap;
  issues: string[];
} {
  const map: Record<string, SendProviderName> = {};
  const issues: string[] = [];

  for (const segment of (raw ?? "").split(",")) {
    const entry = segment.trim();
    if (!entry) continue;

    const separator = entry.indexOf("=");
    const templateId = entry.slice(0, separator).trim();
    const providerName = entry.slice(separator + 1).trim();
    if (separator === -1 || !templateId || !providerName) {
      issues.push(`"${entry}" must look like templateId=provider`);
      continue;
    }
    if (!TEMPLATE_ID_VALUES.includes(templateId)) {
      issues.push(
        `unknown template id "${templateId}" (known: ${TEMPLATE_ID_VALUES.join(", ")})`,
      );
      continue;
    }
    if (!isSendProviderName(providerName)) {
      issues.push(
        `unknown provider "${providerName}" for "${templateId}" (known: ${SEND_PROVIDER_NAMES.join(", ")})`,
      );
      continue;
    }
    if (Object.hasOwn(map, templateId)) {
      issues.push(`duplicate template id "${templateId}"`);
      continue;
    }
    map[templateId] = providerName;
  }

  return { map, issues };
}

// A send with no template id (or one SEND_PROVIDERS does not list) goes to
// the default provider.
export function resolveSendProviderName(
  templateId: string | undefined,
  map: SendProviderMap,
): SendProviderName {
  if (templateId && Object.hasOwn(map, templateId)) return map[templateId]!;
  return DEFAULT_SEND_PROVIDER;
}
