# Art specification

What Redline Commander needs, in what format, at what size, and which checks
will reject it. Written for whoever makes the art - including future us - so
nothing has to be inferred from the renderer.

Companion documents: `art/README.md` (how the unit pipeline works),
`docs/ROADMAP.md` (what is left overall).

Everything here must be original. See the hard rule in `CLAUDE.md`: a mesh,
texture or sound from an asset library or another game carries its licence
into this repository.

## Recommendation for unit art: keep Blender, replace the models

The blockouts in `art/blender/models.py` should be replaced with properly
modelled low-poly units in `.blend` files that the render script opens - not
with hand-drawn sprites. The reasons, in order of weight:

**Combinations multiply, and rendering absorbs it.** Ten units is not the
unit of work; ten units times factions times states times facings is. Today
factions are free - one neutral render plus a mask covers all four seats. A
firing frame, a damaged variant or four facings is a keyframe and a
re-render, not forty more drawings. Hand-drawn, every cell of that grid is
somebody's afternoon.

**Consistency is automatic.** Camera angle, lighting, scale and palette are
one setting shared by every unit. Hand-drawn sets drift, and drift is
brutally visible on a grid where ten units sit side by side.

**The checks only work because the art is generated.**
`tools/render-sprites.sh --check` proves the committed sheet still matches
its source. Drawn art has no source to compare against, so that check would
have to be deleted rather than adapted.

**The size is the hard part, and modelling is the easier route through it.**
Drawing a readable, distinctive 48px sprite is a genuine specialist skill.
Building a low-poly vehicle whose silhouette reads is a smaller ask.

### The honest counter-argument

Hand-drawn pixel art at this size, by someone who can do it, will look
better than a downscaled 3D render. The best-looking games in this genre are
drawn, not rendered, and small 3D renders tend to read soft and generic. If
that look matters more than the throughput above, take it - but take it as a
deliberate replacement of the pipeline, not as touch-ups on top of renders.
A hand-corrected render is the worst of both: no longer reproducible, so
`--check` has to go, and still not drawn.

### There is a working SVG prototype, and it changes this recommendation

`art/svg/` holds the same three units - infantry, light tank, helicopter -
drawn as SVG and rasterised by `art/svg/render_prototype.py`, which emits
the identical sheet, mask and manifest. Nothing in `client/` points at it.
It exists to show that everything downstream of the sheet is
producer-agnostic: the mask, the manifest, the tint shader, `sprite_check`
and `sprite_preview` do not know what drew the pixels.

Measured, not assumed:

| | Blender | SVG |
|---|---|---|
| Render, whole sheet | ~7 s | **~91 ms** |
| Byte-reproducible | no - one pixel in five runs | **yes, 6/6 identical** |
| Sheet bytes per unit | 3.3 KB | **1.7 KB** |
| Source bytes per unit | ~0.9 KB | ~1.3 KB |
| Dependency | Blender (~600 MB) | `rsvg-convert` (~2 MB) |

Two of those matter more than they look. Byte reproducibility means
`--check` becomes a plain comparison and `tools/compare_sheets.py` - which
exists only to tolerate Cycles' floating-point noise - can be deleted. And
the mask stops being a second render with every material swapped: it is the
same file with one stylesheet appended, so the two passes cannot drift.

What the prototype actually showed, though, is about drawing rather than
tooling. The SVG units read far better at 48px, and the reason is the
outline. Against grass or forest the Blender renders lose their edges and
soften into the terrain; a 0.7px dark stroke separates them completely. That
is a property of the drawing, not of vectors - the Blender path could have
outlines too - but in SVG it costs one CSS rule.

The cost is real and unchanged: the three-quarter angle and the shading are
hand-authored per unit rather than falling out of geometry. The prototype
sidestepped that by projecting its coordinates through the same camera as
the Blender renders, which is an honest way to compare media but not how an
artist would work.

### If you keep Blender, do this first

The current renders are plainly lit diffuse surfaces, which is most of why
they read generic. Before modelling in earnest, move the render toward a
stylised look: flat or toon shading, higher contrast between a unit's top
and side faces, and above all **an outline pass** (Freestyle, or an
inverted-hull outline). Outlines are what make small 3D read as a sprite,
and they cost one render setting rather than ten models.

## Unit sprites

### Files

| Path | Format | Size |
|---|---|---|
| `client/assets/units/units.png` | PNG, RGBA8, straight (non-premultiplied) alpha | **1088 x 64** |
| `client/assets/units/units_mask.png` | PNG, RGBA8 | **1088 x 64** |
| `client/assets/units/units.json` | JSON manifest | - |

All three are generated. Never edit them by hand.

### Geometry

- **Cell: 64 x 64 px.** One per unit type, laid out left to right in the
  order `shared/data/units.json` declares them.
- **Tile: 48 x 48 px.** The cell is centred on the tile, so the extra 8px on
  each side is overhang room for a rotor or a gun barrel.
- Sheet width is `64 x <number of unit types>`. Seventeen types today, so
  1088. It grows whenever a unit is added, which is why nothing hardcodes it.
- A unit's footprint should sit inside the central 48 x 48; only silhouette
  extras may overhang into the rest of the cell.
- **The outermost 1px ring of every cell must be fully transparent.** A
  frame that touches its border shows a slice of its neighbour on the board.

### The mask

The base sheet is rendered with faction-coloured parts in neutral grey; the
mask says which pixels those are, and the client tints through it
(`client/shaders/team_tint.gdshader`).

