FROM node:22-alpine AS build
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
COPY packages/cli/package.json packages/cli/
RUN pnpm install --frozen-lockfile
COPY packages ./packages
RUN pnpm --filter @ateam/core --filter @ateam/server run build

FROM node:22-alpine
# Set by bin/deploy (`--build-arg GIT_SHA=$(git rev-parse HEAD)`). A build without it still succeeds and reports "unknown".
ARG GIT_SHA=unknown
WORKDIR /app
ENV NODE_ENV=production NODE_OPTIONS=--no-warnings PORT=8080 ATEAM_DB=/data/ateam.db ATEAM_SHA=${GIT_SHA}
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/core ./packages/core
COPY --from=build /app/packages/server ./packages/server
EXPOSE 8080
CMD ["node", "packages/server/dist/main.js"]
