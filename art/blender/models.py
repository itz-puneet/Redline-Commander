"""Blocked-out models for every unit type, as declarative part lists.

This is *art source*, not game data - nothing here affects a rule, and
nothing in `shared/data/` is duplicated. It lives as text rather than as a
binary .blend so it diffs, reviews, and rebuilds reproducibly; `build.py`
turns it into meshes, and a human can open the result in Blender and refine
or replace it without touching the rest of the pipeline.

Everything here is original geometry: primitives placed by hand-written
numbers. Do not import a model from an asset library or reproduce a vehicle
from another game (see the hard rule in CLAUDE.md) - a licence on a mesh
follows the rendered sprite into the repository.

Coordinates are in tiles: 1.0 is one board tile wide. +X is right, +Y is
away from the camera, +Z is up, and a unit faces -Y (toward the viewer).

Material roles:
  team   the faction colour, and the only thing written to the mask pass
  dark   tracks, wheels, weapons - reads as the unit's outline
  light  highlights that must stay readable against every faction colour
  glass  canopies and viewports

Silhouette is the whole job at 48px: a player identifies a unit by outline
in a quarter of a second. Each entry below exaggerates one feature that no
other unit has - the artillery's raised barrel, the helicopter's rotor span,
the anti-air's steeply elevated twin mounts. Keep that when replacing these
with real art.
"""

# One tile at the board's TILE_SIZE. Parts may exceed it (a rotor overhangs);
# the renderer's ORTHO_SCALE decides how much overhang still fits in frame.
TILE = 1.0


def _treads(width, length, z=0.10, thickness=0.13):
    """A pair of tracks either side of a hull, the tell for a tracked unit."""
    return [
        {"shape": "box", "loc": (sign * width, 0.0, z),
         "size": (thickness, length, 0.16), "mat": "dark"}
        for sign in (-1.0, 1.0)
    ]


def _wheels(width, offsets, radius=0.09, z=0.09):
    """Wheels as cylinders lying on their side, one pair per offset."""
    parts = []
    for y in offsets:
        for sign in (-1.0, 1.0):
            parts.append({
                "shape": "cylinder", "loc": (sign * width, y, z),
                "size": (radius, radius, 0.07), "rot": (0.0, 90.0, 0.0),
                "mat": "dark",
            })
    return parts


def _soldier(team_torso=True):
    """The shared body both infantry types are built on."""
    return [
        {"shape": "box", "loc": (0.0, 0.0, 0.13), "size": (0.24, 0.18, 0.26),
         "mat": "dark"},
        {"shape": "box", "loc": (0.0, 0.0, 0.40), "size": (0.34, 0.23, 0.31),
         "mat": "team" if team_torso else "dark"},
        {"shape": "sphere", "loc": (0.0, -0.03, 0.63), "size": (0.13, 0.13, 0.12),
         "mat": "light"},
        {"shape": "box", "loc": (0.0, 0.13, 0.42), "size": (0.22, 0.10, 0.22),
         "mat": "dark"},
    ]


def _boat(length, width, deck_width, deck_length):
    """A hull, a raked bow and a deck. Shared by everything that floats."""
    return [
        {"shape": "box", "loc": (0.0, 0.04, 0.11), "size": (width, length, 0.14),
         "mat": "dark"},
        {"shape": "cone", "loc": (0.0, -(length / 2.0 + 0.04), 0.11),
         "size": (width / 2.0, width / 2.0, 0.26), "rot": (90.0, 0.0, 0.0),
         "mat": "dark"},
        {"shape": "box", "loc": (0.0, 0.0, 0.21), "size": (deck_width, deck_length, 0.05),
         "mat": "team"},
    ]


