# syntax=docker/dockerfile:1.7

# ---- build: install all dependencies and compile ----
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

# ---- runtime: production dependencies only, non-root, no build tools ----
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
USER node
EXPOSE 3000
# Node runs as PID 1; NestJS shutdown hooks handle SIGTERM for graceful deploys.
# The same image runs the API (default), the worker ("node dist/worker.js")
# and migrations ("node dist/database/migrate.js").
CMD ["node", "dist/main.js"]
