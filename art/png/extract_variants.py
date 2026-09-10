#!/usr/bin/env python3
"""Crop road and shoreline neighbour-variants out of a generated reference
sheet.

    art/png/extract_variants.py <sheet.png>

Writes the results straight into art/png/terrain/, in the naming
build_terrain_sheet.py already knows how to pick up (`road_NS.png`,
`shallow_water_NE.png`, ...). Re-run it if the source sheet is regenerated;
it always re-derives from the source rather than touching a previous run's
output.

The source sheet this was built against is a generated reference image
laying out labelled road and shoreline tiles on a grid, each drawn as an
opaque rounded card against a transparent background (see art/png/README.md
for the full picture). Two things this script does NOT trust from that
sheet, both discovered the hard way by measuring the art instead of reading
the filenames printed under each tile:

1. Card position. The grid is close to even but not exact - this locates
   every card's true bounding box from its own alpha channel (the
   background is transparent, each card is not) rather than assuming a
   fixed pitch, which drifted by 10+px across a row of six on the one
   generated sheet this was written for.

2. The caption. Several of this sheet's captions did not match what was
   actually drawn (art/png/README.md has the full list - a duplicate
   straight road under two dead-end names, corners swapped left for right).
   road_suffix() and shore_suffix() below classify every tile by measuring
   its content - which sides the road touches; which quadrants are land vs
   water - rather than trusting the filename. Do the same for any future
   sheet before wiring its output in: a caption is a hint, not ground
   truth.
"""

import os
import sys

from PIL import Image

TILE = 48
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "terrain")

# Inward trim from each card's true (alpha-derived) bounding box, clearing
# both the card's border line and its rounded-corner radius before the
# crop is resized down to the shipped 48x48.
INSET = 12

# Sides in canonical N, E, S, W order - the order every suffix in this
# codebase is written in (TerrainTileSet.MASK_LETTERS).
SIDES = "NESW"


def find_cards(sheet):
    """Every opaque rounded-rect region on a transparent background, as
    (x0, y0, x1, y1) boxes, read off the alpha channel directly rather than
    assumed from a fixed grid - this sheet's own grid drifts by 10+ px
    across a row, enough to crop the wrong tile's edge into the wrong
    one's card."""
    import numpy as np
    from scipy import ndimage

    alpha = np.array(sheet)[:, :, 3]
    labeled, _ = ndimage.label(alpha > 128)
    boxes = []
    for sl in ndimage.find_objects(labeled):
        if sl is None:
            continue
        ys, xs = sl
        if (ys.stop - ys.start) > 80 and (xs.stop - xs.start) > 80:
            boxes.append((xs.start, ys.start, xs.stop, ys.stop))
    return boxes


def crop_tile(sheet, box):
    x0, y0, x1, y1 = box
    tile = sheet.crop((x0 + INSET, y0 + INSET, x1 - INSET, y1 - INSET))
    tile = tile.resize((TILE, TILE), Image.LANCZOS)
    # Force fully opaque: terrain sits edge to edge with no card border, and
    # build_terrain_sheet.py refuses anything the resize left translucent.
    r, g, b, a = tile.split()
    return Image.merge("RGBA", (r, g, b, a.point(lambda _: 255)))


def road_suffix(sheet, box):
    """Which sides asphalt (grey - R, G, B close together) touches, sampled
    as a strip along each edge rather than a single point, so a lane
    marking or a curve near one sample point can't flip the answer."""
    x0, y0, x1, y1 = box
    w, h = x1 - x0, y1 - y0
    inset, probe = int(w * 0.05), int(w * 0.18)
    px = sheet.load()

    def is_road(p):
        r, g, b = p[0], p[1], p[2]
        return abs(r - g) < 25 and abs(g - b) < 25 and abs(r - b) < 25 and 40 < r < 220

    def frac(x_range, y_range):
        pts = [(x, y) for x in x_range for y in y_range]
        return sum(1 for p in pts if is_road(px[p])) / len(pts)

    cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
    sides = {
        "N": frac(range(cx - probe, cx + probe), range(y0 + inset, y0 + inset + 8)),
        "S": frac(range(cx - probe, cx + probe), range(y1 - inset - 8, y1 - inset)),
        "W": frac(range(x0 + inset, x0 + inset + 8), range(cy - probe, cy + probe)),
        "E": frac(range(x1 - inset - 8, x1 - inset), range(cy - probe, cy + probe)),
    }
    return "".join(s for s in SIDES if sides[s] > 0.5) or "0"


