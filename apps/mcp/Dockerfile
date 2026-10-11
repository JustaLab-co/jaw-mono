# Built from the repository root: docker build -f apps/mcp/Dockerfile .
FROM oven/bun:1.3.2 AS build
WORKDIR /repo
COPY . .
RUN bun install --frozen-lockfile --ignore-scripts
RUN cd packages/core && bun scripts/generate-sdk-info.ts
RUN cd packages/agent && bunx tsc --build tsconfig.lib.json
RUN cd apps/mcp && bunx next build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
COPY --from=build /repo/apps/mcp/.next/standalone ./
COPY --from=build /repo/apps/mcp/.next/static ./apps/mcp/.next/static
COPY --from=build /repo/apps/mcp/drizzle ./apps/mcp/drizzle
USER node
EXPOSE 3000
# Busybox wget exits non-zero on a 503, which /api/health returns when the
# config is invalid or the database is down.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:$PORT/api/health" || exit 1
CMD ["node", "apps/mcp/server.js"]
