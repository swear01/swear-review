#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR=${APP_DIR:-/opt/swear-review/app}
SERVICE=${SERVICE:-swear-review.service}
REF=${1:-main}

cd "$APP_DIR"
git remote get-url origin >/dev/null
git diff --quiet
git diff --cached --quiet
[[ -z "$(git ls-files --others --exclude-standard)" ]]

git fetch --prune origin "$REF"
git checkout -B "$REF" "origin/$REF"
npm ci --no-audit --no-fund
npm test
npm run typecheck
npm run build

if [[ -f deploy/swear-review.service ]]; then
  sudo install -m 0644 deploy/swear-review.service \
    "/etc/systemd/system/$SERVICE"
fi
sudo systemctl daemon-reload
sudo systemctl restart "$SERVICE"
sudo systemctl is-active --quiet "$SERVICE"
curl -fsS http://127.0.0.1:3000/healthz >/dev/null
curl -fsS http://127.0.0.1:3000/readyz >/dev/null
printf 'deployed %s (%s)\n' "$REF" "$(git rev-parse --short HEAD)"
