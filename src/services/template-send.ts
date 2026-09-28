import type { Database } from "bun:sqlite";
import type { JobQueue } from "../db/jobs";
import type { SendLogRepo } from "../db/send-log";
import type { SendJobPayload } from "../jobs/send";
import { DEFAULT_FROM } from "../utils/send-mail";

// The one send_log-insert + send-job-enqueue sequence every template send
// shares (src/services/agent-api.ts's agent sends, src/api/plugin.ts's
// test-send route). Both writes run inside one db.transaction(): they are two
// independent, non-transactional writes otherwise, so a crash between them
// would leave an unreconcilable send_log row with no job behind it (
// listReconcilable needs a provider_message_id) while the caller already got
// back the jobId.
export interface EnqueueTemplateSendInput {
  templateId: string;
  to: string;
  subject: string;
  templateProps: unknown;
  requestedBy: string;
  replyTo?: string;
}

export function enqueueTemplateSend(
  { db, jobs, sendLog }: { db: Database; jobs: JobQueue; sendLog: SendLogRepo },
  input: EnqueueTemplateSendInput,
): { sendLogId: string; jobId: string } {
  return db.transaction(() => {
    const sendLogId = crypto.randomUUID();
    sendLog.insertSendLog({
      id: sendLogId,
      templateId: input.templateId,
      recipients: [input.to],
      provider: "resend",
      requestedBy: input.requestedBy,
    });
    const jobId = jobs.enqueue({
      kind: "send",
      payload: {
        id: sendLogId,
        from: DEFAULT_FROM,
        to: input.to,
        subject: input.subject,
        templateName: input.templateId,
        templateProps: input.templateProps,
        ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      } satisfies SendJobPayload,
      subjectKey: sendLogId,
    });
    return { sendLogId, jobId };
  })();
}
