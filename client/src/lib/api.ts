import { api } from "./eden";
import type {
  AccountInfo,
  MessageDetail,
  MessageList,
  SendLogList,
  Stats,
  SubmissionList,
  TemplateList,
} from "./types";

function toError(error: unknown): Error {
  if (error instanceof Error) return error;
  if (typeof error === "string") return new Error(error);
  return new Error(JSON.stringify(error));
}

export interface MessageFilters {
  account?: string;
  category?: string;
  needs_me?: "1";
  action_required?: "1";
  limit?: number;
  cursor?: string;
}

export async function listMessages(
  filters: MessageFilters = {},
): Promise<MessageList> {
  const { data, error } = await api.api.messages.get({ query: filters });
  if (error) throw toError(error);
  return data as unknown as MessageList;
}

export async function getMessage(key: string): Promise<MessageDetail> {
  const { data, error } = await api.api.messages({ key }).get({
    query: { include: "body" },
  });
  if (error) throw toError(error);
  return data as unknown as MessageDetail;
}

export async function setFlags(
  key: string,
  mailbox: string,
  change: { add?: string[]; remove?: string[]; set?: string[] },
): Promise<void> {
  const { error } = await api.api
    .messages({ key })
    .flags.post({ mailbox, ...change });
  if (error) throw toError(error);
}

export async function moveMessage(
  key: string,
  mailbox: string,
  toMailbox: string,
): Promise<void> {
  const { error } = await api.api.messages({ key }).move.post({
    mailbox,
    toMailbox,
  });
  if (error) throw toError(error);
}

export async function listSubmissions(
  cursor?: string,
): Promise<SubmissionList> {
  const { data, error } = await api.api.submissions.get({
    query: { limit: 50, cursor },
  });
  if (error) throw toError(error);
  return data as unknown as SubmissionList;
}

export async function getStats(): Promise<Stats> {
  const { data, error } = await api.api.stats.get();
  if (error) throw toError(error);
  return data as unknown as Stats;
}

export async function listAccounts(): Promise<AccountInfo[]> {
  const { data, error } = await api.api.accounts.get();
  if (error) throw toError(error);
  return data as unknown as AccountInfo[];
}

export async function listTemplates(): Promise<TemplateList> {
  const { data, error } = await api.api.templates.get();
  if (error) throw toError(error);
  return data as unknown as TemplateList;
}

export async function testSendTemplate(
  id: string,
): Promise<{ enqueued: boolean; sendLogId: string; jobId: string }> {
  const { data, error } = await api.api.templates({ id })["test-send"].post();
  if (error) throw toError(error);
  return data as unknown as {
    enqueued: boolean;
    sendLogId: string;
    jobId: string;
  };
}

export interface SendLogFilters {
  templateId?: string;
  cursor?: string;
}

export async function listSendLog(
  filters: SendLogFilters = {},
): Promise<SendLogList> {
  const { data, error } = await api.api["send-log"].get({
    query: { limit: 50, ...filters },
  });
  if (error) throw toError(error);
  return data as unknown as SendLogList;
}
