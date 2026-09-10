#!/usr/bin/env python3
"""One-time migration: project art/blender/models.py into editable SVGs.

    art/svg/seed_from_blockouts.py

Writes one <unit>.svg per unit type into art/svg/, replacing what is there.

This exists so the move to SVG does not mean redrawing seventeen units
before anything can be looked at. It projects the blockout geometry through
the same camera the Blender renders used, flattens each solid into the faces
the camera can see, and shades them in three tones.

What comes out is a plain SVG of literal coordinates - the point is that it
is now hand-editable, and that hand-editing is how it is meant to improve
from here. Nothing reads models.py at build time; once seeded, the SVGs are
the source and the blockouts are history.

By default it skips any unit that already has an SVG. A seeded drawing is
worse than a hand-drawn one, and this script destroyed three of them the
first time it was run twice. Pass --force to overwrite deliberately.
"""

import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "blender"))
import models  # noqa: E402

# Kept in step with art/blender/render_sprites.py, because the seeded
# coordinates only line up with the old sheet if the camera matches.
PITCH = math.radians(34.0)
YAW = math.radians(-30.0)
SCALE = 48.0 * 0.98
CELL = 64.0
FRAME_CENTRE = 0.366 * math.sin(PITCH)

# Roughly the Blender key light, so the seeded shading matches what the
# renders looked like.
LIGHT = (-0.42, -0.48, 0.77)
VIEW = (0.0, math.sin(PITCH), -math.cos(PITCH))

TONES = {
    "team": ("team-hi", "team", "team-lo"),
    "dark": ("dark-hi", "dark", "dark"),
    "light": ("light", "light", "light"),
    "glass": ("glass", "glass", "glass"),
}
STROKES = {"team": "edge", "dark": "edge", "light": "edge", "glass": "edge"}


def yaw(point):
    x, y, z = point
    return (x * math.cos(YAW) - y * math.sin(YAW),
            x * math.sin(YAW) + y * math.cos(YAW), z)


def screen(point):
    x, y, z = point
    v = z * math.sin(PITCH) - y * math.cos(PITCH)
    return (CELL / 2 + x * SCALE, CELL / 2 - (v - FRAME_CENTRE) * SCALE)


def depth(point):
    """How far along the view direction a point is. Larger is farther."""
    return sum(a * b for a, b in zip(point, VIEW))


def rotate(point, angles):
    """Euler XYZ, then the global yaw - the same order Blender applies."""
    x, y, z = point
    rx, ry, rz = (math.radians(a) for a in angles)
    y, z = y * math.cos(rx) - z * math.sin(rx), y * math.sin(rx) + z * math.cos(rx)
    x, z = x * math.cos(ry) + z * math.sin(ry), -x * math.sin(ry) + z * math.cos(ry)
    x, y = x * math.cos(rz) - y * math.sin(rz), x * math.sin(rz) + y * math.cos(rz)
    return yaw((x, y, z))


def tone(role, normal):
    lit = sum(a * b for a, b in zip(normal, LIGHT))
    hi, mid, lo = TONES[role]
    return hi if lit > 0.62 else (mid if lit > 0.12 else lo)


def unit_scale(part):
    return [value * 0.98 for value in part["size"]]


def placed(part, local):
    """A model-space point on a part, in world space."""
    spun = rotate([local[i] * unit_scale(part)[i] for i in range(3)], part.get("rot", (0, 0, 0)))
    origin = yaw([value * 0.98 for value in part["loc"]])
    return tuple(spun[i] + origin[i] for i in range(3))


BOX_FACES = [
    ((0, 0, 1), [(-1, -1, 1), (1, -1, 1), (1, 1, 1), (-1, 1, 1)]),
    ((0, 0, -1), [(-1, 1, -1), (1, 1, -1), (1, -1, -1), (-1, -1, -1)]),
    ((0, -1, 0), [(-1, -1, -1), (1, -1, -1), (1, -1, 1), (-1, -1, 1)]),
    ((0, 1, 0), [(-1, 1, 1), (1, 1, 1), (1, 1, -1), (-1, 1, -1)]),
    ((1, 0, 0), [(1, -1, -1), (1, 1, -1), (1, 1, 1), (1, -1, 1)]),
    ((-1, 0, 0), [(-1, -1, 1), (-1, 1, 1), (-1, 1, -1), (-1, -1, -1)]),
]


def box_elements(part, role):
    out = []
    for normal, corners in BOX_FACES:
        world_normal = rotate(normal, part.get("rot", (0, 0, 0)))
        if sum(a * b for a, b in zip(world_normal, VIEW)) >= -0.02:
            continue  # facing away
        points = [placed(part, [c / 2.0 for c in corner]) for corner in corners]
        polygon = " ".join("%.1f,%.1f" % screen(p) for p in points)
        out.append((max(depth(p) for p in points),
                    '<polygon class="%s %s" points="%s"/>'
                    % (tone(role, world_normal), STROKES[role], polygon)))
    return out


