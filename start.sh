#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
command -v node >/dev/null || { printf 'Please install Node.js 24 first.\n' >&2; exit 1; }
node scripts/check-runtime.mjs
if [[ ! -d node_modules ]]; then npm ci --omit=dev --no-fund; fi
umask 077
node --env-file-if-exists=.env src/cli.js init
exec node --expose-gc --env-file-if-exists=.env src/server.js
