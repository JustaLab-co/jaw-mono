# Built from the repository root: docker build -f apps/mcp/Dockerfile .
FROM oven/bun:1.3.2 AS build
WORKDIR /repo
COPY . .
RUN bun install --frozen-lockfile --ignore-scripts
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
CMD ["node", "apps/mcp/server.js"]
