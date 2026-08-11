# syntax=docker/dockerfile:1
# Swear Review — GitHub-native AI code review bot
#   Node.js 24 + Git >= 2.41 (Debian Trixie) + Alibaba Open Code Review v1.9.0

FROM node:24-trixie-slim AS base

# OCR requires Git >= 2.41. Trixie ships Git 2.47.x; assert at build time so an
# accidental base-image downgrade fails the build.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && git --version \
  && GITVER=$(git --version | grep -oE '[0-9]+\.[0-9]+' | head -1) \
  && MAJOR=${GITVER%%.*} \
  && MINOR=${GITVER##*.} \
  && if [ "$MAJOR" -gt 2 ] || { [ "$MAJOR" -eq 2 ] && [ "$MINOR" -ge 41 ]; }; then \
       echo "Git version OK: $(git --version)"; \
     else \
       echo "ERROR: OCR requires Git >= 2.41; found $(git --version)"; exit 1; \
     fi

# OCR is a native binary — install the pinned release globally and assert it.
RUN npm install -g @alibaba-group/open-code-review@1.9.0 --no-audit --no-fund \
  && ocr version 2>&1 | grep -q '1.9.0' \
  && echo "OCR version OK: $(ocr version 2>&1 | head -1)"

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
