#!/usr/bin/env bash
#
# The canonical game data lives in /shared/data. The server reads it from
# there directly; Godot can only export files that live inside the project
# folder, so the client gets a copy at client/data.
#
#   tools/sync-shared-data.sh           copy shared/data -> client/data
#   tools/sync-shared-data.sh --check   fail if the copy has drifted (CI)
#
# Never edit client/data by hand.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
src="$repo_root/shared/data"
dst="$repo_root/client/data"

if [[ "${1:-}" == "--check" ]]; then
  if diff -r -q "$src" "$dst" >/dev/null 2>&1; then
    echo "client/data is in sync with shared/data"
    exit 0
  fi
  echo "ERROR: client/data has drifted from shared/data:" >&2
  diff -r "$src" "$dst" >&2 || true
  echo "Run tools/sync-shared-data.sh to fix." >&2
  exit 1
fi

rm -rf "$dst"
mkdir -p "$dst"
cp -R "$src/." "$dst/"
echo "synced shared/data -> client/data"
