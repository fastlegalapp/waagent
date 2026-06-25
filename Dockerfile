# syntax=docker/dockerfile:1

# ── Builder ──────────────────────────────────────────────────────────────────
# Baileys pulls a native dependency (libsignal / curve25519) and a git-hosted
# package, so the build stage needs git + a C/C++ toolchain. These are dropped
# from the final image.
FROM node:20-bookworm-slim AS builder
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
      git python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install production deps only. (No lockfile is committed because one of the
# transitive deps is git-hosted; npm install resolves it at build time.)
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src

# ── Runtime ──────────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    AUTH_ROOT=/data/auth
WORKDIR /app

# curl is only for the container HEALTHCHECK.
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /data/auth && chown -R node:node /data

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/src ./src
COPY package.json ./

# Persist per-user WhatsApp link sessions across redeploys (mount a volume here).
VOLUME ["/data"]
EXPOSE 3000
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD curl -fsS "http://localhost:${PORT}/api/health" || exit 1

CMD ["node", "src/index.js"]
