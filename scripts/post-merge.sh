#!/bin/bash
set -e

cd "$(dirname "$0")/.."

if [ -f web/package.json ]; then
  cd web
  npm install --no-audit --no-fund
fi
