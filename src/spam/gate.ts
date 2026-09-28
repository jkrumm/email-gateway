import { classifySubmission, shouldSuppress } from "./classify";
import { getJevConfig } from "../llm/jev";
import { mailSubmissionsRepo } from "../db/mail-index";
import { jobQueue } from "../jobs/queue";
import type { ClassificationResult } from "./classify";
import type {
  InsertSubmissionInput,
  SubmissionSource,
} from "../db/mail-submissions";

// Callers of /fpp and /sy-serendipity are a Netlify function (~10-26s limit)
// and Cloudflare edge (~100s) — waiting for the full classifySubmission call
// (bounded only by its 30-min hang guard) would time them out. This deadline
// makes the delivery decision fail open instead; the classification keeps
// running in the background and its verdict is recorded late.
export const CLASSIFY_DECISION_DEADLINE_MS = 8_000;

type RecordSubmission = typeof mailSubmissionsRepo.insertSubmission;

// The new `submissions` table (src/db/mail-submissions.ts) has no
// jevPending/queue concept on the row itself — that state lives in `jobs`
// (kind `jev_submission`, subject_key = the row id) instead.
type Persist = (input: Omit<InsertSubmissionInput, "llmLatencyMs">) => void;

// Replaces the old kickJevWorker() nudge: enqueues a durable `jev_submission`
// job for the row insertSubmission() just created, instead of an in-memory
// drain-queue kick.
function defaultEnqueueJevSubmission(id: string): void {
  jobQueue.enqueue({
    kind: "jev_submission",
    payload: { id },
    subjectKey: id,
  });
}

export async function gateSubmission({
  source,
  submission,
  deliver,
  classify = classifySubmission,
  record = mailSubmissionsRepo.insertSubmission,
  jevEnabled = () => getJevConfig() !== null,
  enqueueJevSubmission = defaultEnqueueJevSubmission,
  deadlineMs = CLASSIFY_DECISION_DEADLINE_MS,
}: {
  source: SubmissionSource;
  submission: Record<string, string | number | null>;
  deliver: (opts: { subjectPrefix: string }) => Promise<void>;
  classify?: typeof classifySubmission;
  record?: RecordSubmission;
  jevEnabled?: () => boolean;
  enqueueJevSubmission?: (id: string) => void;
  deadlineMs?: number;
}): Promise<{ delivered: boolean }> {
  const startedAt = Date.now();
  let llmLatencyMs: number | null = null;
  const classification = classify({ source, submission }).then((verdict) => {
    llmLatencyMs = Date.now() - startedAt;
    return verdict;
  });

  // A DB write here must never turn an already-delivered (or intentionally
  // suppressed) submission into a 500 for the caller — that would make a
  // Netlify/Cloudflare retry and send a duplicate email. Log and move on.
  // Jev is shadow-only and never on this path: the row is queued as a
  // `jev_submission` job (src/jobs/jev.ts), which retries until it has a
  // verdict.
  //
  // The insert and the enqueue are deliberately NOT one transaction: an
  // earlier version wrapped both so an enqueue failure could never leave a
  // submission row with no job behind it — but that means a failure in the
  // non-authoritative, shadow-only Jev enqueue rolls back and discards the
  // AUTHORITATIVE, already-delivered submission record too, inverting the
  // fail-open invariant above (a missing Jev job is invisible and harmless;
  // a missing submission row is a real, silent loss). The submission commits
  // on its own; the enqueue is its own best-effort step, logged and moved on
  // if it fails.
  const persist: Persist = (input) => {
    let created: { id: string };
    try {
      created = record({ ...input, llmLatencyMs });
    } catch (error) {
      console.error("Failed to record submission", {
        error,
        source: input.source,
        verdict: input.verdict,
        delivered: input.delivered,
      });
      return;
    }

    if (!jevEnabled()) return;
    try {
      enqueueJevSubmission(created.id);
    } catch (error) {
      console.error("Failed to enqueue jev_submission", {
        error,
        id: created.id,
      });
    }
  };

  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<{ kind: "deadline" }>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "deadline" }), deadlineMs);
  });

  const winner = await Promise.race([
    classification.then(
      (verdict) => ({ kind: "classified" as const, verdict }) as const,
    ),
    deadline,
  ]);

  if (winner.kind === "classified") {
    clearTimeout(timer!);
    return handleClassified({
      source,
      submission,
      deliver,
      persist,
      verdict: winner.verdict,
    });
  }

  // Deadline won: fail open. The classification is still running — never
  // abort it, just stop waiting on it and record its verdict once it lands.
  console.log(`${source} submission: classification deadline hit, delivering`);

  try {
    await deliver({ subjectPrefix: "" });
  } catch (error) {
    void classification
      .then((verdict) =>
        persist({
          source,
          verdict: verdict.verdict,
          confidence: verdict.confidence,
          reason: `Decided after deadline: ${verdict.reason} · delivery failed`,
          model: verdict.model,
          delivered: false,
          submission,
        }),
      )
      .catch((backgroundError) => {
        console.error("Background classification failed after deadline", {
          source,
          error: backgroundError,
        });
      });
    throw error;
  }

  void classification
    .then((verdict) => {
      persist({
        source,
        verdict: verdict.verdict,
        confidence: verdict.confidence,
        reason: `Decided after deadline: ${verdict.reason}`,
        model: verdict.model,
        delivered: true,
        submission,
      });
      console.log(
        `${source} submission: late verdict verdict=${verdict.verdict} confidence=${verdict.confidence}`,
      );
    })
    .catch((error) => {
      console.error("Background classification failed after deadline", {
        source,
        error,
      });
    });

  return { delivered: true };
}

async function handleClassified({
  source,
  submission,
  deliver,
  persist,
  verdict,
}: {
  source: SubmissionSource;
  submission: Record<string, string | number | null>;
  deliver: (opts: { subjectPrefix: string }) => Promise<void>;
  persist: Persist;
  verdict: ClassificationResult;
}): Promise<{ delivered: boolean }> {
  if (shouldSuppress(verdict)) {
    persist({
      source,
      verdict: verdict.verdict,
      confidence: verdict.confidence,
      reason: verdict.reason,
      model: verdict.model,
      delivered: false,
      submission,
    });
    console.log(
      `${source} submission suppressed: verdict=${verdict.verdict} confidence=${verdict.confidence}`,
    );
    return { delivered: false };
  }

  const subjectPrefix = verdict.verdict !== "legit" ? "[Possible spam] " : "";

  try {
    await deliver({ subjectPrefix });
  } catch (error) {
    persist({
      source,
      verdict: verdict.verdict,
      confidence: verdict.confidence,
      reason: `${verdict.reason} · delivery failed`,
      model: verdict.model,
      delivered: false,
      submission,
    });
    throw error;
  }

  persist({
    source,
    verdict: verdict.verdict,
    confidence: verdict.confidence,
    reason: verdict.reason,
    model: verdict.model,
    delivered: true,
    submission,
  });
  console.log(`${source} submission delivered: verdict=${verdict.verdict}`);
  return { delivered: true };
}
