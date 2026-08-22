# syntax=docker/dockerfile:1

# ---------------------------------------------------------------- builder
FROM node:22-alpine AS builder
WORKDIR /app

# Manifests first, so a dependency install is only re-run when a manifest
# actually changes rather than on every source edit.
COPY package.json package-lock.json ./
COPY packages/core/package.json ./packages/core/
COPY apps/server/package.json ./apps/server/
COPY apps/web/package.json ./apps/web/

RUN npm ci --ignore-scripts

COPY tsconfig.base.json ./
COPY packages/core ./packages/core
COPY apps/server ./apps/server
COPY apps/web ./apps/web

RUN npm run build -w @mnemos/core \
 && npm run build -w @mnemos/server \
 && npm run build -w @mnemos/web

# Drop dev dependencies before they are copied into the runtime image.
RUN npm prune --omit=dev

# ---------------------------------------------------------------- runtime
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    STORE=sqlite \
    DATA_DIR=/data

RUN apk add --no-cache tini \
 && addgroup -S mnemos && adduser -S mnemos -G mnemos \
 && mkdir -p /data && chown -R mnemos:mnemos /data

COPY --from=builder --chown=mnemos:mnemos /app/node_modules ./node_modules
COPY --from=builder --chown=mnemos:mnemos /app/package.json ./package.json
COPY --from=builder --chown=mnemos:mnemos /app/packages/core/dist ./packages/core/dist
COPY --from=builder --chown=mnemos:mnemos /app/packages/core/package.json ./packages/core/package.json
COPY --from=builder --chown=mnemos:mnemos /app/apps/server/dist ./apps/server/dist
COPY --from=builder --chown=mnemos:mnemos /app/apps/server/package.json ./apps/server/package.json

USER mnemos
VOLUME ["/data"]
EXPOSE 8080

# tini reaps zombies and forwards signals, so SIGTERM reaches Node and the
# graceful shutdown path actually runs instead of the container being killed.
ENTRYPOINT ["/sbin/tini", "--"]

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--enable-source-maps", "apps/server/dist/index.js"]
