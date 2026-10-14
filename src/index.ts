import { app } from "./app";
import { env } from "./env";
import { syncTemplateRegistry } from "./emails/sync-registry";
import { startJobSystem } from "./jobs/register";
import { log } from "./telemetry/log";
import { flushOtel } from "./telemetry/otel";

app.listen(env.PORT);
// Must never take startJobSystem() down with it — a boot-time DB hiccup here
// (e.g. SQLITE_BUSY during the two-container deploy overlap) would otherwise
// leave sync/classify/send all dark behind a health check that
// only pings the process, not the job system.
try {
  syncTemplateRegistry();
} catch (error) {
  log.error("[boot] syncTemplateRegistry failed", { error });
}
startJobSystem();

// A rolling deploy stops the old container with SIGTERM: ship the last spans
// and logs before exiting, but never hold the stop up for a slow collector.
const SHUTDOWN_FLUSH_DEADLINE_MS = 2_000;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    void Promise.race([flushOtel(), Bun.sleep(SHUTDOWN_FLUSH_DEADLINE_MS)])
      .catch(() => {})
      .finally(() => process.exit(0));
  });
}

log.info(
  `🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port} with NODE_ENV=${process.env.NODE_ENV} 🦊`,
);
