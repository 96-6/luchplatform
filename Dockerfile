FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM postgres:17-bookworm AS updater
COPY --from=build /usr/local/ /usr/local/
RUN apt-get update && apt-get install -y --no-install-recommends git python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/* && groupadd -g 1000 node && useradd -u 1000 -g node -m node
WORKDIR /app
COPY --from=build --chown=node:node /app /app
RUN mkdir -p /updates /releases /app/data/meeting-files && chown -R node:node /updates /releases /app/data
ENV NODE_ENV=production
USER node
ENTRYPOINT ["node", "scripts/update-runtime/container.mjs", "worker"]

FROM node:24-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends fonts-dejavu-core && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/build-info.json ./build-info.json
COPY --from=build /app/scripts/update-runtime ./scripts/update-runtime
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/migrations ./apps/api/migrations
COPY --from=build /app/content ./content
COPY --from=build /app/scripts/http-smoke.mjs ./scripts/http-smoke.mjs
COPY --from=build /app/scripts/password-smoke.mjs ./scripts/password-smoke.mjs
COPY --from=build /app/scripts/engine-smoke.mjs ./scripts/engine-smoke.mjs
COPY --from=build /app/scripts/diagnostic-smoke.mjs ./scripts/diagnostic-smoke.mjs
COPY --from=build /app/scripts/plan-smoke.mjs ./scripts/plan-smoke.mjs
COPY --from=build /app/scripts/adaptation-smoke.mjs ./scripts/adaptation-smoke.mjs
COPY --from=build /app/scripts/assistant-smoke.mjs ./scripts/assistant-smoke.mjs
COPY --from=build /app/scripts/speech-smoke.mjs ./scripts/speech-smoke.mjs
COPY --from=build /app/scripts/teacher-smoke.mjs ./scripts/teacher-smoke.mjs
COPY --from=build /app/scripts/meeting-smoke.mjs ./scripts/meeting-smoke.mjs
COPY --from=build /app/scripts/meeting-files-smoke.mjs ./scripts/meeting-files-smoke.mjs
COPY --from=build /app/scripts/report-smoke.mjs ./scripts/report-smoke.mjs
COPY --from=build /app/scripts/operations-smoke.mjs ./scripts/operations-smoke.mjs
COPY --from=build /app/apps/web/package.json ./apps/web/package.json
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/packages/contracts ./packages/contracts
RUN mkdir -p /app/data/meeting-files /updates /releases && chown -R node:node /app/data /updates /releases
USER node
EXPOSE 3000
CMD ["node", "scripts/update-runtime/container.mjs"]
