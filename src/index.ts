import { app } from "./app";
import { env } from "./env";
import { syncTemplateRegistry } from "./emails/sync-registry";
import { startJobSystem } from "./jobs/register";

app.listen(env.PORT);
// Must never take startJobSystem() down with it — a boot-time DB hiccup here
// (e.g. SQLITE_BUSY during the two-container deploy overlap) would otherwise
// leave sync/classify/send/reconcile all dark behind a health check that
// only pings the process, not the job system.
try {
  syncTemplateRegistry();
} catch (error) {
  console.error("[boot] syncTemplateRegistry failed", { error });
}
startJobSystem();

console.log(
  `🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port} with NODE_ENV=${process.env.NODE_ENV} 🦊`,
);
