#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR=${APP_DIR:-/opt/swear-review/app}
DATA_DIR=${DATA_DIR:-/opt/swear-review/data}
SERVICE=${SERVICE:-swear-review.service}
REF=${1:-main}

[[ "$REF" =~ ^[A-Za-z0-9._/-]+$ ]]
cd "$APP_DIR"
git remote get-url origin >/dev/null
git diff --quiet
git diff --cached --quiet
[[ -z "$(git ls-files --others --exclude-standard)" ]]

git fetch --prune origin "$REF"
git checkout --detach FETCH_HEAD
npm ci --no-audit --no-fund
npm test
npm run typecheck
npm run build

if [[ -f deploy/swear-review.service ]]; then
  sudo install -m 0644 deploy/swear-review.service \
    "/etc/systemd/system/$SERVICE"
fi
sudo chmod 600 "$DATA_DIR/.env" "$DATA_DIR/github-app.pem"
sudo systemctl daemon-reload
sudo systemctl restart "$SERVICE"
sudo systemctl is-active --quiet "$SERVICE"
for i in $(seq 1 30); do
  if curl -fsS --max-time 2 http://127.0.0.1:3000/healthz >/dev/null 2>&1 \
    && curl -fsS --max-time 2 http://127.0.0.1:3000/readyz >/dev/null 2>&1; then
    break
  fi
  if (( i == 30 )); then
    echo "service did not become ready" >&2
    exit 1
  fi
  sleep 1
done
printf 'deployed %s (%s)\n' "$REF" "$(git rev-parse --short HEAD)"
