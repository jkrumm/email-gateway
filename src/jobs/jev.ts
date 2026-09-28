import type { MailSubmissionsRepo } from "../db/mail-submissions";
import type { MessagesRepo } from "../db/messages";
import {
  mailSubmissionsRepo as defaultMailSubmissions,
  messagesRepo as defaultMessages,
} from "../db/mail-index";
import { providerForAccountId as defaultProviderFor } from "../providers/from-env";
import { getJevConfig } from "../llm/jev";
import { judgeSubmissionWithJev as defaultJudgeSubmission } from "../spam/jev-judge";
import { judgeEmailWithJev as defaultJudgeEmail } from "../enrich/jev-email";
import { buildEmailPayload } from "../enrich/enrich-email";
import type { MailProvider, MessageRef } from "../providers/port";
import type { JobHandler } from "./runner";

export interface JevSubmissionJobPayload {
  id: string;
}

// The `jev_submission` job: replaces src/jev/worker.ts's submission drain
// loop. Only success writes a result — a thrown error (a Jev 429 included)
// is the job runner's retry signal (src/jobs/runner.ts now classifies it via
// isRateLimitError and parks it without spending an attempt).
export function createJevSubmissionHandler({
  submissions = defaultMailSubmissions,
  judgeSubmission = defaultJudgeSubmission,
  config = () => getJevConfig(),
}: {
  submissions?: Pick<MailSubmissionsRepo, "getSubmission" | "saveJevResult">;
  judgeSubmission?: typeof defaultJudgeSubmission;
  config?: () => ReturnType<typeof getJevConfig>;
} = {}): JobHandler {
  return async (payload) => {
    const { id } = payload as JevSubmissionJobPayload;

    const submission = submissions.getSubmission(id);
    if (!submission) {
      console.log(`[jev_submission] submission ${id} not found — skipping`);
      return;
    }

    const jevConfig = config();
    if (!jevConfig) {
      // Defensive: enqueue-time already gates on Jev being configured, so
      // this only fires if config vanished between enqueue and claim.
      console.log("[jev_submission] Jev not configured — skipping");
      return;
    }

    // Non-null assertion targets the resolved value, not the Promise itself
    // (postfix `!` binds tighter than `await`) — safe here because the
    // `!jevConfig` guard above already rules out judgeSubmission()'s only
    // null-returning case.
    const result = (await judgeSubmission({
      source: submission.source,
      submission: submission.submission,
      config: jevConfig,
    }))!;

    submissions.saveJevResult(id, {
      verdict: result.verdict,
      confidence: result.confidence,
      probabilities: result.probabilities,
      latencyMs: result.latencyMs,
      model: result.model,
    });
  };
}

export interface JevMessageJobPayload {
  key: string;
}

// The `jev_message` job: replaces src/jev/worker.ts's inbound-email drain
// loop. Needs the live body — reuses body_cache if it's already fresh
// (filled by the classify job moments earlier in the common path), otherwise
// fetches live via the provider, same as classify.
export function createJevMessageHandler({
  messages = defaultMessages,
  providerFor = defaultProviderFor,
  judgeEmail = defaultJudgeEmail,
  config = () => getJevConfig(),
}: {
  messages?: Pick<
    MessagesRepo,
    "getMessage" | "getBody" | "saveJevClassification"
  >;
  providerFor?: (accountId: string) => MailProvider | null;
  judgeEmail?: typeof defaultJudgeEmail;
  config?: () => ReturnType<typeof getJevConfig>;
} = {}): JobHandler {
  return async (payload) => {
    const { key } = payload as JevMessageJobPayload;

    const message = messages.getMessage(key);
    if (!message) {
      console.log(`[jev_message] message ${key} not found — skipping`);
      return;
    }

    const jevConfig = config();
    if (!jevConfig) {
      console.log("[jev_message] Jev not configured — skipping");
      return;
    }

    const cached = messages.getBody(key);
    let html = cached?.html ?? null;
    let text = cached?.text ?? null;

    if (!cached) {
      const location = message.locations[0];
      if (!location) {
        throw new Error(
          `jev_message: message ${key} has no location to read from`,
        );
      }
      const provider = providerFor(message.account);
      if (!provider) {
        throw new Error(
          `jev_message: no configured provider for account "${message.account}"`,
        );
      }
      const full = await provider.read(location.providerRef as MessageRef);
      html = full.html;
      text = full.text;
    }

    const payloadForJev = buildEmailPayload({
      direction: message.direction,
      fromAddress: message.fromAddress ?? "",
      toAddresses: message.toAddresses,
      subject: message.subject ?? "",
      text,
      html,
    });

    // See the identical note in createJevSubmissionHandler above.
    const result = (await judgeEmail({
      payload: payloadForJev,
      config: jevConfig,
    }))!;

    // Writes ONLY the jev_* columns — no read-merge-write needed. A
    // concurrent `classify` job (LLM enrichment) for the same key writes
    // only its own columns too (saveEnrichment), so the two can never
    // clobber each other regardless of commit order.
    messages.saveJevClassification(key, {
      jevSpamProbability: result.spamProbability,
      jevCategory: result.category,
      jevCategoryConfidence: result.categoryConfidence,
      jevLatencyMs: result.latencyMs,
      jevModel: result.model,
      jevError: null,
    });
  };
}
