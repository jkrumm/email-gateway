import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { basaltViteConfig } from "basalt-ui/vite";

// The Elysia service serves this SPA same-origin at /app in production, so the
// build's `base` is /app/. In dev the SPA runs on Vite and proxies the api and
// the session endpoints to the local Elysia port.
//
// Local dev server: port 5173, i.e. `https://email-gateway-client.test` in the
// Caddy dev proxy — that one-line entry belongs in dotfiles/config/Caddyfile and
// is deliberately NOT added here (another repo, its own outward-facing commit).
const API_ORIGIN = process.env.API_ORIGIN ?? "http://localhost:3010";
const basalt = basaltViteConfig({
  port: 5173,
  // `apiTarget` keeps the `/api` prefix (the target includes it, and the proxy
  // strips it before forwarding — see basalt-ui/vite's own documentation).
  apiTarget: `${API_ORIGIN}/api`,
  enforcementNotice: false,
});

export default defineConfig({
  ...basalt,
  base: "/app/",
  server: {
    ...basalt.server,
    proxy: {
      ...basalt.server?.proxy,
      "/app/login": API_ORIGIN,
      "/app/logout": API_ORIGIN,
      "/app/session": API_ORIGIN,
    },
  },
  plugins: [
    tanstackRouter({ target: "react", autoCodeSplitting: true }),
    react(),
  ],
});
