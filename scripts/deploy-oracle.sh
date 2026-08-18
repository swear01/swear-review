#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR=${APP_DIR:-/opt/swear-review/app}
DATA_DIR=${DATA_DIR:-/opt/swear-review/data}
SERVICE=${SERVICE:-swear-review.service}
REF=${1:-main}

if [[ ! "$REF" =~ ^[A-Za-z0-9._/-]+$ ]]; then
  echo "invalid ref: $REF" >&2
  exit 2
fi
cd "$APP_DIR"
git remote get-url origin >/dev/null
git diff --quiet
git diff --cached --quiet
[[ -z "$(git ls-files --others --exclude-standard)" ]]

for file in "$DATA_DIR/.env" "$DATA_DIR/github-app.pem"; do
  if [[ ! -f "$file" ]]; then
    echo "missing runtime secret file: $file" >&2
    exit 1
  fi
done
sudo chmod 600 "$DATA_DIR/.env" "$DATA_DIR/github-app.pem"

PREV=$(git rev-parse HEAD)
on_exit() {
  local rc=$?
  if (( rc != 0 )); then
    printf 'deploy failed; rollback with: APP_DIR=%q DATA_DIR=%q %q %q\n' \
      "$APP_DIR" "$DATA_DIR" "$0" "$PREV" >&2
  fi
  exit "$rc"
}
trap on_exit EXIT

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
