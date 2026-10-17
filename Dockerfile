FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM node:24-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends fonts-dejavu-core && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/migrations ./apps/api/migrations
COPY --from=build /app/content ./content
COPY --from=build /app/scripts/engine-smoke.mjs ./scripts/engine-smoke.mjs
COPY --from=build /app/scripts/diagnostic-smoke.mjs ./scripts/diagnostic-smoke.mjs
COPY --from=build /app/scripts/plan-smoke.mjs ./scripts/plan-smoke.mjs
COPY --from=build /app/scripts/adaptation-smoke.mjs ./scripts/adaptation-smoke.mjs
COPY --from=build /app/scripts/assistant-smoke.mjs ./scripts/assistant-smoke.mjs
COPY --from=build /app/scripts/speech-smoke.mjs ./scripts/speech-smoke.mjs
COPY --from=build /app/scripts/teacher-smoke.mjs ./scripts/teacher-smoke.mjs
COPY --from=build /app/scripts/meeting-smoke.mjs ./scripts/meeting-smoke.mjs
COPY --from=build /app/scripts/report-smoke.mjs ./scripts/report-smoke.mjs
COPY --from=build /app/scripts/operations-smoke.mjs ./scripts/operations-smoke.mjs
COPY --from=build /app/apps/web/package.json ./apps/web/package.json
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/packages/contracts ./packages/contracts
USER node
EXPOSE 3000
CMD ["node", "apps/api/dist/server.js"]
