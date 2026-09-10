#!/usr/bin/env bash
#
# Renders the unit sprite sheet from the models in art/blender/ and writes it
# to client/assets/units/. The sheet is committed, so this only needs running
# when a model or the render settings change.
#
#   tools/render-sprites.sh           render into client/assets/units
#   tools/render-sprites.sh --check   fail if the committed sheet is stale (CI)
#   tools/render-sprites.sh --preview render a magnified look at the models
#
# --check re-renders into a temporary directory and compares the result with
# what is committed: the manifest byte for byte, the images pixel by pixel
# through tools/compare_sheets.py.
#
# Pixels rather than bytes because Cycles is not quite bit-reproducible here.
# The seed is fixed, adaptive sampling is off, the thread count is pinned and
# Blender's timestamps are stripped after writing - and most runs still come
# out byte-identical - but roughly one in five puts a single pixel up to
# 2/255 away, which is floating-point variance in the CPU kernel and not
# something this script can pin down. compare_sheets.py allows exactly that
# much and no more; a change to a model moves hundreds of pixels by far
# more, so nothing real hides under the tolerance.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script="$repo_root/art/blender/render_sprites.py"
dst="$repo_root/client/assets/units"

# As with the other tools here: an unrecognised argument must not fall
# through to the render, or a mistyped --check would overwrite the sheet it
# was asked to verify.
if [[ $# -gt 1 ]] || { [[ $# -eq 1 ]] && [[ "$1" != "--check" ]] && [[ "$1" != "--preview" ]]; }; then
  echo "usage: $(basename "$0") [--check | --preview]" >&2
  exit 2
fi

if ! command -v blender >/dev/null 2>&1; then
  echo "ERROR: blender is not installed." >&2
  echo "The sheet is committed, so this is only needed to re-render it." >&2
  exit 1
fi

render() {
  local out="$1"
  shift
  # Blender writes its banner and render statistics to stdout and exits 0
  # on a Python error, so the exit status alone proves nothing: the script
  # prints SPRITES_OK/PREVIEW_OK as the last thing it does, and that marker
  # is what is checked below.
  local log
  log="$(blender -b -noaudio -P "$script" -- --out "$out" "$@" 2>&1)" || {
    echo "$log" >&2
    return 1
  }
  if ! grep -qE '^(SPRITES_OK|PREVIEW_OK)' <<<"$log"; then
    echo "$log" >&2
    echo "ERROR: the renderer did not report success." >&2
    return 1
  fi
  grep -E '^(SPRITES_OK|PREVIEW_OK|framing:)' <<<"$log"
}

if [[ "${1:-}" == "--preview" ]]; then
  preview_dir="$repo_root/.preview"
  mkdir -p "$preview_dir"
  render "$preview_dir" --scale 8
  exit 0
fi

if [[ "${1:-}" == "--check" ]]; then
  tmp="$(mktemp -d)"
  # Clean up on the way out however this exits, so a failed comparison does
  # not leave a copy of the sheet in /tmp.
  trap 'rm -rf "$tmp"' EXIT
  render "$tmp" >/dev/null
  stale=0
  # The manifest is generated text: it has no noise floor and is compared
  # exactly. It is also what would catch a unit type added to the shared
  # table without a re-render.
  if ! diff -u "$dst/units.json" "$tmp/units.json" >&2; then
    stale=1
  fi
  for sheet in units.png units_mask.png; do
    if [[ ! -f "$dst/$sheet" ]]; then
      echo "ERROR: $dst/$sheet is missing." >&2
      stale=1
    elif ! "$repo_root/tools/compare_sheets.py" "$dst/$sheet" "$tmp/$sheet"; then
      stale=1
    fi
  done
  if [[ "$stale" -eq 0 ]]; then
    echo "client/assets/units is in sync with art/blender"
    exit 0
  fi
  echo "ERROR: the committed sprite sheet does not match art/blender." >&2
  echo "Run tools/render-sprites.sh to re-render it." >&2
  exit 1
fi

mkdir -p "$dst"
render "$dst"
echo "rendered art/blender -> client/assets/units"
