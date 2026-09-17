#!/usr/bin/env python3
"""Check a generated terrain tile before it goes anywhere near the build.

    art/png/check_tile.py <image.png> [<image.png> ...]
    art/png/check_tile.py --write <out_dir> <image.png> ...

Answers the three questions a generated tile fails on, in the order they
cost you time:

1. Is it the right size and fully opaque? build_terrain_sheet.py refuses
   anything that is not exactly 48x48 with no transparent pixel, because a
   terrain tile sits edge to edge and a hole there is a hole in the map.

2. Does it actually tile? Generators ignore "seamless" about half the time
   and there is no way to see it by looking at one copy. This measures the
   discontinuity across the wrap: the difference between the left and right
   edge columns, and between the top and bottom edge rows, compared against
   the variation *inside* the tile. A tile that wraps cleanly has an edge
   step no worse than its own internal texture; one that does not shows a
   hard line when the map repeats it.

3. Is it in the right palette? Prints the mean colour so it can be compared
   against the table in docs/ASSET_PROMPTS.md - a new plains tile that is
   not roughly the same green as the shipped one will look like a patch.

With --write it also downscales to 48x48 and forces full opacity, which is
the whole preparation step, so a generated 1024x1024 becomes a usable tile
in one command.
"""

import os
import sys

from PIL import Image

TILE = 48

# How much worse the wrap may be than a steep-but-normal step inside the
# tile before it is called a seam. Compared against a high percentile of the
# internal steps rather than their mean: in any patterned texture the steps
# vary a lot, and the wrap lands wherever it lands - a tile whose wrap sits
# on a steep part of its own pattern is not seamed, it is just steep there.
SEAM_TOLERANCE = 1.25
STEEP_PERCENTILE = 0.90


def mean_abs_diff(a, b):
    return sum(abs(int(x) - int(y)) for x, y in zip(a, b)) / max(1, len(a))


def column(px, x, height):
    return [c for y in range(height) for c in px[x, y][:3]]


def row(px, y, width):
    return [c for x in range(width) for c in px[x, y][:3]]


def seam_report(image):
    """(wrap_x, wrap_y, local_x, local_y) mean channel differences.

    The baseline is the average difference between ADJACENT lines, not
    between opposite ones. That distinction is the whole test: a smooth
    gradient has wildly different left and right edges, but its opposite
    columns differ just as much, so comparing wrap against opposite-column
    difference calls the least tileable image imaginable seamless. Against
    neighbouring columns - what the texture does locally - the gradient's
    wrap stands out by two orders of magnitude, which is correct.
    """
    px = image.load()
    w, h = image.size

    wrap_x = mean_abs_diff(column(px, 0, h), column(px, w - 1, h))
    wrap_y = mean_abs_diff(row(px, 0, w), row(px, h - 1, w))

    steps_x = sorted(
        mean_abs_diff(column(px, x, h), column(px, x + 1, h)) for x in range(w - 1))
    steps_y = sorted(
        mean_abs_diff(row(px, y, w), row(px, y + 1, w)) for y in range(h - 1))
    return wrap_x, wrap_y, steep(steps_x), steep(steps_y)


def steep(sorted_steps):
    """A step this texture takes normally, at its steeper end."""
    return sorted_steps[min(len(sorted_steps) - 1, int(len(sorted_steps) * STEEP_PERCENTILE))]


def prepare(image):
    """Downscale to the shipped tile size and force full opacity.

    The downscale is done on a 3x3 tiling of the source, then cropped back
    to the middle. Resampling straight down would clamp at the border
    instead of wrapping, so the outermost pixels get filtered against
    nothing - which puts a seam into art that tiled perfectly before it was
    resized. Costs nine times the pixels for a moment and saves chasing a
    seam that the generator did not put there.
    """
    source = image.convert("RGBA")
    if source.size == (TILE, TILE):
        tile = source
    else:
        w, h = source.size
        spread = Image.new("RGBA", (w * 3, h * 3))
        for box_x in range(3):
            for box_y in range(3):
                spread.paste(source, (box_x * w, box_y * h))
        spread = spread.resize((TILE * 3, TILE * 3), Image.LANCZOS)
        tile = spread.crop((TILE, TILE, TILE * 2, TILE * 2))

    r, g, b, a = tile.split()
    return Image.merge("RGBA", (r, g, b, a.point(lambda _: 255)))


def check(path, out_dir=None):
    original = Image.open(path).convert("RGBA")
    name = os.path.basename(path)
    problems = []

    alpha = original.split()[3]
    if alpha.getextrema()[0] < 255:
        problems.append(
            "has transparent pixels - a terrain tile must be opaque corner to corner")

    if original.size[0] != original.size[1]:
        problems.append("is not square (%dx%d)" % original.size)

    tile = prepare(original)

    # Seam measured on the prepared tile: that is the one the game repeats.
    wrap_x, wrap_y, local_x, local_y = seam_report(tile)
    if wrap_x > max(local_x, 1.0) * SEAM_TOLERANCE:
        problems.append("left and right edges do not meet (%.1f, vs a steep "
                        "in-tile column step of %.1f)" % (wrap_x, local_x))
    if wrap_y > max(local_y, 1.0) * SEAM_TOLERANCE:
        problems.append("top and bottom edges do not meet (%.1f, vs a steep "
                        "in-tile row step of %.1f)" % (wrap_y, local_y))

    mean = tile.convert("RGB").resize((1, 1), Image.BOX).getpixel((0, 0))

    print("%-28s %sx%s -> %dx%d  mean #%02X%02X%02X"
          % (name, original.size[0], original.size[1], TILE, TILE, *mean))
    print("    wrap L/R %6.1f (steep step %5.1f)   wrap T/B %6.1f (steep step %5.1f)"
          % (wrap_x, local_x, wrap_y, local_y))
    for problem in problems:
        print("    PROBLEM: %s" % problem)
    if not problems:
        print("    ok - correct size, opaque, and wraps without a visible seam")

    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
        target = os.path.join(out_dir, name)
        tile.save(target)
        print("    wrote %s" % target)

    return not problems


def main():
    args = sys.argv[1:]
    out_dir = None
    if args and args[0] == "--write":
        if len(args) < 3:
            raise SystemExit(__doc__)
        out_dir = args[1]
        args = args[2:]
    if not args:
        raise SystemExit(__doc__)

    clean = True
    for path in args:
        clean = check(path, out_dir) and clean
    # A non-zero exit so this can gate a loop over a batch of generations.
    raise SystemExit(0 if clean else 1)


main()
