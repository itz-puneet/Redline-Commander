#!/usr/bin/env bash
#
# End-to-end check: builds and starts the server, hosts a match, then runs
# the Godot client against it and asserts the whole path works - lobby,
# socket, protocol, fog, board, input.
#
# Everything else in the test suites runs offline against fixtures. This is
# the one that proves the pieces fit together.
#
#   tools/live-check.sh
#
# Needs node, and a Godot binary on PATH (or $GODOT). Uses xvfb when there is
# no display, because the client needs a real renderer.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work_dir="$(mktemp -d)"
server_pid=""
host_pid=""

cleanup() {
  [[ -n "$host_pid" ]] && kill "$host_pid" 2>/dev/null || true
  [[ -n "$server_pid" ]] && kill "$server_pid" 2>/dev/null || true
  rm -rf "$work_dir"
}
trap cleanup EXIT

godot_bin="${GODOT:-godot}"
if ! command -v "$godot_bin" >/dev/null 2>&1; then
  echo "live-check: no Godot binary (set GODOT=/path/to/godot)" >&2
  exit 1
fi

# A real renderer is required; fall back to xvfb on a headless machine.
runner=("$godot_bin")
if [[ -z "${DISPLAY:-}" ]]; then
  if ! command -v xvfb-run >/dev/null 2>&1; then
    echo "live-check: no DISPLAY and no xvfb-run" >&2
    exit 1
  fi
  runner=(xvfb-run -a "$godot_bin")
fi

echo "== building server =="
cd "$repo_root/server"
npm run build --silent

echo "== starting server =="
REDLINE_MATCH_DIR="$work_dir/matches" node build/src/index.js > "$work_dir/server.log" 2>&1 &
server_pid=$!

for _ in $(seq 1 40); do
  if curl -sf -m 1 http://localhost:2567/health >/dev/null 2>&1; then break; fi
  sleep 0.5
done
if ! curl -sf -m 1 http://localhost:2567/health >/dev/null 2>&1; then
  echo "live-check: server did not come up" >&2
  cat "$work_dir/server.log" >&2
  exit 1
fi

echo "== hosting a match =="
node scripts/host-match.js "$work_dir/code.txt" > "$work_dir/host.log" 2>&1 &
host_pid=$!

for _ in $(seq 1 40); do
  [[ -s "$work_dir/code.txt" ]] && break
  sleep 0.5
done
if [[ ! -s "$work_dir/code.txt" ]]; then
  echo "live-check: host never produced a join code" >&2
  cat "$work_dir/host.log" >&2
  exit 1
fi
code="$(cat "$work_dir/code.txt")"
echo "joining $code"

echo "== running the client =="
cd "$repo_root/client"
REDLINE_JOIN_CODE="$code" "${runner[@]}" --resolution 1280x720 \
  res://tests/live_check.tscn 2>&1 \
  | grep -vE "ALSA|libpulse|snd_|pcm|V-Sync|OpenGL|audio driver|shader|icon\.svg|^[[:space:]]*at: |Condition \"status"
