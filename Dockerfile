# syntax=docker/dockerfile:1
# SpotScope — multi-stage Bun build.
#   dev     → hot-reloading dev server (bun --watch)
#   build   → install + test gate, then prune to production deps
#   release → minimal runtime image (default target)

# ---- base: dependency layer shared by every stage --------------------------
FROM oven/bun:1.3.14 AS base
WORKDIR /app
# Copy only the manifest first so `bun install` is cached across source edits.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# ---- dev: full source + dev deps, watched ----------------------------------
FROM base AS dev
ENV NODE_ENV=development
COPY . .
EXPOSE 8787
EXPOSE 2237/udp
CMD ["bun", "--watch", "backend/index.ts"]

# ---- build: validate the tree, then strip dev deps -------------------------
FROM base AS build
COPY . .
RUN bun test                                          # gate: don't ship a failing tree
RUN rm -rf node_modules && bun install --frozen-lockfile --production

# ---- release: lean runtime, no toolchain/dev deps --------------------------
FROM oven/bun:1.3.14-slim AS release
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8787 \
    WSJTX_PORT=2237 \
    GT_DB=/data/gridtracker.sqlite
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/backend ./backend
COPY --from=build /app/frontend ./frontend
RUN mkdir -p /data
EXPOSE 8787
EXPOSE 2237/udp
CMD ["bun", "run", "backend/index.ts"]
