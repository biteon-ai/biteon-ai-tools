FROM node:22-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/executors/package.json packages/executors/package.json
COPY packages/integrations/package.json packages/integrations/package.json
RUN pnpm install --frozen-lockfile
COPY . .

FROM base AS api
EXPOSE 4000
CMD ["pnpm", "--filter", "@agent-platform/api", "start"]

FROM base AS worker
EXPOSE 4001
CMD ["pnpm", "--filter", "@agent-platform/worker", "start"]

FROM base AS web
ENV API_INTERNAL_URL=http://api:4000
RUN pnpm --filter @agent-platform/web build
EXPOSE 3000
CMD ["pnpm", "--filter", "@agent-platform/web", "start"]
