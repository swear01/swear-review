#!/usr/bin/env bash
set -Eeuo pipefail

# Oracle's service unit, data directory, and service user are intentionally fixed
# to keep the Git checkout and systemd unit from drifting apart.
APP_DIR=/opt/swear-review/app
DATA_DIR=/opt/swear-review/data
SERVICE=swear-review.service
SERVICE_USER=ubuntu
REF=${1:-main}

if [[ "$REF" == -* || ! "$REF" =~ ^[A-Za-z0-9._/-]+$ ]]; then
  echo "invalid ref: $REF" >&2
  exit 2
fi

for command in git npm curl awk sudo flock stat; do
  command -v "$command" >/dev/null || {
    echo "required command not found: $command" >&2
    exit 1
  }
done

[[ -d "$APP_DIR" ]] || { echo "missing app directory: $APP_DIR" >&2; exit 1; }
[[ -d "$DATA_DIR" ]] || { echo "missing data directory: $DATA_DIR" >&2; exit 1; }
exec 9>"$DATA_DIR/.deploy.lock"
flock -n 9 || { echo "another deployment is already running" >&2; exit 1; }

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
  if [[ ! -f "$file" || -L "$file" ]]; then
    echo "runtime secret must be a regular file: $file" >&2
    exit 1
  fi
  if [[ "$(stat -c %U "$file")" != "$SERVICE_USER" ]]; then
    echo "runtime secret must be owned by $SERVICE_USER: $file" >&2
    exit 1
  fi
done
sudo chmod 600 "$DATA_DIR/.env" "$DATA_DIR/github-app.pem"

port_line=$(awk '/^[[:space:]]*PORT[[:space:]]*=/ { print; exit }' "$DATA_DIR/.env")
if [[ -n "$port_line" ]]; then
  SERVICE_PORT=${port_line#*=}
  SERVICE_PORT=${SERVICE_PORT%%#*}
  SERVICE_PORT=${SERVICE_PORT//[[:space:]]/}
else
  SERVICE_PORT=3000
fi
if ! [[ "$SERVICE_PORT" =~ ^[1-9][0-9]*$ ]] || (( SERVICE_PORT > 65535 )); then
  echo "invalid service port: $SERVICE_PORT" >&2
  exit 2
fi

PREV=$(git rev-parse HEAD)
CHECKED_OUT=0
ROLLING_BACK=0

wait_ready() {
  for _ in {1..30}; do
    if curl -fsS --max-time 2 "http://127.0.0.1:$SERVICE_PORT/healthz" >/dev/null 2>&1 \
      && curl -fsS --max-time 2 "http://127.0.0.1:$SERVICE_PORT/readyz" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

install_unit() {
  [[ -f deploy/swear-review.service ]] || {
    echo "deployment ref does not contain deploy/swear-review.service" >&2
    return 1
  }
  sudo install -m 0644 deploy/swear-review.service \
    "/etc/systemd/system/$SERVICE"
  sudo systemctl daemon-reload
}

rollback() {
  git checkout --detach -f "$PREV" || return 1
  rm -rf dist
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
      printf 'rollback failed; recover with: %q %q\n' "$0" "$PREV" >&2
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
rm -rf dist
npm run build
install_unit
sudo systemctl restart "$SERVICE"
sudo systemctl is-active --quiet "$SERVICE"
if ! wait_ready; then
  echo "service did not become ready" >&2
  exit 1
fi
printf 'deployed %s (%s)\n' "$REF" "$(git rev-parse --short HEAD)"
