// Which SendProvider a template sends through. Pure on purpose: src/env.ts
// validates SEND_PROVIDERS with parseSendProviders at import time, so this
// module must not import src/env.ts (or anything that does) — the provider
// registry that builds the real clients lives in send-registry.ts.
import { TEMPLATE_IDS } from "../emails/registry";

export const SEND_PROVIDER_NAMES = ["resend"] as const;
export type SendProviderName = (typeof SEND_PROVIDER_NAMES)[number];

const DEFAULT_SEND_PROVIDER: SendProviderName = "resend";

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
