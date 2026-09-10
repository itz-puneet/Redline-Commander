# art/png/

Ingest for hand-made or generated PNG artwork. If you already have good
PNGs, **this is the path to use** - do not trace them to SVG first.

## Why not convert to SVG

The pipeline never required SVG. What it requires is a sprite sheet, a
faction mask and a manifest, and PNG artwork produces those directly, with
no conversion step to lose quality in.

Auto-tracing shaded artwork is a downgrade, not a format change: a tracer
turns soft edges and gradients into thousands of flat polygons, so the file
gets larger, the drawing gets blobbier, and the result is rasterised back to
64 pixels anyway. Tracing earns its place only for flat-colour, hard-edged
art you intend to keep editing as vectors - and even then you would redraw
rather than trace.

SVG was worth recommending when there was no art. Now that there is, the
argument is over.

## Using it

One PNG per unit type, named for the unit, in `art/png/units/`:

```
art/png/units/heavy_tank.png
art/png/units/escort.png
```

Any square size - 256, 512, 1024. The build downsamples to the 64px cell
with the alpha premultiplied first, which is what keeps a transparent
background from bleeding a dark fringe into every antialiased edge.

```bash
art/png/build_sheet.py /tmp/sheet                     # a mask file per unit
art/png/build_sheet.py /tmp/sheet --diff-suffix red   # or a second colourway
```

It prints a warning naming any unit that has no faction mask, any unit whose
artwork touches the cell border, and any unit type with no artwork yet.

## The faction mask

The game renders **one** neutral sheet and tints it per player, so it has to
be told which pixels belong to the faction. Two ways:

**A mask file** - `heavy_tank_mask.png` beside `heavy_tank.png`, faction
areas white, everything else black or transparent. Any art tool exports this
by toggling a layer. This is the reliable one.

**A second colourway** - if the set is already drawn in more than one player
colour, pass `--diff-suffix red` and put `heavy_tank_red.png` beside
`heavy_tank.png`. The mask is wherever the two differ. Make the plain file
the neutral or grey version, since that is the one that gets tinted.

Do not ship a sheet per faction. One sheet plus a mask is what makes a
third or fourth player a colour rather than another seventeen drawings, and
`CLAUDE.md` rule 8 is about keeping it that way.

## What the artwork has to satisfy

Fully specified in `docs/ART_SPEC.md`; the two that get caught most:

- **The outer ring of the 64x64 cell must be empty.** The body of the unit
  belongs inside the central 48x48; the margin is overhang room for a rotor
  or a barrel. Artwork touching the border shows a slice of itself in the
  neighbouring frame.
- **Every unit needs some faction-coloured area.** A unit with an empty mask
  renders identically for both players, and ownership is the most important
  thing on the board.

`sprite_check` enforces both, so a mistake fails a test rather than reaching
a phone.

## Terrain and buildings

A second, sibling script - `build_terrain_sheet.py` - builds the tile atlas
`client/scripts/board/terrain_tileset.gd` loads. It works the same way in
spirit but not in detail, because terrain isn't drawn like a unit:

- **No mask, no tint.** Buildings need a real colour per owner, not one
  tinted at runtime, so `art/png/terrain/city_0.png` .. `city_4.png` (owner
  slots 0-4, neutral first) are five actual paintings, not one plus a mask.
- **No overhang margin.** A unit's cell is bigger than its tile on purpose;
  a terrain tile is not - it sits edge to edge against its neighbours, so
  the build refuses anything that is not fully opaque corner to corner. A
  transparent pixel there is a hole in the map, not a stray fringe.
- **Exactly 48x48**, matching `BoardTheme.TILE_SIZE` - checked by
  `TerrainTileSet` itself at load time, which falls back to its old flat-
  colour painter rather than stretch a mismatched sheet. `board_check`
  verifies the real sheet is what actually gets used, not just that the
  fallback also works.

```bash
art/png/build_terrain_sheet.py /tmp/terrain
```

