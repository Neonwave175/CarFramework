#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
python3 -m venv .venv
. .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
: "${AVIF_COOKIE_SECURE:=0}"
export AVIF_COOKIE_SECURE
printf 'Starting AVIF Lab at http://localhost:8000\n'
exec uvicorn server:app --host 0.0.0.0 --port 8000
