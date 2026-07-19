# syntax=docker/dockerfile:1
ARG BUN_VERSION=1.3.14

FROM oven/bun:${BUN_VERSION}-alpine AS runtime
WORKDIR /app

# ffmpeg — required by the export render (RENDER_PROVIDER=ffmpeg): trims +
# concatenates the already-rendered clips into the final mp4.
RUN apk add --no-cache ffmpeg

# Full workspace manifest graph + lockfile, install IN-STAGE (devDeps incl
# drizzle-kit are needed for db:migrate; bun nests some workspace deps so a
# cross-stage copy of only root node_modules would drop them).
COPY package.json bun.lock tsconfig.base.json ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY packages/shared/package.json ./packages/shared/
COPY packages/render-spike/package.json ./packages/render-spike/
# e2e is a root workspace (bun.lock references it); its manifest must be present
# for `--frozen-lockfile` even though the e2e sources aren't built into this image.
COPY e2e/package.json ./e2e/
RUN bun install --frozen-lockfile

# Source: api (incl drizzle migrations + config) + shared.
COPY apps/api ./apps/api
COPY packages/shared ./packages/shared

ENV NODE_ENV=production
ENV PORT=3001
EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD bun --eval "fetch(\"http://127.0.0.1:\"+(process.env.PORT||3001)+\"/health\").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

WORKDIR /app/apps/api
CMD ["bun", "run", "src/server.ts"]
