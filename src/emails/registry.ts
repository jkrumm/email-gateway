import {
  createElement,
  type ComponentType,
  type FunctionComponent,
} from "react";
import FppDailyAnalytics, {
  type FppDailyAnalyticsProps,
} from "./fpp/fpp-daily-analytics";
import FppReceiverMail, {
  type FppReceiverProps,
} from "./fpp/fpp-receiver-mail";
import FppSenderMail, { type FppSenderMailProps } from "./fpp/fpp-sender-mail";
import SySerendipityRequestMail, {
  type SySerendipityRequestProps,
} from "./sy-serendipity/request-receiver-mail";

// The single source of truth for every template id: the registry entries
// below, the send routes' send_log `source`, and the API routes all reference
// these instead of repeating the literal, so a rename can't drift out of sync.
// src/emails/registry.test.ts fails the suite on any mismatch.
export const TEMPLATE_IDS = {
  fppSender: "fpp-sender",
  fppReceiver: "fpp-receiver",
  fppDailyAnalytics: "fpp-daily-analytics",
  sySerendipityRequest: "sy-serendipity-request",
} as const;

export interface EmailTemplateEntry<Props> {
  id: string;
  name: string;
  component: FunctionComponent<Props>;
  previewProps: Props;
}

export const emailRegistry: [
  EmailTemplateEntry<FppSenderMailProps>,
  EmailTemplateEntry<FppReceiverProps>,
  EmailTemplateEntry<FppDailyAnalyticsProps>,
  EmailTemplateEntry<SySerendipityRequestProps>,
] = [
  {
    id: TEMPLATE_IDS.fppSender,
    name: "FPP – contact confirmation",
    component: FppSenderMail,
    previewProps: FppSenderMail.PreviewProps,
  },
  {
    id: TEMPLATE_IDS.fppReceiver,
    name: "FPP – contact form submission",
    component: FppReceiverMail,
    previewProps: FppReceiverMail.PreviewProps,
  },
  {
    id: TEMPLATE_IDS.fppDailyAnalytics,
    name: "FPP – daily analytics",
    component: FppDailyAnalytics,
    previewProps: FppDailyAnalytics.PreviewProps,
  },
  {
    id: TEMPLATE_IDS.sySerendipityRequest,
    name: "SY Serendipity – charter request",
    component: SySerendipityRequestMail,
    previewProps: SySerendipityRequestMail.PreviewProps,
  },
];

// The one lookup every template-id caller shares (src/api/plugin.ts's
// preview/test-send routes, src/jobs/send.ts's handler) — never the DB,
// since the registry is the source of truth for what's actually renderable.
export function findTemplateEntry(id: string) {
  return emailRegistry.find((item) => item.id === id) ?? null;
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
  );
}
