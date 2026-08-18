#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR=${APP_DIR:-/opt/swear-review/app}
DATA_DIR=${DATA_DIR:-/opt/swear-review/data}
SERVICE=${SERVICE:-swear-review.service}
REF=${1:-main}

if [[ "$REF" == -* || ! "$REF" =~ ^[A-Za-z0-9._/-]+$ ]]; then
  echo "invalid ref: $REF" >&2
  exit 2
fi
if [[ ! "$SERVICE" =~ ^[A-Za-z0-9._-]+\.service$ ]]; then
  echo "invalid service name: $SERVICE" >&2
  exit 2
fi

cd "$APP_DIR"
if ! git remote get-url origin >/dev/null; then
  echo "origin remote is required" >&2
  exit 1
fi
if ! git diff --quiet; then
  echo "working tree has unstaged changes" >&2
  exit 1
fi
if ! git diff --cached --quiet; then
  echo "index has staged changes" >&2
  exit 1
fi
if [[ -n "$(git ls-files --others --exclude-standard)" ]]; then
  echo "working tree has unexpected untracked files" >&2
  exit 1
fi

for file in "$DATA_DIR/.env" "$DATA_DIR/github-app.pem"; do
  if [[ ! -f "$file" ]]; then
    echo "missing runtime secret file: $file" >&2
    exit 1
  fi
done
sudo chmod 600 "$DATA_DIR/.env" "$DATA_DIR/github-app.pem"

SERVICE_PORT=${PORT:-}
if [[ -z "$SERVICE_PORT" ]]; then
  SERVICE_PORT=$(awk -F= '$1 == "PORT" { print $2; exit }' "$DATA_DIR/.env")
fi
SERVICE_PORT=${SERVICE_PORT:-3000}
if [[ ! "$SERVICE_PORT" =~ ^[0-9]+$ ]]; then
  echo "invalid service port: $SERVICE_PORT" >&2
  exit 2
fi

PREV=$(git rev-parse HEAD)
CHECKED_OUT=0
ROLLING_BACK=0

wait_ready() {
  for _ in $(seq 1 30); do
    if curl -fsS --max-time 2 "http://127.0.0.1:$SERVICE_PORT/healthz" >/dev/null 2>&1 \
      && curl -fsS --max-time 2 "http://127.0.0.1:$SERVICE_PORT/readyz" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

install_unit() {
  if [[ -f deploy/swear-review.service ]]; then
    sudo install -m 0644 deploy/swear-review.service \
      "/etc/systemd/system/$SERVICE"
  fi
  sudo systemctl daemon-reload
}

rollback() {
  git checkout --detach "$PREV" || return 1
  npm ci --no-audit --no-fund || return 1
  npm run build || return 1
  install_unit || return 1
  sudo systemctl restart "$SERVICE" || return 1
  wait_ready
}

on_exit() {
  local rc=$?
  if (( rc != 0 && CHECKED_OUT == 1 && ROLLING_BACK == 0 )); then
    ROLLING_BACK=1
    echo "deploy failed; restoring $PREV" >&2
    if rollback; then
      echo "rollback restored $PREV" >&2
    else
      printf 'rollback failed; recover with: APP_DIR=%q DATA_DIR=%q %q %q\n' \
        "$APP_DIR" "$DATA_DIR" "$0" "$PREV" >&2
    fi
  fi
  exit "$rc"
}
trap on_exit EXIT

git fetch --prune origin "$REF"
git checkout --detach FETCH_HEAD
CHECKED_OUT=1
npm ci --no-audit --no-fund
npm test
npm run typecheck
npm run build
install_unit
sudo systemctl restart "$SERVICE"
sudo systemctl is-active --quiet "$SERVICE"
if ! wait_ready; then
  echo "service did not become ready" >&2
  exit 1
fi
printf 'deployed %s (%s)\n' "$REF" "$(git rev-parse --short HEAD)"
