#!/usr/bin/env python3
"""Generate the seamless water tiles - shallow_water.png and river.png.

    art/png/make_water_tiles.py <output dir>

Water is the one terrain that should never have been an illustration. It has
no landmark to draw, only a surface, and a surface is a sum of waves - so
these are built rather than painted, and built in a way that *cannot* seam.

Every wave used here has an integer number of periods across the tile, so
the pattern is exactly periodic at 48 px in both axes: the right edge
continues into the left because they are the same phase of the same wave,
not because someone blended them. That also means there is no downscale
step, which is where a tileable 1024 px generation usually loses its wrap
(see `prepare()` in check_tile.py for why).

The two tiles differ in palette and in how the waves are stacked, not in
kind. Sea is a deeper, more saturated cyan with a longer swell under it;
river is paler, greener and choppier, because on the board it is a
two-tile-wide line between banks rather than open water.

Deliberately NOT directional. River tiles turn corners on `crossing` and run
straight across `pass`, and there is no neighbour-aware variant for river -
one tile has to work in every orientation, so a current flowing one way
would be wrong half the time. The ripple is cross-hatched instead: it reads
as moving water without committing to a direction.

Re-run it to change the look; the output is committed, so this is only for
changing it.
"""

import os
import sys

import numpy as np
from PIL import Image

TILE = 48


def surface(spectrum, phase_seed):
    """Band-limited tileable noise, in roughly -1..1.

    Every component has an INTEGER number of periods across the tile, which
    is what makes this wrap exactly - but a handful of them is not enough.
    Five waves interfere into a regular lattice: the tile seams perfectly
    and still reads as wallpaper, because the eye locks onto the repeating
    interference pattern instead of the edge. So this sums every integer
    frequency inside a radius, with amplitude falling off as 1/k**falloff
    and a random phase each, which is a pink-noise surface - organic at a
    glance, and still exactly periodic because every term is.

    `spectrum` is (low_cut, radius, falloff). The low cut matters as much as
    anything: a component with one or two periods across the tile makes a
    feature the size of the tile, and a tile-sized feature is precisely what
    the eye locks onto when the map repeats it - the texture stops reading
    as water and starts reading as a stamp. Cutting everything below three
    periods keeps the largest ripple well under a tile, so there is nothing
    big enough to recognise. Radius sets the finest ripple; above about 12
    at 48 px that is detail finer than the pixel it lands on.
    """
    low_cut, radius, falloff = spectrum
    y, x = np.mgrid[0:TILE, 0:TILE].astype(np.float64)
    height = np.zeros((TILE, TILE))
    rng = np.random.default_rng(phase_seed)

    for periods_x in range(-radius, radius + 1):
        for periods_y in range(-radius, radius + 1):
            if periods_x == 0 and periods_y == 0:
                continue
            frequency = np.hypot(periods_x, periods_y)
            if frequency > radius or frequency < low_cut:
                continue
            # Half the (kx, ky) grid duplicates the other half's waves with
            # a phase shift, so only one of each opposed pair is taken.
            if (periods_y < 0) or (periods_y == 0 and periods_x < 0):
                continue
            phase = rng.uniform(0, 2 * np.pi)
            height += (frequency ** -falloff) * np.sin(
                2 * np.pi * (periods_x * x / TILE + periods_y * y / TILE) + phase)

    peak = np.abs(height).max()
    return height / peak if peak else height


def colourise(height, trough, crest, bands):
    """Quantise the height field into flat colour bands along a ramp.

    Bands rather than a smooth gradient, for two reasons. The rest of the
    terrain art is flat cartoon vector work, and a soft gradient sits oddly
    beside it. More practically, a smooth field needs isolated bright specks
    to read as water at all - and isolated high-contrast marks are the
    easiest thing in the world for the eye to find, so they turn into a
    visible grid the moment the tile repeats. Contour bands give the same
    wave-crest reading with no feature small enough to track.
    """
    normalised = np.clip((height + 1.0) / 2.0, 0.0, 1.0)
    # floor to a band, then take the band's midpoint so the darkest and
    # lightest bands are not the raw endpoints of the ramp.
    stepped = (np.floor(normalised * bands) + 0.5) / bands

    tile = np.zeros((TILE, TILE, 3))
    for channel in range(3):
        tile[:, :, channel] = (
            trough[channel] + (crest[channel] - trough[channel]) * stepped)
    return Image.fromarray(np.clip(tile, 0, 255).astype(np.uint8), "RGB")


# Sea: a long swell with finer chop over it, in saturated cyan. The mean
# lands near the #09AAED the shipped tile already sits at, so the new tile
# drops in beside the shoreline variants without a visible change of colour.
SHALLOW = dict(
    spectrum=(3, 7, 1.45),
    phase_seed=20260917,
    trough=(0, 152, 242),
    crest=(42, 206, 255),
    bands=4,
)

# River: paler, greener and busier - shorter waves, no long swell, so it
# reads as moving water in a channel rather than open sea.
RIVER = dict(
    spectrum=(3, 8, 1.35),
    phase_seed=4242,
    trough=(32, 130, 164),
    crest=(112, 202, 216),
    bands=4,
)


def build(spec):
    return colourise(
        surface(spec["spectrum"], spec["phase_seed"]),
        spec["trough"], spec["crest"], spec["bands"])


def main():
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    out_dir = sys.argv[1]
    os.makedirs(out_dir, exist_ok=True)

    for name, spec in (("shallow_water", SHALLOW), ("river", RIVER)):
        tile = build(spec).convert("RGBA")
        path = os.path.join(out_dir, "%s.png" % name)
        tile.save(path)
        mean = tile.convert("RGB").resize((1, 1), Image.BOX).getpixel((0, 0))
        print("wrote %s  mean #%02X%02X%02X" % (path, *mean))


main()
