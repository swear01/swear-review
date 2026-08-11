# syntax=docker/dockerfile:1
# Swear Review — GitHub-native AI code review bot
#   Node.js 24 + Git >= 2.41 + Alibaba Open Code Review v1.9.0

FROM node:24-bookworm-slim AS base

# OCR requires Git >= 2.41; Debian bookworm ships 2.39, so use backports.
RUN echo 'deb http://deb.debian.org/debian bookworm-backports main' > /etc/apt/sources.list.d/backports.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends -t bookworm-backports git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && git --version

# OCR is a native binary — install the pinned release globally
RUN npm install -g @alibaba-group/open-code-review@1.9.0 --no-audit --no-fund \
  && ocr version

WORKDIR /app

# ---- build stage ----
FROM base AS build
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build \
  && npm prune --omit=dev --no-audit --no-fund

# ---- runtime stage ----
FROM base AS runtime
ENV NODE_ENV=production
ENV CONFIG_PATH=/data/config.yaml
ENV DATABASE_PATH=/data/swear-review.db
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY config.example.yaml ./config.example.yaml

VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" || exit 1

ENTRYPOINT ["node", "dist/index.js"]