def ellipse_elements(part, role):
    """A sphere, drawn as the ellipse its silhouette projects to."""
    centre = placed(part, (0, 0, 0))
    rx, ry, rz = unit_scale(part)
    # The model's +Y on screen, so an elongated body lies along its length.
    along = screen(placed(part, (0, 1, 0)))
    origin = screen(centre)
    angle = math.degrees(math.atan2(along[1] - origin[1], along[0] - origin[0]))
    major = ry * SCALE
    minor = max(rx, rz * math.sin(PITCH)) * SCALE
    return [(depth(centre),
             '<ellipse class="%s %s" cx="%.1f" cy="%.1f" rx="%.1f" ry="%.1f"'
             ' transform="rotate(%.0f %.1f %.1f)"/>'
             % (tone(role, (0, 0, 1)), STROKES[role], origin[0], origin[1],
                major, minor, angle, origin[0], origin[1]))]


def cylinder_elements(part, role):
    axis = rotate((0, 0, 1), part.get("rot", (0, 0, 0)))
    top = placed(part, (0, 0, 0.5))
    bottom = placed(part, (0, 0, -0.5))
    radius = unit_scale(part)[0] * SCALE
    if abs(axis[2]) > 0.86:
        # Standing upright: a base and a lid, which is how a turret reads.
        out = []
        for point, shade in ((bottom, (0, -1, 0)), (top, (0, 0, 1))):
            centre = screen(point)
            out.append((depth(point),
                        '<ellipse class="%s %s" cx="%.1f" cy="%.1f" rx="%.1f" ry="%.1f"/>'
                        % (tone(role, shade), STROKES[role], centre[0], centre[1],
                           radius, radius * math.cos(PITCH))))
        return out
    if radius > unit_scale(part)[2] * SCALE:
        # Wider than it is long: a disc, not a rod. A propeller drawn as a
        # thick short line becomes an unreadable stub.
        centre = screen(placed(part, (0, 0, 0)))
        edge = screen(placed(part, (1.0, 0, 0)))
        angle = math.degrees(math.atan2(edge[1] - centre[1], edge[0] - centre[0]))
        return [(depth(placed(part, (0, 0, 0))),
                 '<ellipse class="%s %s" cx="%.1f" cy="%.1f" rx="%.1f" ry="%.1f"'
                 ' transform="rotate(%.0f %.1f %.1f)"/>'
                 % (tone(role, (0, 0, 1)), STROKES[role], centre[0], centre[1],
                    radius, radius * math.cos(PITCH), angle, centre[0], centre[1]))]
    # Lying along its length: a stroked line, which keeps a thin barrel from
    # collapsing into a sliver of polygon.
    a, b = screen(top), screen(bottom)
    return [(max(depth(top), depth(bottom)),
             '<line class="rod-%s" x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f"'
             ' stroke-width="%.1f"/>' % (role, a[0], a[1], b[0], b[1], radius * 2))]


def cone_elements(part, role):
    apex = placed(part, (0, 0, 0.5))
    base = placed(part, (0, 0, -0.5))
    radius = unit_scale(part)[0] * SCALE
    centre = screen(base)
    tip = screen(apex)
    across = (-(tip[1] - centre[1]), tip[0] - centre[0])
    length = math.hypot(*across) or 1.0
    across = (across[0] / length * radius, across[1] / length * radius)
    points = " ".join("%.1f,%.1f" % p for p in [
        (centre[0] + across[0], centre[1] + across[1]), tip,
        (centre[0] - across[0], centre[1] - across[1])])
    return [(max(depth(apex), depth(base)),
             '<polygon class="%s %s" points="%s"/>'
             % (tone(role, (0, 0, 1)), STROKES[role], points))]


BUILDERS = {"box": box_elements, "sphere": ellipse_elements,
            "cylinder": cylinder_elements, "cone": cone_elements}

HEADER = '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <!-- Seeded from art/blender/models.py by seed_from_blockouts.py, then
       meant to be edited by hand. See art/svg/_palette.md for the classes;
       a shape is faction-coloured if and only if its class says so. -->
  <style>
    .team-hi{fill:#cfcfd1}.team{fill:#bdbdbe}.team-lo{fill:#93939a}
    .dark{fill:#43454d}.dark-hi{fill:#55575f}.light{fill:#d2d4d9}.glass{fill:#5b8ab4}
    .edge{stroke:#2b2d33;stroke-width:0.7;stroke-linejoin:round}
    .rod-dark{stroke:#43454d;stroke-linecap:round}
    .rod-team{stroke:#bdbdbe;stroke-linecap:round}
    .rod-light{stroke:#d2d4d9;stroke-linecap:round}
    .rod-glass{stroke:#5b8ab4;stroke-linecap:round}
  </style>
'''


def main():
    force = "--force" in sys.argv[1:]
    if [arg for arg in sys.argv[1:] if arg != "--force"]:
        raise SystemExit("usage: seed_from_blockouts.py [--force]")
    written = skipped = 0
    for unit_type, parts in models.MODELS.items():
        target = os.path.join(HERE, unit_type + ".svg")
        if os.path.exists(target) and not force:
            print("  %-20s kept (already drawn)" % unit_type)
            skipped += 1
            continue
        elements = []
        for part in parts:
            role = part.get("mat", "dark")
            elements.extend(BUILDERS[part["shape"]](part, role))
        # Farthest first: without this a barrel behind a hull draws over it.
        elements.sort(key=lambda item: -item[0])
        body = "\n".join("  " + element for _, element in elements)
        with open(target, "w") as handle:
            handle.write(HEADER + body + "\n</svg>\n")
        print("  %-20s seeded, %d elements" % (unit_type, len(elements)))
        written += 1
    print("seeded %d, kept %d, in %s" % (written, skipped, HERE))


main()
