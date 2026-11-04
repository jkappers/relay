FROM node:24-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c AS base
ENV CI=true
RUN corepack enable
WORKDIR /app

FROM base AS prod-deps
COPY . .
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --prod

FROM base AS console
COPY . .
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
RUN pnpm build:console

FROM node:24-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c AS runtime
LABEL org.opencontainers.image.source="https://github.com/jkappers/relay" \
      org.opencontainers.image.description="Relay: route chat events to tools and agents"
# npm, npx and corepack are not used at runtime; dropping them removes their bundled CVEs.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps --chown=node:node /app /app
COPY --from=console --chown=node:node /app/apps/console/dist /app/apps/console/dist
USER node
EXPOSE 3000 9465 9466
# Default: HTTP server. Override the command for the other processes:
#   worker:  node --import tsx apps/worker/src/main.ts
#   gateway: node --import tsx apps/gateway/src/main.ts
#   migrate: node --import tsx packages/core/src/db/migrate-cli.ts
CMD ["node", "--import", "tsx", "apps/server/src/main.ts"]
