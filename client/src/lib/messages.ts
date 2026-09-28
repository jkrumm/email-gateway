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

export function compareMessages(a: MessageRow, b: MessageRow): number {
  const rankDiff = needsMeRank(b) - needsMeRank(a);
  return rankDiff !== 0 ? rankDiff : (b.date ?? "").localeCompare(a.date ?? "");
}