- Faction pixels: white - red channel > 0.5 **and** alpha > 0.5.
- Everything else: black.
- The mask must not mark a pixel that is transparent in the base sheet.
- **The neutral grey is 0.74** (`MATERIALS["team"]` in
  `art/blender/render_sprites.py`, `TEAM_GREY` in the shader). The shader
  divides by it, so changing one without the other shifts every faction
  colour. They are two constants that must agree.

Every unit type needs some faction-coloured area. A unit with an all-black
mask renders identically for both players, and ownership - the single most
important thing on the board - becomes unreadable.

### What the checks enforce

`client/tests/sprite_check.gd`, headless:

- every unit type in `shared/data/units.json` has a frame
- the sheet's `tile` matches `BoardTheme.TILE_SIZE`
- cell >= tile, the sheet is one row, its width matches the frame count
- every frame has drawn pixels, and faction-coloured pixels
- the mask marks nothing outside a unit
- no frame touches its cell border
- a `Unit` of every type draws a sprite rather than the placeholder block

`client/tests/sprite_preview.gd`, needs a display (`xvfb-run`):

- the tint applies, and applies to exactly the pixels the mask marks

`tools/render-sprites.sh --check`:

- the committed sheet still matches `art/blender/`

### Silhouette

A player identifies a unit by its outline, at 48px, on a phone, over
cluttered terrain, in about a quarter of a second. That is the design
constraint - not detail.

Each current model exaggerates one feature no other unit has: the
artillery's barrel is traversed hard across the view (pointed away from a
top-down camera it foreshortens to a stub), the helicopter's rotor is the
widest thing on the board, the anti-air is the only unit whose weapons point
at the sky, and foot units are drawn taller than scale because a figure seen
from above is mostly shoulders.

Keep that. A more detailed model that reads as the same grey lump as its
neighbour is a worse sprite than a blockout that does not.

## Terrain

**Not yet started, and deliberately not planned for Blender.** Tiles have to
sit seamlessly against their neighbours, which is far easier to author
directly than to render.

Today `client/scripts/board/terrain_tileset.gd` generates the atlas at
runtime from flat colours in `BoardTheme`. Replacing it means pointing the
atlas source at a real texture and keeping the same coordinate mapping.

### Drop-in replacement

One PNG, RGBA8, **1584 x 48** - 33 tiles of 48 x 48 in a single row, in
exactly this order:

```
 0 plains        1 road          2 forest        3 mountain
 4 river         5 shallow_water 6 deep_water    7 reef
 8-12  city:     neutral, seat 1, seat 2, seat 3, seat 4
13-17  factory:  neutral, seat 1, seat 2, seat 3, seat 4
18-22  airport:  neutral, seat 1, seat 2, seat 3, seat 4
23-27  port:     neutral, seat 1, seat 2, seat 3, seat 4
28-32  hq:       neutral, seat 1, seat 2, seat 3, seat 4
```

Non-capturable terrain gets one tile; capturable terrain gets one per seat
in `BoardTheme.SLOT_COLORS`, plus neutral. Add a terrain type to
`shared/data/terrain.json` and the count changes - the order is
`terrain.json`'s key order, so it is not stable against an insertion.

Constraints:

- **Exactly 48 x 48 per tile, no overhang.** TileMap cells are hard-bounded;
  unlike units, terrain gets no margin.
- Tiles must be seamless against every neighbour they can touch.
- Full opacity. Fog is a separate overlay drawn on top.

### Recommended before authoring any of it

Give terrain the same manifest treatment units got, so the tile order is
declared in a generated JSON file rather than being an implicit contract
between a JSON key order and an artist's file. As written, inserting a
terrain type into the middle of `terrain.json` silently reassigns every tile
after it.

## Icons and store assets

| Purpose | Format | Size |
|---|---|---|
| Master source | SVG, or PNG | 1024 x 1024 |
| Android adaptive foreground | PNG, RGBA | **432 x 432** (safe zone: centre 288 x 288) |
| Android adaptive background | PNG, RGBA | **432 x 432** |
| Android legacy launcher | PNG, RGBA | **192 x 192** |
| Play Store listing icon | PNG, 32-bit | **512 x 512** |
| Play feature graphic | PNG or JPG | **1024 x 500** |
| Screenshots | PNG or JPG | >= 1080 x 1920, 2 to 8 of them |

`client/icon.svg` is a 128 x 128 placeholder. The three Android icons are
set on the export preset, not in `project.godot`;
`client/export_presets.cfg` does not exist yet and is gitignored, so the
Android build configuration is still to be created.

## Audio

Nothing exists - there is no `AudioStreamPlayer` anywhere in the client.

| Purpose | Format | Notes |
|---|---|---|
| Music | `.ogg` (Vorbis) | 44.1 kHz stereo; loops cleanly |
| Effects | `.wav`, 16-bit PCM | 44.1 kHz mono; no decode latency on a one-shot |

Godot 4 imports both directly. Keep effects short enough that two can
overlap without muddying - a turn produces several at once.

## Maps

Not art, but content, and the same bottleneck. Two maps exist:
`crossing` (15 x 10, land only) and `straits` (18 x 12, naval). The roadmap
asks for three to five.

`server/test/data.test.ts` walks every map in the index and refuses one that
is not playable - an HQ no foot unit can reach, a start unit standing on
terrain it cannot enter, or a player without an HQ. It also fails if any
unit type is buildable on no map at all, which is the state the transport
ship sat in for months.

A map is a JSON file in `shared/data/maps/` plus an entry in
`shared/data/maps/index.json`. The index is explicit rather than a directory
scan because Godot cannot reliably list `res://` from an exported PCK; a map
not listed there is invisible in a real Android build.

After editing anything under `shared/data/`, run `tools/sync-shared-data.sh`.
