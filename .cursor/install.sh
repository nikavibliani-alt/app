#!/usr/bin/env bash
# Idempotent dependency bootstrap for the Maxela / SleepyPMS repo.
# Safe to run repeatedly: every step is a no-op when already satisfied.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
echo "==> Bootstrapping dev environment in $ROOT"

# ---------------------------------------------------------------------------
# Node.js — three independent packages + the Firebase CLI.
# ---------------------------------------------------------------------------
# The nvm-managed npm has its global prefix misconfigured in the base image, so
# point it at the (writable) nvm node dir whose bin is already on PATH. This
# lets `npm i -g` work without sudo.
NPM_PREFIX="$(dirname "$(dirname "$(command -v npm)")")"
if mkdir -p "$NPM_PREFIX/lib/node_modules" 2>/dev/null; then
  npm config set prefix "$NPM_PREFIX"
fi

echo "==> Installing pipeline-functions dependencies (npm ci)"
( cd "$ROOT/pipeline-functions" && npm ci )

echo "==> Installing tuya-functions dependencies (npm install)"
( cd "$ROOT/tuya-functions" && npm install --no-audit --no-fund )

echo "==> Installing scripts dependencies (npm install)"
( cd "$ROOT/scripts" && npm install --no-audit --no-fund )

echo "==> Installing Firebase CLI (firebase-tools)"
if ! command -v firebase >/dev/null 2>&1; then
  npm install -g firebase-tools --no-audit --no-fund || \
    echo "WARN: firebase-tools install failed (only needed for emulator/deploy); continuing."
fi

# ---------------------------------------------------------------------------
# Python — pricing + reservation-sync scripts, isolated in .venv.
# ---------------------------------------------------------------------------
# Ensure the venv module is present (missing from the slim base image).
if ! python3 -c "import ensurepip" >/dev/null 2>&1; then
  echo "==> Installing python3-venv"
  PYVER="$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
  sudo apt-get update -qq && sudo apt-get install -y -qq "python${PYVER}-venv" || \
    echo "WARN: could not install python venv package; Python setup may fail."
fi

echo "==> Creating/refreshing Python virtualenv (.venv)"
if [ ! -x "$ROOT/.venv/bin/python" ]; then
  python3 -m venv "$ROOT/.venv"
fi
"$ROOT/.venv/bin/python" -m pip install --upgrade pip -q
"$ROOT/.venv/bin/pip" install -q -r "$ROOT/requirements.txt"

echo "==> Done. Node packages, Firebase CLI, and Python venv are ready."
