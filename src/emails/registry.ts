import { createElement, type ComponentType, type FunctionComponent } from 'react'
import AthenaCodeMail, { athenaCodeSecrets, type AthenaCodeProps } from './athena/code-mail'
import FppDailyAnalytics, { type FppDailyAnalyticsProps } from './fpp/fpp-daily-analytics'
import FppReceiverMail, { type FppReceiverProps } from './fpp/fpp-receiver-mail'
import FppSenderMail, { type FppSenderMailProps } from './fpp/fpp-sender-mail'
import JkrummContactReceiverMail, {
  type JkrummContactReceiverProps,
} from './jkrumm/contact-receiver-mail'
import ShutterflowCodeMail, { type ShutterflowCodeProps } from './shutterflow/code-mail'
import SySerendipityConfirmationMail, {
  type SySerendipityConfirmationProps,
} from './sy-serendipity/request-confirmation-mail'
import SySerendipityRequestMail, {
  type SySerendipityRequestProps,
} from './sy-serendipity/request-receiver-mail'

// The single source of truth for every template id: the registry entries
// below, the send routes' send_log `source`, and the API routes all reference
// these instead of repeating the literal, so a rename can't drift out of sync.
// src/emails/registry.test.ts fails the suite on any mismatch.
export const TEMPLATE_IDS = {
  fppSender: 'fpp-sender',
  fppReceiver: 'fpp-receiver',
  fppDailyAnalytics: 'fpp-daily-analytics',
  sySerendipityRequest: 'sy-serendipity-request',
  sySerendipityConfirmation: 'sy-serendipity-confirmation',
  jkrummContactReceiver: 'jkrumm-contact-receiver',
  shutterflowCode: 'shutterflow-code',
  athenaCode: 'athena-code',
} as const

export interface EmailTemplateEntry<Props> {
  id: string
  name: string
  component: FunctionComponent<Props>
  previewProps: Props
  // The secret substrings of a send (an auth code) that must not survive in
  // the stored copy of its rendered mail: src/utils/send-body.ts replaces
  // every occurrence with "[redacted]" before the body is kept.
  redact?: (props: Props) => string[]
}

export const emailRegistry: [
  EmailTemplateEntry<FppSenderMailProps>,
  EmailTemplateEntry<FppReceiverProps>,
  EmailTemplateEntry<FppDailyAnalyticsProps>,
  EmailTemplateEntry<SySerendipityRequestProps>,
  EmailTemplateEntry<SySerendipityConfirmationProps>,
  EmailTemplateEntry<JkrummContactReceiverProps>,
  EmailTemplateEntry<ShutterflowCodeProps>,
  EmailTemplateEntry<AthenaCodeProps>,
] = [
  {
    id: TEMPLATE_IDS.fppSender,
    name: 'FPP – contact confirmation',
    component: FppSenderMail,
    previewProps: FppSenderMail.PreviewProps,
  },
  {
    id: TEMPLATE_IDS.fppReceiver,
    name: 'FPP – contact form submission',
    component: FppReceiverMail,
    previewProps: FppReceiverMail.PreviewProps,
  },
  {
    id: TEMPLATE_IDS.fppDailyAnalytics,
    name: 'FPP – daily analytics',
    component: FppDailyAnalytics,
    previewProps: FppDailyAnalytics.PreviewProps,
  },
  {
    id: TEMPLATE_IDS.sySerendipityRequest,
    name: 'SY Serendipity – charter request',
    component: SySerendipityRequestMail,
    previewProps: SySerendipityRequestMail.PreviewProps,
  },
  {
    id: TEMPLATE_IDS.sySerendipityConfirmation,
    name: 'SY Serendipity – request confirmation',
    component: SySerendipityConfirmationMail,
    previewProps: SySerendipityConfirmationMail.PreviewProps,
  },
  {
    id: TEMPLATE_IDS.jkrummContactReceiver,
    name: 'jkrumm.com – contact message',
    component: JkrummContactReceiverMail,
    previewProps: JkrummContactReceiverMail.PreviewProps,
  },
  {
    id: TEMPLATE_IDS.shutterflowCode,
    name: 'Shutterflow – auth code',
    component: ShutterflowCodeMail,
    previewProps: ShutterflowCodeMail.PreviewProps,
    redact: ({ code }) => [code],
  },
  {
    id: TEMPLATE_IDS.athenaCode,
    name: 'Athena – sign-in code',
    component: AthenaCodeMail,
    previewProps: AthenaCodeMail.PreviewProps,
    // The code, plain and as the mail shows it ("482 915").
    redact: ({ code }) => athenaCodeSecrets(code),
  },
]

// The one lookup every template-id caller shares (src/api/plugin.ts's
// preview/test-send routes, src/jobs/send.ts's handler) — never the DB,
// since the registry is the source of truth for what's actually renderable.
export function findTemplateEntry(id: string) {
  return emailRegistry.find((item) => item.id === id) ?? null
}

// The one render call every entry-rendering caller shares (src/api/plugin.ts's
// preview route, src/jobs/send.ts's handler). previewProps/templateProps has
// no per-template schema until a future wave grows one — a single cast down
// to each entry's own component type is the accepted gap until then
// (narrower than `never`, which would disable type checking on this call
// entirely).
export function renderTemplateElement(
  entry: NonNullable<ReturnType<typeof findTemplateEntry>>,
  props: unknown = entry.previewProps,
) {
  return createElement(
    entry.component as unknown as ComponentType<Record<string, unknown>>,
    props as Record<string, unknown>,
  )
}

// The secrets an entry's `redact` names for these props; none for an entry
// without one. Throws if `redact` does (malformed props) or yields anything
// but non-empty strings — the caller must then not store the body. An empty
// result for an entry that declares `redact` is the caller's to treat as
// "cannot redact".
export function templateSecrets(
  entry: NonNullable<ReturnType<typeof findTemplateEntry>>,
  props: unknown,
): string[] {
  const redact = entry.redact as ((props: unknown) => string[]) | undefined
  if (!redact) return []
  const secrets = redact(props)
  if (!Array.isArray(secrets) || !secrets.every((s) => typeof s === 'string' && s.length > 0)) {
    throw new Error('template redact yielded a non-string or empty secret')
  }
  return secrets
}
