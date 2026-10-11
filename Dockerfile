# Multi-stage: build compiles TS with all devDeps, runtime only carries
# what's needed to run. node:24-alpine already has wget (BusyBox) -- no RUN
# apk add, verified before writing this.

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

FROM node:24-alpine
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist
COPY public ./public

# /data is where Coolify's persistent volume mounts (DB_FILE=/data/dca.db).
# chown BEFORE the volume is mounted: Docker copies this ownership into a
# NAMED volume on first mount, so the non-root process can write --
# including SQLite's -wal/-shm sidecars, which need the DIRECTORY to be
# writable, not just the database file. This does NOT work with a bind
# mount (arrives as root) -- see the README for the right Coolify setup
# (README.md, Docker and Coolify).
RUN mkdir -p /data && chown -R node:node /data

USER node

EXPOSE 8787

# Shell form (not array) -- so ${APP_PORT:-...} expands at runtime.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${APP_PORT:-8787}/health" || exit 1

# The app (server.ts) is the container's main process -- it keeps the
# container alive so Coolify's Scheduled Task can run
# "node dist/src/dca.js" (the bot) via docker exec (E2/Phase 6).
CMD ["node", "dist/src/server.js"]
