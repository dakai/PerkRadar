# Official Node image publishes linux/amd64 and linux/arm64.
# Docker Desktop on a Mac builds the architecture of that machine; do not pin --platform.
FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
# Build while devDependencies are present, then drop them.
# next.config.mjs is plain JavaScript, so `next start` does not install TypeScript.
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
WORKDIR /app

# Debian slim ships grep but not wget. Dokploy's generated compose probes this
# service with `wget --header="Authorization: Bearer $PERKRADAR_ACCESS_TOKEN" ...
# | grep -q '"ok":true'`, and Traefik 3.6 drops containers that report unhealthy,
# so a missing wget replaces the page with a 404. Ship wget instead of asking
# every deployment platform to rewrite its probe.
RUN apt-get update \
 && apt-get install -y --no-install-recommends wget \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/next.config.mjs ./
COPY --from=build /app/scripts/serve.mjs ./scripts/serve.mjs
ENV HOST=0.0.0.0
ENV NODE_ENV=production
ENV DATA_DIR=/data
ENV PORT=38471

RUN mkdir -p /data && chown -R node:node /data
VOLUME /data
EXPOSE 38471

# Run as the unprivileged node user (uid 1000). A host bind mount at /data
# must still be writable by that uid; see docs/OPERATIONS.md.
USER node

# Start node directly instead of through npm: SIGTERM from `docker stop` then reaches
# the server, which exits cleanly and releases its scheduler lease.
CMD ["node", "scripts/serve.mjs", "start"]
