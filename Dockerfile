# Stage 1: install deps and build
FROM oven/bun:1.2.14-alpine AS builder

WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

COPY . .

# Build server and bridge bundles into dist/ with distinct names.
# Both source files are named index.ts, so without --outfile the second build
# silently overwrites dist/index.js produced by the first.
RUN bun build src/server/index.ts --outfile dist/server.js --target bun --minify
RUN bun build src/bridge/index.ts --outfile dist/bridge.js --target bun --minify

# Stage 2: minimal runtime image
FROM oven/bun:1.2.14-alpine AS runtime

WORKDIR /app

# Copy only the built artifacts and any runtime-required files
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src/infra/db/migrations ./src/infra/db/migrations
COPY --from=builder /app/package.json ./package.json

# SQLite data directory (mount a volume in production)
RUN mkdir -p /app/data

ENV PORT=3000
ENV TEAMEM_DB_PATH=/app/data/teamem.db
ENV TEAMEM_MIGRATIONS_DIR=/app/src/infra/db/migrations

EXPOSE 3000

# Graceful shutdown: Bun handles SIGTERM; WAL is flushed by SQLite on close.
# The server calls db.close() in the SIGTERM handler below via the entrypoint.
CMD ["bun", "run", "dist/server.js"]