MODELS = {
    # A lone upright figure - the smallest silhouette on the board, and the
    # only one with a visible head.
    "infantry": _soldier() + [
        {"shape": "box", "loc": (0.19, -0.10, 0.40), "size": (0.04, 0.38, 0.04),
         "rot": (14.0, 0.0, 0.0), "mat": "dark"},
    ],

    # The same figure carrying a launcher tube well clear of the shoulder, so
    # it does not read as plain infantry at a glance.
    "anti_tank_infantry": _soldier() + [
        {"shape": "cylinder", "loc": (0.02, -0.04, 0.56), "size": (0.06, 0.06, 0.58),
         "rot": (70.0, 0.0, -42.0), "mat": "dark"},
        {"shape": "box", "loc": (-0.21, 0.02, 0.38), "size": (0.11, 0.13, 0.18),
         "mat": "light"},
    ],

    # Low, wheeled and antenna-topped: the fastest-reading "not a tank".
    "recon": [
        {"shape": "box", "loc": (0.0, 0.0, 0.16), "size": (0.36, 0.62, 0.14),
         "mat": "team"},
        {"shape": "box", "loc": (0.0, -0.07, 0.28), "size": (0.29, 0.25, 0.12),
         "mat": "glass"},
        {"shape": "cylinder", "loc": (-0.13, 0.24, 0.42), "size": (0.012, 0.012, 0.40),
         "mat": "dark"},
    ] + _wheels(0.19, (-0.19, 0.19)),

    # One very long barrel, traversed hard off the hull's axis. Pointing it
    # forward and up would aim it almost straight down the camera, where
    # even a full-length barrel foreshortens to a stub; across the view it
    # keeps its length, which is the whole silhouette.
    "artillery": [
        {"shape": "box", "loc": (0.0, 0.02, 0.17), "size": (0.44, 0.60, 0.18),
         "mat": "team"},
        {"shape": "box", "loc": (0.0, 0.06, 0.31), "size": (0.30, 0.30, 0.14),
         "mat": "team"},
        {"shape": "cylinder", "loc": (0.02, -0.10, 0.46), "size": (0.036, 0.036, 0.80),
         "rot": (74.0, 0.0, -34.0), "mat": "dark"},
        {"shape": "box", "loc": (0.0, 0.28, 0.24), "size": (0.22, 0.10, 0.10),
         "mat": "light"},
    ] + _treads(0.25, 0.62),

    "light_tank": [
        {"shape": "box", "loc": (0.0, 0.0, 0.17), "size": (0.42, 0.58, 0.16),
         "mat": "team"},
        {"shape": "cylinder", "loc": (0.0, 0.04, 0.31), "size": (0.17, 0.17, 0.14),
         "mat": "team"},
        {"shape": "cylinder", "loc": (0.0, -0.26, 0.31), "size": (0.036, 0.036, 0.40),
         "rot": (90.0, 0.0, 0.0), "mat": "dark"},
    ] + _treads(0.24, 0.58),

    # Wider, taller and skirted, so it out-masses the light tank in outline
    # rather than only in colour.
    "heavy_tank": [
        {"shape": "box", "loc": (0.0, 0.0, 0.19), "size": (0.54, 0.70, 0.20),
         "mat": "team"},
        {"shape": "box", "loc": (0.0, 0.05, 0.36), "size": (0.42, 0.40, 0.19),
         "mat": "team"},
        {"shape": "cylinder", "loc": (0.0, -0.34, 0.36), "size": (0.055, 0.055, 0.50),
         "rot": (90.0, 0.0, 0.0), "mat": "dark"},
        {"shape": "box", "loc": (0.19, 0.16, 0.44), "size": (0.10, 0.14, 0.07),
         "mat": "light"},
    ] + _treads(0.31, 0.70, thickness=0.15),

    # Twin mounts elevated almost vertically: the only unit whose weapons
    # point at the sky.
    "anti_air": [
        {"shape": "box", "loc": (0.0, 0.0, 0.17), "size": (0.42, 0.56, 0.16),
         "mat": "team"},
        {"shape": "box", "loc": (0.0, 0.06, 0.30), "size": (0.28, 0.26, 0.13),
         "mat": "team"},
        {"shape": "cylinder", "loc": (-0.07, -0.10, 0.52), "size": (0.030, 0.030, 0.44),
         "rot": (20.0, 0.0, 0.0), "mat": "dark"},
        {"shape": "cylinder", "loc": (0.07, -0.10, 0.52), "size": (0.030, 0.030, 0.44),
         "rot": (20.0, 0.0, 0.0), "mat": "dark"},
        {"shape": "box", "loc": (-0.16, 0.18, 0.40), "size": (0.04, 0.16, 0.16),
         "rot": (0.0, 24.0, 0.0), "mat": "light"},
    ] + _treads(0.24, 0.56),

    # Rotor blades overhang the tile on purpose: nothing else is this wide,
    # and the raised fuselage and visible skids are what sell it as airborne.
    "helicopter": [
        {"shape": "sphere", "loc": (0.0, -0.04, 0.40), "size": (0.21, 0.34, 0.19),
         "mat": "team"},
        {"shape": "sphere", "loc": (0.0, -0.24, 0.38), "size": (0.15, 0.14, 0.13),
         "mat": "glass"},
        {"shape": "box", "loc": (0.0, 0.34, 0.42), "size": (0.06, 0.46, 0.06),
         "mat": "team"},
        {"shape": "box", "loc": (0.0, 0.55, 0.52), "size": (0.03, 0.14, 0.18),
         "mat": "light"},
        {"shape": "cylinder", "loc": (0.0, -0.04, 0.60), "size": (0.022, 0.022, 0.12),
         "mat": "dark"},
        {"shape": "box", "loc": (0.0, -0.04, 0.64), "size": (1.04, 0.05, 0.016),
         "rot": (0.0, 0.0, 18.0), "mat": "dark"},
        {"shape": "box", "loc": (0.0, -0.04, 0.64), "size": (0.05, 1.04, 0.016),
         "rot": (0.0, 0.0, 18.0), "mat": "dark"},
        {"shape": "box", "loc": (-0.16, -0.04, 0.24), "size": (0.03, 0.34, 0.03),
         "mat": "dark"},
        {"shape": "box", "loc": (0.16, -0.04, 0.24), "size": (0.03, 0.34, 0.03),
         "mat": "dark"},
    ],

    # A pointed nose and hard-swept wings, flying higher than the helicopter
    # so the two do not read the same in a stack.
    "fighter_jet": [
        {"shape": "cylinder", "loc": (0.0, 0.02, 0.46), "size": (0.09, 0.09, 0.66),
         "rot": (90.0, 0.0, 0.0), "mat": "team"},
        {"shape": "cone", "loc": (0.0, -0.42, 0.46), "size": (0.09, 0.09, 0.26),
         "rot": (90.0, 0.0, 0.0), "mat": "team"},
        {"shape": "sphere", "loc": (0.0, -0.16, 0.52), "size": (0.09, 0.16, 0.07),
         "mat": "glass"},
        {"shape": "box", "loc": (-0.19, 0.14, 0.45), "size": (0.44, 0.26, 0.03),
         "rot": (0.0, 0.0, 34.0), "mat": "team"},
        {"shape": "box", "loc": (0.19, 0.14, 0.45), "size": (0.44, 0.26, 0.03),
         "rot": (0.0, 0.0, -34.0), "mat": "team"},
        {"shape": "box", "loc": (0.0, 0.32, 0.56), "size": (0.03, 0.20, 0.16),
         "mat": "light"},
        {"shape": "cylinder", "loc": (0.0, 0.34, 0.46), "size": (0.07, 0.07, 0.10),
         "rot": (90.0, 0.0, 0.0), "mat": "dark"},
    ],

    # Long, low and flat-decked, with the bridge pushed right to the stern -
    # the only unit whose length runs past the tile edge.
    "transport_ship": [
        {"shape": "box", "loc": (0.0, 0.04, 0.12), "size": (0.42, 0.80, 0.16),
         "mat": "dark"},
        {"shape": "cone", "loc": (0.0, -0.46, 0.12), "size": (0.21, 0.21, 0.30),
         "rot": (90.0, 0.0, 0.0), "mat": "dark"},
        {"shape": "box", "loc": (0.0, -0.02, 0.22), "size": (0.36, 0.60, 0.05),
         "mat": "team"},
        {"shape": "box", "loc": (0.0, 0.30, 0.32), "size": (0.24, 0.18, 0.22),
         "mat": "light"},
        {"shape": "box", "loc": (0.0, 0.30, 0.44), "size": (0.20, 0.14, 0.06),
         "mat": "glass"},
        {"shape": "cylinder", "loc": (0.0, 0.36, 0.56), "size": (0.012, 0.012, 0.26),
         "mat": "dark"},
    ],

    # Between the light and heavy tank, and turned off-axis so it is not
    # simply "the light tank again but bigger" - the angled turret is what
    # separates the three tanks at a glance.
    "medium_tank": [
        {"shape": "box", "loc": (0.0, 0.0, 0.18), "size": (0.48, 0.64, 0.18),
         "mat": "team"},
        {"shape": "box", "loc": (0.0, 0.05, 0.34), "size": (0.36, 0.34, 0.16),
         "rot": (0.0, 0.0, 16.0), "mat": "team"},
        {"shape": "cylinder", "loc": (-0.09, -0.28, 0.34), "size": (0.045, 0.045, 0.46),
         "rot": (90.0, 0.0, 16.0), "mat": "dark"},
        {"shape": "box", "loc": (0.0, 0.28, 0.31), "size": (0.24, 0.10, 0.10),
         "mat": "light"},
    ] + _treads(0.27, 0.64),

    # A boxy launcher pod raised off the back of a wheeled chassis. Nothing
    # else on the board is a rectangle standing on end.
    "rocket_artillery": [
        {"shape": "box", "loc": (0.0, 0.02, 0.17), "size": (0.40, 0.58, 0.16),
         "mat": "team"},
        {"shape": "box", "loc": (0.0, -0.20, 0.30), "size": (0.30, 0.18, 0.14),
         "mat": "light"},
        {"shape": "box", "loc": (0.0, 0.14, 0.42), "size": (0.34, 0.30, 0.26),
         "rot": (-34.0, 0.0, 0.0), "mat": "dark"},
        {"shape": "box", "loc": (0.0, 0.14, 0.42), "size": (0.36, 0.06, 0.28),
         "rot": (-34.0, 0.0, 0.0), "mat": "team"},
    ] + _wheels(0.21, (-0.19, 0.02, 0.22)),

    # Straight wings and two engines, against the fighter's swept delta:
    # from above, wing shape is the only thing telling two aircraft apart.
    "bomber": [
        {"shape": "cylinder", "loc": (0.0, 0.0, 0.44), "size": (0.11, 0.11, 0.74),
         "rot": (90.0, 0.0, 0.0), "mat": "team"},
        {"shape": "sphere", "loc": (0.0, -0.40, 0.44), "size": (0.11, 0.16, 0.11),
         "mat": "glass"},
        {"shape": "box", "loc": (0.0, 0.02, 0.42), "size": (1.00, 0.24, 0.035),
         "mat": "team"},
        {"shape": "cylinder", "loc": (-0.30, 0.0, 0.38), "size": (0.055, 0.055, 0.24),
         "rot": (90.0, 0.0, 0.0), "mat": "dark"},
        {"shape": "cylinder", "loc": (0.30, 0.0, 0.38), "size": (0.055, 0.055, 0.24),
         "rot": (90.0, 0.0, 0.0), "mat": "dark"},
        {"shape": "box", "loc": (0.0, 0.34, 0.44), "size": (0.40, 0.14, 0.03),
         "mat": "light"},
        {"shape": "box", "loc": (0.0, 0.36, 0.54), "size": (0.03, 0.16, 0.16),
         "mat": "light"},
    ],

    # The smallest thing in the air, with a propeller disc no other unit has.
    "scout_plane": [
        {"shape": "cylinder", "loc": (0.0, 0.02, 0.40), "size": (0.065, 0.065, 0.44),
         "rot": (90.0, 0.0, 0.0), "mat": "team"},
        {"shape": "box", "loc": (0.0, -0.02, 0.48), "size": (0.68, 0.15, 0.028),
         "mat": "team"},
        {"shape": "sphere", "loc": (0.0, -0.06, 0.44), "size": (0.06, 0.10, 0.05),
         "mat": "glass"},
        {"shape": "cylinder", "loc": (0.0, -0.25, 0.40), "size": (0.14, 0.14, 0.02),
         "rot": (90.0, 0.0, 0.0), "mat": "dark"},
        {"shape": "box", "loc": (0.0, 0.22, 0.40), "size": (0.26, 0.10, 0.02),
         "mat": "light"},
        {"shape": "box", "loc": (0.0, 0.23, 0.47), "size": (0.02, 0.11, 0.12),
         "mat": "light"},
    ],

    # Short, open and quick - it reads as small next to the other two ships,
    # which is exactly what it is.
    "patrol_boat": _boat(0.56, 0.30, 0.26, 0.42) + [
        {"shape": "cylinder", "loc": (0.0, -0.14, 0.30), "size": (0.095, 0.095, 0.14),
         "mat": "light"},
        {"shape": "cylinder", "loc": (0.0, -0.20, 0.40), "size": (0.028, 0.028, 0.30),
         "rot": (34.0, 0.0, -20.0), "mat": "dark"},
        {"shape": "cylinder", "loc": (0.0, 0.16, 0.38), "size": (0.012, 0.012, 0.26),
         "mat": "dark"},
    ],

    # The anti-air of the sea, and shaped to say so: the same steeply
    # elevated twin mounts, on a hull.
    "escort": _boat(0.76, 0.34, 0.30, 0.60) + [
        {"shape": "box", "loc": (0.0, 0.10, 0.32), "size": (0.22, 0.26, 0.18),
         "mat": "light"},
        {"shape": "cylinder", "loc": (-0.06, -0.20, 0.40), "size": (0.026, 0.026, 0.34),
         "rot": (22.0, 0.0, 0.0), "mat": "dark"},
        {"shape": "cylinder", "loc": (0.06, -0.20, 0.40), "size": (0.026, 0.026, 0.34),
         "rot": (22.0, 0.0, 0.0), "mat": "dark"},
        {"shape": "box", "loc": (0.0, 0.10, 0.46), "size": (0.04, 0.16, 0.16),
         "rot": (0.0, 26.0, 0.0), "mat": "dark"},
        {"shape": "cylinder", "loc": (0.0, 0.26, 0.44), "size": (0.012, 0.012, 0.30),
         "mat": "dark"},
    ],

    # Artillery that floats, and drawn like it: the same barrels traversed
    # hard across the view, so its role reads before its outline does.
    "monitor": _boat(0.72, 0.38, 0.32, 0.54) + [
        {"shape": "box", "loc": (0.0, -0.10, 0.36), "size": (0.30, 0.28, 0.18),
         "mat": "team"},
        {"shape": "cylinder", "loc": (-0.10, -0.20, 0.50), "size": (0.036, 0.036, 0.52),
         "rot": (76.0, 0.0, -36.0), "mat": "dark"},
        {"shape": "cylinder", "loc": (-0.04, -0.26, 0.50), "size": (0.036, 0.036, 0.52),
         "rot": (76.0, 0.0, -36.0), "mat": "dark"},
        {"shape": "box", "loc": (0.0, 0.22, 0.34), "size": (0.22, 0.20, 0.20),
         "mat": "light"},
    ],
}
