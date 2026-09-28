# syntax=docker/dockerfile:1
# The client SPA is built first: its `client/dist` is copied into the runner
# stage, where the Elysia service serves it at /app.
FROM oven/bun:1.4-alpine AS client-builder
WORKDIR /app
# The client is a workspace of the root package, so one root install (root
# manifests first, for layer caching) provides the hoisted `node_modules` the
# Vite build resolves against — including the single shared `elysia` that makes
# Eden's `App` import structurally compatible.
COPY package.json bun.lock ./
COPY client/package.json ./client/
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile
COPY client/ ./client/
# Eden's `App` type is imported type-only from ../../src/app — present so a
# type-only cross-package import resolves, and erased before the bundle.
COPY src ./src
RUN bun run build

FROM oven/bun:1.4-alpine AS builder
WORKDIR /app

# The workspace manifest must be present for the frozen install, but with
# `--production` its deps land in client/node_modules, not the root one the
# runner copies.
COPY package.json bun.lock tsconfig.json ./
COPY client/package.json ./client/
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --production --ignore-scripts

COPY src ./src
COPY scripts ./scripts

FROM oven/bun:1.4-alpine AS runner
WORKDIR /app

RUN apk add --no-cache curl ca-certificates \
  && addgroup -S app && adduser -S app -G app \
  && mkdir -p /data && chown app:app /data

COPY --from=builder --chown=app:app /app/node_modules /app/node_modules
COPY --from=builder --chown=app:app /app/src /app/src
COPY --from=builder --chown=app:app /app/scripts /app/scripts
COPY --from=builder --chown=app:app /app/package.json /app/package.json
COPY --from=client-builder --chown=app:app /app/client/dist /app/client/dist

ENV NODE_ENV=production
ENV DATA_DIR=/data
EXPOSE 3010

USER app

HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://localhost:3010/health || exit 1

CMD ["bun", "run", "src/index.ts"]
