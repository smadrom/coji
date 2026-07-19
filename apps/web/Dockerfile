# syntax=docker/dockerfile:1
ARG BUN_VERSION=1.3.14

FROM oven/bun:${BUN_VERSION}-alpine AS build
WORKDIR /app
# Full workspace manifest graph + lockfile, then install IN-STAGE so vite +
# @vitejs/plugin-react resolve for the web build.
COPY package.json bun.lock tsconfig.base.json ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY packages/shared/package.json ./packages/shared/
COPY packages/render-spike/package.json ./packages/render-spike/
# e2e is a root workspace (bun.lock references it); its manifest must be present
# for `--frozen-lockfile` even though the e2e sources aren't built into this image.
COPY e2e/package.json ./e2e/
RUN bun install --frozen-lockfile

# Source for web + its shared dependency.
COPY apps/web ./apps/web
COPY packages/shared ./packages/shared

# Public build-time config (same-origin /api proxied by nginx -> api).
ARG VITE_API_URL=/api
ENV VITE_API_URL=${VITE_API_URL}
RUN cd apps/web && bunx vite build

FROM nginx:1.27-alpine AS runtime
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=5 \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
CMD ["nginx", "-g", "daemon off;"]
