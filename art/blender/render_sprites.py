"""Render the unit sprite sheet. Run through tools/render-sprites.sh.

    blender -b -noaudio -P art/blender/render_sprites.py -- --out client/assets/units

Two passes over one scene:

  base  the models lit and shaded, with faction-coloured parts left a
        neutral grey so a single sheet serves every player slot
  mask  the same frame with faction-coloured parts emitting white and
        everything else black, so the shader knows what to tint

Rendering both from one scene guarantees they line up; rendering all ten
units in one strip means each lands in its own cell by construction, so
there is no sprite-sheet assembly step to get wrong.

Cycles on CPU, not EEVEE: EEVEE needs a GL context, which a headless build
server does not have. Cycles needs none and is deterministic given a fixed
seed, which is what lets `tools/render-sprites.sh --check` re-render and
compare bytes.
"""

import hashlib
import json
import math
import os
import struct
import sys
import zlib

import bpy
import mathutils

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import models  # noqa: E402  (needs the path set above)

# The board draws a unit into a TILE_PX cell but gives it CELL_PX of room, so
# a rotor or a gun barrel can overhang its tile without being clipped or
# bleeding into the neighbouring frame. Keep these in step with
# BoardTheme.TILE_SIZE and UnitSprites.CELL on the client.
TILE_PX = 48
CELL_PX = 64
CELL_TILES = CELL_PX / TILE_PX

# Looking down at the board from the south. CAMERA_PITCH is measured from
# straight down, so 34 degrees is a high three-quarter view: steep enough
# that a tall unit does not cover the tile behind it, shallow enough that a
# turret still reads as a turret rather than a disc.
CAMERA_PITCH = 34.0
# Every unit is yawed off square before rendering. Facing the camera dead-on
# foreshortens a gun barrel into a stub; turning it lets the same barrel
# show its length, which is most of what distinguishes these silhouettes.
MODEL_YAW = -30.0
# One global multiplier for every model, so the whole set stays in scale
# with itself. Raising it fills more of the cell; the fit check below refuses
# a value that would clip.
MODEL_SCALE = 0.98
# How much of the cell the tallest model may occupy. The remainder is the
# margin that keeps an antialiased edge from touching the frame boundary.
MAX_FILL = 0.94
SAMPLES = 256
SEED = 20260101

MATERIALS = {
    # Mid grey on purpose: the shader multiplies the faction colour through
    # this, so it has to carry the shading without being so dark that a
    # deep faction colour turns to mud.
    "team": (0.74, 0.74, 0.75, 1.0),
    "dark": (0.26, 0.27, 0.31, 1.0),
    "light": (0.82, 0.83, 0.86, 1.0),
    "glass": (0.32, 0.52, 0.70, 1.0),
}
TEAM_ROLE = "team"


def unit_order():
    """Unit types in the order shared/data/units.json declares them.

    Read from the shared table rather than from models.py so a unit added to
    the game gets a frame - and so a unit with no model fails here rather
    than silently rendering nothing.
    """
    root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    with open(os.path.join(root, "shared", "data", "units.json")) as handle:
        table = json.load(handle)
    table = table.get("units", table)
    missing = [name for name in table if name not in models.MODELS]
    if missing:
        raise SystemExit("no model for unit type(s): %s (add them to art/blender/models.py)"
                         % ", ".join(sorted(missing)))
    return list(table)


def clear_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def make_material(name, colour, emission=None):
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    tree = material.node_tree
    tree.nodes.clear()
    output = tree.nodes.new("ShaderNodeOutputMaterial")
    if emission is None:
        shader = tree.nodes.new("ShaderNodeBsdfPrincipled")
        shader.inputs["Base Color"].default_value = colour
        shader.inputs["Roughness"].default_value = 0.85
        shader.inputs["Metallic"].default_value = 0.0
        # Flat, matte and unreflective: a specular highlight at 48px is one
        # stray bright pixel, not a highlight. Blender renamed this socket
        # in 4.x, so set whichever one this build has rather than assuming.
        for socket in ("Specular IOR Level", "Specular"):
            if socket in shader.inputs:
                shader.inputs[socket].default_value = 0.05
                break
    else:
        shader = tree.nodes.new("ShaderNodeEmission")
        shader.inputs["Color"].default_value = emission
        shader.inputs["Strength"].default_value = 1.0
    tree.links.new(shader.outputs[0], output.inputs["Surface"])
    return material


