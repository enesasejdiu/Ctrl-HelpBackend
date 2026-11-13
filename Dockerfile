# Production image for the TicketFlow API. README "Docker" explains how to build, run and migrate.
# Two stages: "deps" installs the production dependencies; the final image gets those plus the app's own code only
# (src/, scripts/, migrations/, package.json). Tests, docs, .env, backups, uploads and dev tools never get in
# (see also .dockerignore).

# Pinned to an exact version, so a rebuild never silently changes Node or Alpine. Update it on purpose.
ARG NODE_IMAGE=node:24.22.3-alpine3.24

# ---- deps: production dependencies only, exactly as in package-lock.json ----
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# ---- final image ----
FROM ${NODE_IMAGE}

# tini runs as PID 1: it passes docker stop's SIGTERM and Ctrl+C's SIGINT on to Node (which then shuts down gracefully,
# src/shutdown.js) and reaps zombie processes. So no --init is needed on docker run.
RUN apk add --no-cache tini

# DOTENV_CONFIG_QUIET: there is never a .env in the image (settings come from docker run -e / --env-file), so dotenv's
# "injected env (0) from .env" line is only noise
ENV NODE_ENV=production \
    PORT=5050 \
    DOTENV_CONFIG_QUIET=true
WORKDIR /app

# The app's files belong to root and are read-only for the "node" user that runs it. Only the folders it writes to
# belong to "node": uploads/ (UPLOAD_DIR's default; mount a volume there) and backups/ (db:migrate's backup).
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY scripts ./scripts
COPY migrations ./migrations
RUN mkdir -p uploads backups && chown node:node uploads backups

USER node

EXPOSE 5050

# Healthy once GET /api/health answers 200. Uses Node's own fetch (Alpine has no curl).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 5050) + '/api/health').then((r) => process.exit(r.status === 200 ? 0 : 1), () => process.exit(1))"]

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/server.js"]
