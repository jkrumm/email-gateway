import { hostname } from "node:os";
import { createJobQueue, defaultClaimedBy } from "../db/jobs";
import { mailDb } from "../db/mail-index";
import type { JobQueue } from "../db/jobs";

// The one production JobQueue singleton, shared by every enqueue call site
// (src/spam/gate.ts, the classify/jev handlers' injected enqueue callbacks)
// and src/jobs/register.ts's runner — createJobQueue's own ensureJobsSchema
// is idempotent, and every caller points at the same mailDb, so one shared
// instance is simplest.
//
// Built lazily, behind the same kind of Proxy src/db/mail-client.ts uses for
// `mailDb`: `createJobQueue({ db: mailDb, ... })` itself calls
// `ensureJobsSchema(db)` — a synchronous `db.run(...)` — at construction
// time, which would otherwise open the real mail.sqlite file (and run its
// migrations) the moment this module is merely imported by
// src/api/plugin.ts, src/admin/plugin.tsx or src/spam/gate.ts, defeating
// `mailDb`'s whole "importing never touches the filesystem" contract.
let jobQueueInstance: JobQueue | null = null;
function getJobQueue(): JobQueue {
  return (jobQueueInstance ??= createJobQueue({
    db: mailDb,
    claimedBy: defaultClaimedBy(hostname(), process.pid),
  }));
}

export const jobQueue: JobQueue = new Proxy({} as JobQueue, {
  get(_target, prop, _receiver) {
    const instance = getJobQueue();
    const value = Reflect.get(instance, prop, instance);
    return typeof value === "function" ? value.bind(instance) : value;
  },
});

// The literal `{ kind: "sync_tick", payload: {}, subjectKey: "tick" }` is
// duplicated across src/jobs/register.ts's periodic timer and the API
// `POST /api/sync` route. The "tick"
// subjectKey is load-bearing (docs/architecture.md §Jobs's "only one
// sync_tick ever pending" invariant) — one shared helper keeps every call
// site from drifting.
export function enqueueSyncTick(queue: JobQueue): void {
  queue.enqueue({ kind: "sync_tick", payload: {}, subjectKey: "tick" });
}

// Mirrors enqueueSyncTick: the 5-minute periodic timer re-runs the Resend
// send_log reconciliation so a status that changed after the send job
// recorded "sent" (delivered, bounced, …) is picked up.
export function enqueueReconcileSendLog(queue: JobQueue): void {
  queue.enqueue({
    kind: "reconcile_send_log",
    payload: {},
    subjectKey: "reconcile_send_log",
  });
}
