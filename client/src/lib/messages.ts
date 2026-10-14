import type { MessageRow } from "./types";
import { accountProvider } from "./format";

export function isUnread(message: MessageRow): boolean {
  return !message.flags.includes("\\Seen");
}

function classificationView(message: MessageRow): {
  actionRequired: boolean | null | undefined;
  category: string | null | undefined;
} {
  return {
    actionRequired: message.classification?.actionRequired,
    category: message.classification?.category,
  };
}

export function messageRowView(message: MessageRow): {
  provider: string;
  from: string;
  subject: string;
  unread: boolean;
  actionRequired: boolean | null | undefined;
  category: string | null | undefined;
} {
  return {
    provider: accountProvider(message.account),
    from: message.fromAddress ?? "—",
    subject: message.subject ?? "(no subject)",
    unread: isUnread(message),
    ...classificationView(message),
  };
}

function needsMeRank(message: MessageRow): number {
  return message.classification?.actionRequired ? 1 : 0;
}

// Eden Treaty revives ISO date strings into Date objects at runtime, whatever
// the static type says, so compare timestamps rather than strings.
function timestamp(value: string | Date | null | undefined): number {
  if (!value) return 0;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}

export function compareMessages(a: MessageRow, b: MessageRow): number {
  const rankDiff = needsMeRank(b) - needsMeRank(a);
  return rankDiff !== 0 ? rankDiff : timestamp(b.date) - timestamp(a.date);
}
