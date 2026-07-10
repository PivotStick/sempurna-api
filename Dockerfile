# syntax=docker/dockerfile:1.7
# ─── Builder ─────────────────────────────────────────────────────────────────
# Install deps in a fat stage. `--frozen-lockfile` enforces bun.lock parity.
FROM oven/bun:1-slim AS builder
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# ─── Runtime ─────────────────────────────────────────────────────────────────
# Slim image, non-root user, only the artifacts we actually need.
FROM oven/bun:1-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

COPY --from=builder /app/node_modules ./node_modules
COPY package.json bun.lock ./
COPY src ./src

# Drop privileges. The bun image ships a `bun` user (uid 1000) we can reuse.
USER bun

EXPOSE 3000

# Health probe — matches the /health endpoint mounted in src/index.js.
HEALTHCHECK --interval=30s --timeout=3s --retries=3 --start-period=10s \
	CMD bun -e "fetch('http://127.0.0.1:' + (process.env.PORT ?? 3000) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["bun", "src/index.js"]