def shore_quadrants(sheet, box):
    """Which corner quadrants are land (green channel over blue - true for
    grass and sand, false for open water), tightly cornered so a diagonal
    coastline through the middle of a quadrant does not average out."""
    x0, y0, x1, y1 = box
    w, h = x1 - x0, y1 - y0
    inset, cs = int(w * 0.16), 0.24
    csz_x, csz_y = int(w * cs), int(h * cs)
    px = sheet.load()

    def land_frac(x_range, y_range):
        pts = [(x, y) for x in x_range for y in y_range]
        return sum(1 for p in pts if px[p][1] > px[p][2]) / len(pts)

    return {
        "NW": land_frac(range(x0 + inset, x0 + inset + csz_x), range(y0 + inset, y0 + inset + csz_y)) > 0.5,
        "NE": land_frac(range(x1 - inset - csz_x, x1 - inset), range(y0 + inset, y0 + inset + csz_y)) > 0.5,
        "SW": land_frac(range(x0 + inset, x0 + inset + csz_x), range(y1 - inset - csz_y, y1 - inset)) > 0.5,
        "SE": land_frac(range(x1 - inset - csz_x, x1 - inset), range(y1 - inset - csz_y, y1 - inset)) > 0.5,
    }


# One land quadrant is a corner (both its adjacent edges are land); two
# adjacent quadrants sharing a row or column is a straight edge; anything
# else isn't a shape this sheet's shorelines use.
SHORE_PATTERNS = {
    frozenset(["NW", "NE"]): "N", frozenset(["SW", "SE"]): "S",
    frozenset(["NW", "SW"]): "W", frozenset(["NE", "SE"]): "E",
    frozenset(["NW"]): "NW", frozenset(["NE"]): "NE",
    frozenset(["SW"]): "SW", frozenset(["SE"]): "ES",
}


def shore_suffix(sheet, box):
    q = shore_quadrants(sheet, box)
    land = frozenset(k for k, v in q.items() if v)
    return SHORE_PATTERNS.get(land, "UNHANDLED:" + ",".join(sorted(land)) or "0")


def main():
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    sheet = Image.open(sys.argv[1]).convert("RGBA")

    boxes = find_cards(sheet)
    # Road cards (bigger of the two sizes on this sheet) sort by row then
    # column; same for shoreline cards, which are the wider ones.
    boxes.sort(key=lambda b: (round(b[1] / 40), b[0]))
    widths = sorted(b[2] - b[0] for b in boxes)
    split = widths[len(widths) // 2] + 10  # midpoint between the two sizes
    road_boxes = [b for b in boxes if (b[2] - b[0]) < split]
    shore_boxes = [b for b in boxes if (b[2] - b[0]) >= split]

    # No shipped map uses a plain east-west straight or a plain west-facing
    # shore - both genuinely present on this sheet, neither needed - so
    # they are left out rather than shipped untested alongside the rest.
    NOT_NEEDED = {"EW", "W"}

    written = []
    road_tiles = {}
    for box in road_boxes:
        suffix = road_suffix(sheet, box)
        if suffix == "0" or len(suffix) == 1:
            # Every single-letter reading on this sheet turned out to be a
            # mislabelled straight-through road (see the module docstring),
            # not a genuine dead end - skip rather than ship the wrong shape
            # under the right name.
            continue
        if suffix in NOT_NEEDED or suffix in road_tiles:
            continue  # not needed, or a duplicate reading already kept
        road_tiles[suffix] = crop_tile(sheet, box)
    for suffix, tile in road_tiles.items():
        name = f"road_{suffix}.png"
        tile.save(os.path.join(OUT_DIR, name))
        written.append(name)

    shore_tiles = {}
    for box in shore_boxes:
        suffix = shore_suffix(sheet, box)
        if suffix.startswith("UNHANDLED") or suffix in NOT_NEEDED or suffix in shore_tiles:
            continue  # unhandled shape, not needed, or a duplicate reading
        shore_tiles[suffix] = crop_tile(sheet, box)

    for suffix, tile in shore_tiles.items():
        name = f"shallow_water_{suffix}.png"
        tile.save(os.path.join(OUT_DIR, name))
        written.append(name)

    # The corner orientations this sheet did not genuinely draw, derived by
    # rotating one it did - a mechanical transform of real art, not new
    # content. See the module docstring for how this was verified.
    if "NW" in shore_tiles:
        derived = {
            "S": None, "ES": shore_tiles["NW"].transpose(Image.ROTATE_180),
            "SW": shore_tiles["NW"].transpose(Image.ROTATE_90),
        }
        if "N" in shore_tiles:
            derived["S"] = shore_tiles["N"].transpose(Image.ROTATE_180)
        for suffix, tile in derived.items():
            name = f"shallow_water_{suffix}.png"
            if tile is not None and not os.path.exists(os.path.join(OUT_DIR, name)):
                tile.save(os.path.join(OUT_DIR, name))
                written.append(name)

    print("wrote %d variant files to %s:" % (len(written), OUT_DIR))
    for name in sorted(written):
        print(" ", name)


main()
