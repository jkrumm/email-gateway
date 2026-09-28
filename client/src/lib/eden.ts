import { treaty } from "@elysia/eden";
import type { App } from "../../../src/app";

// Same-origin in production (the Elysia service serves this SPA at /app and
// the API at /api); the Vite dev server proxies /api to the local Elysia port.
// Typed against the server's own `App` export so a route shape change is a
// build error here.
export const api = treaty<App>(window.location.origin, {
  fetch: { credentials: "same-origin" },
});
