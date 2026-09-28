import type { Classification, MessageLocation } from "../../../src/db/messages";

export type { Classification, MessageLocation };

export interface MessageRow {
  key: string;
  account: string;
  direction: "inbound" | "outbound";
  fromAddress: string | null;
  toAddresses: string[];
  cc: string[] | null;
  subject: string | null;
  date: string | null;
  size: number | null;
  hasAttachments: boolean;
  threadKey: string | null;
  flags: string[];
  classification: Classification | null;
}

export interface MessageDetail extends MessageRow {
  locations: MessageLocation[];
  body?: { html: string | null; text: string | null; fetchedAt: string } | null;
}

export interface MessageList {
  rows: MessageRow[];
  nextCursor: string | null;
}

export interface Submission {
  id: string;
  receivedAt: string;
  source: "fpp" | "sy-serendipity";
  verdict: "legit" | "spam" | "marketing";
  confidence: number;
  reason: string;
  model: string | null;
  delivered: boolean;
  submission: Record<string, unknown>;
  llmLatencyMs: number | null;
  jev: {
    verdict: string | null;
    confidence: number | null;
    probabilities: Record<string, number> | null;
    latencyMs: number | null;
    model: string | null;
    error: string | null;
  };
}

export interface SubmissionList {
  data: Submission[];
  nextCursor: string | null;
}

export interface AccountSummary {
  id: string;
  provider: string;
  address: string;
  lastSuccessAt?: string | null;
  lastError?: string | null;
}

export interface Stats {
  messages: {
    total: number;
    inbound: number;
    outbound: number;
    byCategory: Record<string, number>;
  };
  jevComparison: unknown;
  jobs: { pending: number; failed: number };
  accounts: AccountSummary[];
}

export interface AccountInfo {
  id: string;
  provider: string;
  address: string;
}
