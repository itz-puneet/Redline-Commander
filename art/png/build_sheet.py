#!/usr/bin/env python3
"""Build the unit sprite sheet from PNG artwork.

    art/png/build_sheet.py <output directory> [--source DIR] [--diff-suffix red]

Drop one PNG per unit type into art/png/units/, named for the unit -
`heavy_tank.png`, `escort.png` - and this composes the sheet, the faction
mask and the manifest that the game loads. Same three files the Blender and
SVG paths produce; everything downstream is unchanged.

Source images may be any square size. They are downsampled to the 64px cell
with the alpha premultiplied first, which is what stops a transparent
background bleeding a dark halo into every antialiased edge - the single
most common way good artwork comes out looking cheap once it is small.

## Telling the build which pixels take the faction colour

The game renders one neutral sheet and tints it per player, so it has to be
told which pixels are the faction's. Two ways, in order of preference:

1. **A mask file.** Alongside `heavy_tank.png`, a `heavy_tank_mask.png`
   where the faction areas are white and everything else is black or
   transparent. Any art tool exports this by toggling a layer.

2. **A second faction variant.** If you already have the artwork in more
   than one colour, pass `--diff-suffix red` and put `heavy_tank_red.png`
   beside `heavy_tank.png`. The mask is wherever the two differ. Use the
   neutral or grey version as `heavy_tank.png`, because that is the one that
   gets tinted.

If neither is present the unit still renders, but it will look identical for
both players. `sprite_check` fails on that rather than letting it ship.
"""

import json
import os
import sys

from PIL import Image

CELL = 64
TILE = 48
# How different two faction variants must be, per channel, to count as a
# faction pixel. Above JPEG-ish noise and resampling wobble, far below the
# distance between any two of the game's player colours.
DIFF_THRESHOLD = 24


def unit_order(root):
    with open(os.path.join(root, "shared", "data", "units.json")) as handle:
        return list(json.load(handle)["units"])


def load_square(path):
    image = Image.open(path).convert("RGBA")
    if image.width != image.height:
        raise SystemExit("%s is %dx%d - unit art must be square"
                         % (path, image.width, image.height))
    return image


def to_cell(image):
    """Downsample to the 64px cell, premultiplying alpha across the resize.

    Resizing straight (non-premultiplied) RGBA blends the colour of fully
    transparent pixels into the edge. On artwork drawn over transparency
    that colour is usually black, so every silhouette picks up a dark fringe
    that reads as dirt at sprite size.
    """
    if image.size == (CELL, CELL):
        return image
    # "RGBa" is Pillow's premultiplied mode: converting in, resizing, and
    # converting back is the whole trick.
    return image.convert("RGBa").resize((CELL, CELL), Image.LANCZOS).convert("RGBA")


def mask_for(base_path, image, diff_suffix):
    """Return a 64x64 mask image, or None when the art carries no faction area."""
    stem, extension = os.path.splitext(base_path)

    explicit = "%s_mask%s" % (stem, extension)
    if os.path.exists(explicit):
        return to_cell(load_square(explicit)).convert("L").point(
            lambda value: 255 if value > 127 else 0)

    if diff_suffix:
        variant = "%s_%s%s" % (stem, diff_suffix, extension)
        if os.path.exists(variant):
            other = to_cell(load_square(variant))
            width, height = image.size
            out = Image.new("L", (width, height), 0)
            base_pixels = image.load()
            other_pixels = other.load()
            out_pixels = out.load()
            for y in range(height):
                for x in range(width):
                    first = base_pixels[x, y]
                    second = other_pixels[x, y]
                    if first[3] < 128 or second[3] < 128:
                        continue
                    if max(abs(a - b) for a, b in zip(first[:3], second[:3])) > DIFF_THRESHOLD:
                        out_pixels[x, y] = 255
            return out
    return None


def main():
    argv = sys.argv[1:]
    if not argv or argv[0].startswith("-"):
        raise SystemExit("usage: build_sheet.py <output directory> "
                         "[--source DIR] [--diff-suffix NAME]")
    out_dir = argv[0]
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.dirname(os.path.dirname(here))
    source = os.path.join(here, "units")
    diff_suffix = None
    rest = argv[1:]
    while rest:
        flag = rest.pop(0)
        if flag == "--source" and rest:
            source = rest.pop(0)
        elif flag == "--diff-suffix" and rest:
            diff_suffix = rest.pop(0)
        else:
            raise SystemExit("unknown argument %r" % flag)

    order = [name for name in unit_order(root)
             if os.path.exists(os.path.join(source, name + ".png"))]
    if not order:
        raise SystemExit("no unit PNGs in %s - name them for the unit type, "
                         "e.g. heavy_tank.png" % source)

    os.makedirs(out_dir, exist_ok=True)
    sheet = Image.new("RGBA", (CELL * len(order), CELL), (0, 0, 0, 0))
    masks = Image.new("RGBA", (CELL * len(order), CELL), (0, 0, 0, 0))
    untinted = []
    clipped = []

    for index, name in enumerate(order):
        path = os.path.join(source, name + ".png")
        cell = to_cell(load_square(path))
        sheet.paste(cell, (index * CELL, 0))

        mask = mask_for(path, cell, diff_suffix)
        if mask is None:
            untinted.append(name)
        else:
            # The mask ships as white-on-black with the unit's own alpha, so
            # the shader never tints a pixel the artwork left empty.
            solid = Image.merge("RGBA", (mask, mask, mask, cell.split()[3]))
            masks.paste(solid, (index * CELL, 0))

        # The outer ring has to stay clear or a frame shows a slice of its
        # neighbour. Report it here, where the fix is the artwork.
        alpha = cell.split()[3]
        edge = [alpha.getpixel((x, y))
                for x in range(CELL) for y in range(CELL)
                if x in (0, CELL - 1) or y in (0, CELL - 1)]
        if max(edge) > 8:
            clipped.append(name)

    sheet.save(os.path.join(out_dir, "units.png"))
    masks.save(os.path.join(out_dir, "units_mask.png"))
    manifest = {
        "_comment": "Generated by art/png/build_sheet.py from the artwork in "
                    "art/png/units. Do not edit by hand.",
        "tile": TILE, "cell": CELL, "sheet": "units.png", "mask": "units_mask.png",
        "width": CELL * len(order), "height": CELL,
        "frames": {name: index for index, name in enumerate(order)},
    }
    with open(os.path.join(out_dir, "units.json"), "w") as handle:
        json.dump(manifest, handle, indent=2, sort_keys=True)
        handle.write("\n")

    missing = [name for name in unit_order(root) if name not in order]
    if missing:
        print("  no artwork yet for: %s" % ", ".join(missing))
    if untinted:
        print("  NO FACTION MASK, will look the same for both players: %s"
              % ", ".join(untinted))
    if clipped:
        print("  ARTWORK TOUCHES THE CELL BORDER, will bleed into the next "
              "frame: %s" % ", ".join(clipped))
    print("PNG_SHEET_OK %d units -> %s" % (len(order), out_dir))


main()
