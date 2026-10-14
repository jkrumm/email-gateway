import type { SendBodiesRepo } from "../db/send-bodies";
import { SEND_BODY_RETENTION_MS } from "../db/send-bodies";
import type { SendLogRepo } from "../db/send-log";
import {
  sendBodiesRepo as defaultSendBodies,
  sendLogRepo as defaultSendLog,
} from "../db/mail-index";
import type { JobQueue } from "../db/jobs";
import type { JobHandler } from "./runner";
import { log } from "../telemetry/log";

// The `prune_send_bodies` job kind: deletes the rendered mail kept for review
// once it is older than SEND_BODY_RETENTION_MS (30 days), and the send_events
// timeline with it (same cutoff). Enqueued daily by src/jobs/register.ts;
// deleting twice is harmless, so the at-least-once retry needs no guard.
export function createPruneSendBodiesHandler({
  sendBodies = defaultSendBodies,
  sendLog = defaultSendLog,
  now = () => new Date(),
}: {
  sendBodies?: Pick<SendBodiesRepo, "pruneOlderThan">;
  sendLog?: Pick<SendLogRepo, "pruneEventsOlderThan">;
  now?: () => Date;
} = {}): JobHandler {
  return async () => {
    const cutoff = new Date(
      now().getTime() - SEND_BODY_RETENTION_MS,
    ).toISOString();
    const pruned = sendBodies.pruneOlderThan(cutoff);
    if (pruned > 0) log.info(`[jobs] pruned ${pruned} stored send bodies`);
    const prunedEvents = sendLog.pruneEventsOlderThan(cutoff);
    if (prunedEvents > 0) {
      log.info(`[jobs] pruned ${prunedEvents} send events`);
    }
  };
}

// One shared enqueue so the timer and any future caller agree on the
// subjectKey, like src/jobs/queue.ts's enqueueSyncTick.
export function enqueuePruneSendBodies(queue: JobQueue): void {
  queue.enqueue({
    kind: "prune_send_bodies",
    payload: {},
    subjectKey: "prune",
  });
}
