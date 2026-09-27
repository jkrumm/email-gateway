# syntax=docker/dockerfile:1
FROM oven/bun:1.4-alpine AS builder
WORKDIR /app

COPY package.json bun.lock tsconfig.json ./
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --production --ignore-scripts

COPY src ./src

FROM oven/bun:1.4-alpine AS runner
WORKDIR /app

RUN apk add --no-cache curl ca-certificates \
  && addgroup -S app && adduser -S app -G app \
  && mkdir -p /data && chown app:app /data

COPY --from=builder --chown=app:app /app/node_modules /app/node_modules
COPY --from=builder --chown=app:app /app/src /app/src
COPY --from=builder --chown=app:app /app/package.json /app/package.json

ENV NODE_ENV=production
ENV DATA_DIR=/data
EXPOSE 3010

USER app

HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://localhost:3010/health || exit 1

CMD ["bun", "run", "src/index.ts"]
