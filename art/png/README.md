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

## Status

This ingest is built and verified: a full seventeen-unit set at 256x256 with
derived masks was run through it and passed `sprite_check` and
`sprite_preview` - including the check that the tint lands on exactly the
pixels the mask marks. What it has not yet had is real artwork.

`tools/render-sprites.sh` still calls Blender. It gets pointed here once
there is a full set of PNGs, since the committed sheet has to come from one
producer.