def add_part(part, origin, material):
    shape = part["shape"]
    size = tuple(value * MODEL_SCALE for value in part["size"])
    # Yaw the part around its own unit's centre, not around the strip, so
    # every unit turns in place inside its cell.
    yaw = math.radians(MODEL_YAW)
    local_x, local_y, local_z = (value * MODEL_SCALE for value in part["loc"])
    turned_x = local_x * math.cos(yaw) - local_y * math.sin(yaw)
    turned_y = local_x * math.sin(yaw) + local_y * math.cos(yaw)
    where = (origin + turned_x, turned_y, local_z)

    if shape == "box":
        bpy.ops.mesh.primitive_cube_add(size=1.0, location=where)
        scale = size
    elif shape == "cylinder":
        bpy.ops.mesh.primitive_cylinder_add(radius=1.0, depth=1.0, vertices=20,
                                            location=where)
        scale = size
    elif shape == "cone":
        bpy.ops.mesh.primitive_cone_add(radius1=1.0, radius2=0.0, depth=1.0,
                                        vertices=20, location=where)
        scale = size
    elif shape == "sphere":
        bpy.ops.mesh.primitive_uv_sphere_add(radius=1.0, segments=20, ring_count=10,
                                             location=where)
        scale = size
    else:
        raise SystemExit("unknown shape %r in models.py" % shape)

    obj = bpy.context.active_object
    obj.scale = scale
    rot = part.get("rot", (0.0, 0.0, 0.0))
    # Euler XYZ applies Z last, so adding the yaw there turns the finished
    # part in world space rather than shearing its own rotation.
    obj.rotation_euler = (math.radians(rot[0]), math.radians(rot[1]),
                          math.radians(rot[2] + MODEL_YAW))
    obj.data.materials.append(material)
    # Flat shading throughout: smooth normals on a 20-sided cylinder produce
    # a gradient that reads as blur once it is 6 pixels wide.
    for polygon in obj.data.polygons:
        polygon.use_smooth = False
    return obj


def measure(objects):
    """World-space extents of some objects, projected into the camera plane.

    The camera looks along (0, sin p, -cos p) with its up axis at
    (0, -cos p, sin p)... which is to say a world point's height on screen is
    `z * sin p - y * cos p`. Measuring that directly, rather than guessing
    from model dimensions, is what lets the fit check below be exact.
    """
    # matrix_world is evaluated lazily: reading it straight after setting
    # scale and rotation gives the previous transform, which silently makes
    # every measurement below wrong.
    bpy.context.view_layer.update()
    pitch = math.radians(CAMERA_PITCH)
    horizontal = []
    vertical = []
    for obj in objects:
        for corner in obj.bound_box:
            x, y, z = obj.matrix_world @ mathutils.Vector(corner)
            horizontal.append(x)
            vertical.append(z * math.sin(pitch) - y * math.cos(pitch))
    return min(horizontal), max(horizontal), min(vertical), max(vertical)


