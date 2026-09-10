#!/usr/bin/env python3
"""Build the terrain tile sheet from PNG artwork.

    art/png/build_terrain_sheet.py <output directory>

Drop one 48x48 PNG per terrain variant into art/png/terrain/, named for the
terrain type - `plains.png`, `forest.png` - or, for capturable terrain,
one file per owner slot: `city_0.png` (neutral) through `city_4.png`
(the fourth colour seat). This composes them into a single-row sheet plus
a manifest, in exactly the tile order shared/data/terrain.json declares -
the same order and the same tile_key() format
(client/scripts/board/terrain_tileset.gd) so the manifest can be loaded in
place of the procedural fallback with no change to anything that reads it.

Unlike units, terrain tiles get no mask and no tint: each owner variant is
painted outright (the reference set had all five colours, so there was no
need to derive the rest from a diff), and there is no overhang margin -
these sit edge to edge on the map, so a tile must fill its full 48x48 with
no transparent border, or the seam between tiles would show through.
"""

import json
import os
import sys

from PIL import Image

TILE = 48

# Kept in step with TerrainTileSet.AUTOTILE_TERRAIN and MASK_LETTERS in
# client/scripts/board/terrain_tileset.gd. A terrain listed here may supply
# one tile per neighbourhood - `road_NS.png`, `shallow_water_NE.png` - in
# addition to its plain tile. Variants are optional: the client asks for the
# specific key first and falls back to the plain one, so a partial set is a
# partial improvement rather than a hole in the map.
AUTOTILE_TERRAIN = ["road", "shallow_water"]
MASK_LETTERS = ["N", "E", "S", "W"]


def mask_suffixes():
    """All 16 neighbourhoods, in mask order, as the client names them."""
    out = []
    for mask in range(16):
        letters = "".join(MASK_LETTERS[i] for i in range(4) if mask & (1 << i))
        out.append(letters or "0")
    return out


def owner_slots():
    """Neutral, then whatever seats client/scripts/board/board_theme.gd
    colours. Hardcoded here rather than read from Godot source, since this
    runs outside Godot - kept in step by the coverage check in
    tools/render-sprites.sh's sibling, terrain_check.gd, which fails loudly
    if BoardTheme.SLOT_COLORS ever adds a seat this script does not know
    about."""
    return [0, 1, 2, 3, 4]


def tile_key(terrain_id, capturable, owner_slot):
    if not capturable:
        return "%s:0" % terrain_id
    return "%s:%d" % (terrain_id, owner_slot)


def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: build_terrain_sheet.py <output directory>")
    out_dir = sys.argv[1]
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.dirname(os.path.dirname(here))
    source = os.path.join(here, "terrain")

    with open(os.path.join(root, "shared", "data", "terrain.json")) as handle:
        terrain = json.load(handle)["terrain"]

    keys = []
    missing = []
    variants = []
    for terrain_id, stats in terrain.items():
        capturable = bool(stats.get("capturable", False))
        if capturable:
            for slot in owner_slots():
                keys.append((tile_key(terrain_id, True, slot),
                             os.path.join(source, "%s_%d.png" % (terrain_id, slot))))
        else:
            keys.append((tile_key(terrain_id, False, 0),
                         os.path.join(source, "%s.png" % terrain_id)))
        if terrain_id in AUTOTILE_TERRAIN:
            for suffix in mask_suffixes():
                path = os.path.join(source, "%s_%s.png" % (terrain_id, suffix))
                if os.path.exists(path):
                    variants.append(("%s@%s" % (tile_key(terrain_id, False, 0), suffix),
                                     path))
    for key, path in keys:
        if not os.path.exists(path):
            missing.append(path)
    if missing:
        raise SystemExit("missing terrain art:\n  " + "\n  ".join(missing))

    # Variants last, so adding one never renumbers an existing tile.
    keys.extend(variants)

    os.makedirs(out_dir, exist_ok=True)
    sheet = Image.new("RGBA", (TILE * len(keys), TILE), (0, 0, 0, 0))
    opaque_failures = []
    size_failures = []

    for index, (key, path) in enumerate(keys):
        tile = Image.open(path).convert("RGBA")
        if tile.size != (TILE, TILE):
            size_failures.append("%s is %dx%d, not %dx%d" % (path, tile.width, tile.height, TILE, TILE))
            continue
        alpha = tile.split()[3]
        if alpha.getextrema()[0] < 255:
            opaque_failures.append(path)
        sheet.paste(tile, (index * TILE, 0))

    if size_failures:
        raise SystemExit("wrong tile size:\n  " + "\n  ".join(size_failures))
    if opaque_failures:
        raise SystemExit(
            "terrain must be fully opaque - a transparent pixel shows the gap "
            "between tiles as a hole in the map:\n  " + "\n  ".join(opaque_failures))

    sheet.save(os.path.join(out_dir, "terrain.png"))
    manifest = {
        "_comment": "Generated by art/png/build_terrain_sheet.py from the artwork "
                    "in art/png/terrain. Do not edit by hand.",
        "tile": TILE, "sheet": "terrain.png",
        "width": TILE * len(keys), "height": TILE,
        "coords": {key: index for index, (key, _path) in enumerate(keys)},
    }
    with open(os.path.join(out_dir, "terrain.json"), "w") as handle:
        json.dump(manifest, handle, indent=2, sort_keys=True)
        handle.write("\n")
    print("TERRAIN_SHEET_OK %d tiles (%d neighbour variants) -> %s"
          % (len(keys), len(variants), out_dir))


main()