**The reference art was not drawn to tile.** Each terrain type in the
source sheet is one illustrated vignette - a single river crossing at one
angle, one cluster of trees, one mountain silhouette - not a texture meant
to repeat. Placed on a real map, where the same terrain type sits beside
itself many times, that shows: a river running through three tiles is the
same diagonal segment repeated three times, not a continuous river, and the
seam between tiles is visible on close inspection. It is still a large
improvement over a flat colour rectangle, and is what ships today, but true
seamless tiling - edges authored to match their neighbours - is separate,
harder art work this set does not attempt.

## Neighbour-aware variants (roads and shorelines)

A road and a shoreline cannot be drawn from the tile alone - a road has to
know which sides continue, and a beach has to know which side the land is
on. `TerrainTileSet` therefore asks the sheet for a *specific* tile first
and falls back to the plain one, so the sheet can carry as many or as few
as exist:

```
road_NS.png            -> the key road:0@NS
shallow_water_NE.png   -> the key shallow_water:0@NE
```

The suffix is the set of connected sides in **N, E, S, W** order. For a
road a side counts when it continues the network - another road, or a
building, or the edge of the map. For shallow water a side counts when it
is **land**, which is what decides which edge carries sand; reef and deep
water are sea, and so is anything beyond the map edge.

**None of these files exist yet, and that is the whole of what is missing.**
Until they do, every lookup falls back to `road.png` and
`shallow_water.png`, which is what ships today: one diagonal highway strip
repeated at every junction, and an open-water tile with no beach on any
edge. `board_check` prints the list of variants the shipped maps ask for
and cannot get.

What the two shipped maps need, exactly:

| | files | which |
|---|---|---|
| roads | 14 | `road_{N,E,S,W,NE,NS,NW,ES,SW,NES,NEW,NSW,ESW,NESW}.png` |
| shorelines | 6 | `shallow_water_{N,S,NE,NW,ES,SW}.png` |

Both sets are rotations of far fewer drawings - the 14 roads are an end, a
straight, a corner, a tee and a crossroads (5 sprites) turned four ways;
the 6 shores are a straight coast and an inside corner (2 sprites). Nothing
generates those rotations yet, so today it is 20 files. `road_0.png`
(a one-tile road) and `road_EW.png` (an east-west straight) are the two
neighbourhoods no shipped map produces, and are not needed.

Two existing tiles are also wrong for where they are used, and no amount of
neighbour logic fixes either:

- **`road.png` is a diagonal.** A two-lane highway running corner to
  corner cannot be part of an orthogonal network at any orientation, so it
  is not usable as the fallback *or* as the base for the 14 above. The
  variants have to be drawn as orthogonal road, meeting their neighbours at
  the middle of each tile edge.
- **`reef.png` is painted on shallow water.** Reefs sit in deep water by
  the map rules (`server/test/data.test.ts` enforces it), so the tile reads
  as a pale patch in the middle of the dark channel. It needs a deep-water
  background.
- **Every building tile is painted on opaque black** (`city_*.png`,
  `hq_*.png`, `factory_*.png`, `airport_*.png`, `port_*.png`). On the board
  that is a black card under each building instead of ground. They want the
  surrounding terrain's tone, not black.

## Overlays, effects and emblems

`art/png/overlays/`, `art/png/vfx/` and `art/png/emblems/` hold the
selection bracket, move/attack range icons, the capture-progress bar,
explosion and muzzle-flash frames, and the four faction emblem shapes, cut
from the same reference sheet as the units and terrain. These are cropped
and finished to size but **not wired into anything yet** - the board still
draws range overlays as flat translucent colour
(`client/scripts/board/tile_overlay.gd`), the capture bar as a drawn rect
(`Unit._draw()`), and combat as a procedural flash and fade
(`client/scripts/board/event_animator.gd`), because each of those is a
different subsystem and deserves its own pass rather than four rushed ones
in the same sitting as the terrain work.

## Status

Units, terrain and buildings are real artwork today, ingested through this
directory and verified by `sprite_check`, `sprite_preview` and `board_check`
(including a check that the committed terrain sheet is what actually loads,
not a silent fallback). `tools/render-sprites.sh` still exists but is no
longer what produces `client/assets/units/` - see `CLAUDE.md` rule 8.

Not yet real: the overlays/VFX/emblems above (cropped, not wired), and
anything not in the original reference sheet - a second map's terrain,
additional buildings, and further units beyond the original seventeen.
