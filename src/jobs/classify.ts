import type { MessagesRepo } from "../db/messages";
import { messagesRepo as defaultMessages } from "../db/mail-index";
import { providerForAccountId as defaultProviderFor } from "../providers/from-env";
import {
  enrichEmail as defaultEnrichEmail,
  type EmailForEnrichment,
} from "../enrich/enrich-email";
import { getLlmConfig } from "../llm/model";
import { getJevConfig } from "../llm/jev";
import type { MailProvider, MessageRef } from "../providers/port";
import type { JobHandler } from "./runner";

export interface ClassifyJobPayload {
  key: string;
}

// The `classify` job (docs/architecture.md §Jobs): reads a message's body
// live through its provider (never from the store), enriches it with the
// LLM, and — for inbound messages, once enriched — hands off to Jev via the
// injected enqueue callback. Replaces src/enrich/worker.ts's polling batch.
export function createClassifyHandler({
  messages = defaultMessages,
  providerFor = defaultProviderFor,
  enrichEmail = defaultEnrichEmail,
  isLlmConfigured = () => getLlmConfig() !== null,
  isJevConfigured = () => getJevConfig() !== null,
  enqueueJevMessage = () => {},
}: {
  messages?: Pick<MessagesRepo, "getMessage" | "saveBody" | "saveEnrichment">;
  providerFor?: (accountId: string) => MailProvider | null;
  enrichEmail?: typeof defaultEnrichEmail;
  isLlmConfigured?: () => boolean;
  isJevConfigured?: () => boolean;
  enqueueJevMessage?: (key: string) => void;
} = {}): JobHandler {
  return async (payload) => {
    const { key } = payload as ClassifyJobPayload;

    const message = messages.getMessage(key);
    if (!message) {
      console.log(`[classify] message ${key} not found — skipping`);
      return;
    }

    // Mirrors the old enrichment worker's early return (src/enrich/worker.ts):
    // an accidentally-enqueued classify job when the LLM is off no-ops
    // instead of burning through the job's attempt budget with no operator
    // signal beyond logs.
    if (!isLlmConfigured()) {
      console.log("[classify] LLM not configured — skipping");
      return;
    }

    const location = message.locations[0];
    if (!location) {
      throw new Error(`classify: message ${key} has no location to read from`);
    }

    const provider = providerFor(message.account);
    if (!provider) {
      throw new Error(
        `classify: no configured provider for account "${message.account}"`,
      );
    }

    const full = await provider.read(location.providerRef as MessageRef);
    messages.saveBody(key, { html: full.html, text: full.text });

    const forEnrichment: EmailForEnrichment = {
      direction: message.direction,
      fromAddress: message.fromAddress ?? "",
      toAddresses: message.toAddresses,
      subject: message.subject ?? "",
      text: full.text,
      html: full.html,
    };

    const outcome = await enrichEmail({ email: forEnrichment });
    if (!outcome.ok) {
      // A thrown error is the job runner's retry signal here — unlike the
      // old src/enrich/re-enrich.ts's applyEnrichmentOutcome, which stored
      // the error on the row for a manual re-enrich button. Jobs now own
      // retry/backoff, so storing an "error" classification would hide a
      // retryable failure behind a row that looks terminal.
      throw new Error(outcome.error);
    }

    messages.saveEnrichment(key, {
      category: outcome.result.category,
      priority: outcome.result.priority,
      actionRequired: outcome.result.actionRequired,
      summary: outcome.result.summary,
      suggestedAction: outcome.result.suggestedAction,
      language: outcome.result.language,
      facts: outcome.result.facts,
      model: outcome.result.model,
      error: null,
    });

    // Jev only judges inbound emails already enriched: src/db/emails.ts sets
    // jev_status='pending' only for inbound rows at insert time — replicate
    // that same direction filter at this enqueue point.
    if (message.direction === "inbound" && isJevConfigured()) {
      try {
        enqueueJevMessage(key);
      } catch (error) {
        // The classification itself already landed (line above) — a jobs-
        // table write failure here must not re-run the live IMAP read and
        // LLM call just to retry this same-process enqueue. Log and move on;
        // gate.ts's equivalent enqueue call is wrapped the same way.
        console.error(`[classify] failed to enqueue jev_message for ${key}`, {
          error,
        });
      }
    }
  };
}