def build_scene(order, materials):
    """Lay every unit out along X, one per cell, and frame the whole strip."""
    per_unit = {}
    for index, unit_type in enumerate(order):
        origin = (index - (len(order) - 1) / 2.0) * CELL_TILES
        built = []
        for part in models.MODELS[unit_type]:
            obj = add_part(part, origin, materials[part.get("mat", "dark")])
            obj.name = "%s.%03d" % (unit_type, len(built))
            built.append(obj)
        per_unit[unit_type] = (origin, built)

    # A model wider than its cell would bleed into the neighbouring frame,
    # and the board would draw a slice of the wrong unit. Catch it here,
    # where the fix is a number in models.py, rather than on a phone.
    half = CELL_TILES / 2.0
    for unit_type, (origin, built) in per_unit.items():
        left, right, _, _ = measure(built)
        overhang = max(origin - left, right - origin)
        if overhang > half * MAX_FILL:
            raise SystemExit(
                "%s is %.3f tiles from its centre; a cell allows %.3f. Shrink it in "
                "models.py or raise CELL_PX." % (unit_type, overhang, half * MAX_FILL))

    everything = [obj for _, built in per_unit.values() for obj in built]
    _, _, bottom, top = measure(everything)
    window = CELL_TILES
    if top - bottom > window * MAX_FILL:
        raise SystemExit(
            "the tallest model spans %.3f tiles; a cell allows %.3f. Lower MODEL_SCALE "
            "or raise CELL_PX." % (top - bottom, window * MAX_FILL))

    camera_data = bpy.data.cameras.new("camera")
    camera_data.type = "ORTHO"
    # The strip is CELL_TILES wide per unit; orthographic_scale spans the
    # longer axis, so the shorter axis lands on exactly one cell of height.
    camera_data.ortho_scale = CELL_TILES * len(order)
    camera_data.clip_start = 0.1
    camera_data.clip_end = 200.0
    camera = bpy.data.objects.new("camera", camera_data)
    bpy.context.scene.collection.objects.link(camera)

    pitch = math.radians(CAMERA_PITCH)
    distance = 50.0
    # Aim at whatever height actually centres the models, so adding a taller
    # unit re-frames the sheet instead of clipping it.
    centre = (top + bottom) / 2.0
    focus_z = centre / math.sin(pitch)
    camera.location = (0.0, -distance * math.sin(pitch), focus_z + distance * math.cos(pitch))
    camera.rotation_euler = (pitch, 0.0, 0.0)
    bpy.context.scene.camera = camera
    print("framing: content %.3f of %.3f tiles tall, centred at z=%.3f"
          % (top - bottom, window, focus_z))


def add_lights():
    sun_data = bpy.data.lights.new("key", type="SUN")
    sun_data.energy = 3.2
    # A soft-edged sun would dither the shadow terminator, and dithering at
    # this size is just noise.
    sun_data.angle = 0.0
    sun = bpy.data.objects.new("key", sun_data)
    sun.rotation_euler = (math.radians(48.0), 0.0, math.radians(-38.0))
    bpy.context.scene.collection.objects.link(sun)

    world = bpy.data.worlds.new("world")
    world.use_nodes = True
    background = world.node_tree.nodes["Background"]
    # Fill, so the shadowed side of a unit stays a readable colour rather
    # than going black and merging with the dark parts.
    background.inputs["Color"].default_value = (0.42, 0.44, 0.50, 1.0)
    background.inputs["Strength"].default_value = 1.0
    bpy.context.scene.world = world


def configure_render(width, height):
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = SAMPLES
    scene.cycles.seed = SEED
    # Adaptive sampling decides per pixel when it has seen enough, and that
    # decision depends on how the tiles happened to be scheduled across
    # threads - so two runs of the same seed produced images that differed
    # in a handful of pixels. Fixing the sample count and the thread count
    # is what makes the sheet reproducible, which is what --check rests on.
    scene.cycles.use_adaptive_sampling = False
    scene.render.threads_mode = "FIXED"
    scene.render.threads = 1
    # This build has no denoiser, and a denoiser would not be wanted anyway:
    # it is a filter that varies with the build, which would break the
    # byte-comparison in --check.
    scene.cycles.use_denoising = False
    scene.render.resolution_x = width
    scene.render.resolution_y = height
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = True
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.image_settings.compression = 90
    # Straight (non-premultiplied) alpha, which is what Godot's importer
    # expects; premultiplied would darken every antialiased edge.
    scene.render.image_settings.color_depth = "8"


# Chunks worth keeping in a PNG we commit. Everything else Blender writes -
# the render date, how long it took, the scene name - is metadata about this
# particular run, and it is what stopped two identical renders from being
# identical files.
PNG_KEEP = {b"IHDR", b"PLTE", b"tRNS", b"IDAT", b"IEND"}


def strip_png_metadata(path):
    """Rewrite a PNG with only its image chunks.

    Cycles itself is deterministic here - two runs produce byte-identical
    pixel data - but Blender stamps each file with the time it was rendered,
    so the files differ even when the images do not. Dropping that is what
    lets `tools/render-sprites.sh --check` compare bytes, and it keeps a
    re-render out of the diff when nothing actually changed.
    """
    with open(path, "rb") as handle:
        data = handle.read()
    signature, offset = data[:8], 8
    kept = [signature]
    while offset < len(data):
        (length,) = struct.unpack(">I", data[offset:offset + 4])
        kind = data[offset + 4:offset + 8]
        end = offset + 12 + length
        if kind in PNG_KEEP:
            kept.append(data[offset:end])
        offset = end
    rebuilt = b"".join(kept)
    # Cheap proof the walk above stayed on chunk boundaries: a PNG that no
    # longer ends in IEND was mis-parsed, and writing it would corrupt the
    # sheet silently.
    if not rebuilt.endswith(b"IEND" + struct.pack(">I", zlib.crc32(b"IEND"))):
        raise SystemExit("refusing to write a malformed PNG for %s" % path)
    with open(path, "wb") as handle:
        handle.write(rebuilt)


def render_to(path):
    bpy.context.scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    strip_png_metadata(path)


def to_mask_materials(materials):
    """Repaint the scene for the mask pass, in place.

    Emission rather than diffuse, so the mask is exactly white or exactly
    black regardless of where the lights are - the point is coverage, not
    shading.
    """
    white = make_material("mask_team", None, emission=(1.0, 1.0, 1.0, 1.0))
    black = make_material("mask_other", None, emission=(0.0, 0.0, 0.0, 1.0))
    for obj in bpy.data.objects:
        if obj.type != "MESH":
            continue
        is_team = obj.data.materials and obj.data.materials[0].name == materials[TEAM_ROLE].name
        obj.data.materials.clear()
        obj.data.materials.append(white if is_team else black)
    bpy.context.scene.world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.0


def source_hash(order):
    digest = hashlib.sha256()
    here = os.path.dirname(os.path.abspath(__file__))
    for name in ("models.py", "render_sprites.py"):
        with open(os.path.join(here, name), "rb") as handle:
            digest.update(handle.read())
    digest.update(json.dumps({
        "order": order, "tile": TILE_PX, "cell": CELL_PX,
        "pitch": CAMERA_PITCH, "samples": SAMPLES, "seed": SEED,
    }, sort_keys=True).encode())
    return digest.hexdigest()


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    usage = "usage: blender -b -P render_sprites.py -- --out <directory> [--scale N]"
    if len(argv) not in (2, 4) or argv[0] != "--out":
        raise SystemExit(usage)
    out_dir = argv[1]
    # A magnified render of the same framing, for looking at the models. It
    # is not the shipped sheet: it writes preview.png only and leaves the
    # manifest alone, so it can never be mistaken for one.
    scale = 1
    if len(argv) == 4:
        if argv[2] != "--scale":
            raise SystemExit(usage)
        scale = int(argv[3])
        if scale < 1:
            raise SystemExit("--scale must be 1 or more")
    os.makedirs(out_dir, exist_ok=True)

    order = unit_order()
    clear_scene()
    materials = {role: make_material(role, colour) for role, colour in MATERIALS.items()}
    build_scene(order, materials)
    add_lights()
    configure_render(CELL_PX * len(order) * scale, CELL_PX * scale)

    if scale != 1:
        render_to(os.path.join(out_dir, "preview.png"))
        print("PREVIEW_OK %dx -> %s" % (scale, os.path.join(out_dir, "preview.png")))
        return

    render_to(os.path.join(out_dir, "units.png"))
    to_mask_materials(materials)
    render_to(os.path.join(out_dir, "units_mask.png"))

    manifest = {
        "_comment": "Generated by art/blender/render_sprites.py. Do not edit by hand;"
                    " run tools/render-sprites.sh.",
        "tile": TILE_PX,
        "cell": CELL_PX,
        "sheet": "units.png",
        "mask": "units_mask.png",
        "width": CELL_PX * len(order),
        "height": CELL_PX,
        "frames": {unit_type: index for index, unit_type in enumerate(order)},
        "source_sha256": source_hash(order),
    }
    with open(os.path.join(out_dir, "units.json"), "w") as handle:
        json.dump(manifest, handle, indent=2, sort_keys=True)
        handle.write("\n")
    print("SPRITES_OK %d units -> %s" % (len(order), out_dir))


main()
