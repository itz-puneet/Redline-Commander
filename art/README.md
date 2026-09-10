# art/

Source for the generated art. Nothing in here ships; it produces the files
in `client/assets/`, which do.

## Unit sprites

`blender/models.py` describes every unit as a list of primitives - boxes,
cylinders, cones, spheres - with a position, a size, a rotation and a
material role. `blender/render_sprites.py` builds those into a Blender scene
and renders two images:

- `client/assets/units/units.png` - the units, lit and shaded, with
  faction-coloured parts left neutral grey
- `client/assets/units/units_mask.png` - white where the faction colour
  goes, black everywhere else
- `client/assets/units/units.json` - which frame belongs to which unit type

The client tints one sheet per faction through the mask
(`client/shaders/team_tint.gdshader`), so a third or fourth faction costs a
colour rather than another ten renders.

```bash
tools/render-sprites.sh             # render into client/assets/units
tools/render-sprites.sh --check     # fail if the committed sheet is stale
tools/render-sprites.sh --preview   # a magnified look, into .preview/
```

The renderer needs Blender on the PATH (4.0 or later). The sheet is
committed, so this is only needed when a model or a render setting changes -
you can build and play the game without Blender installed.

## Why it is written down rather than modelled

These are blockouts, not finished art. They exist so the whole path - render,
mask, manifest, tint, the checks that hold it together - is proven before
anyone spends time modelling, and so replacing one model does not mean
rebuilding the pipeline around it.

Keeping the source as text rather than as `.blend` files means a change to a
unit is a readable diff, and `--check` can prove the committed images still
match it. When these are replaced with real modelling work, the natural step
is to save `.blend` files beside `models.py` and have the render script open
those instead; the two passes, the manifest and every check downstream stay
as they are.

## The one rule that matters here

Everything in this directory must be original. Blender is a tool, and its
output is yours - but a mesh from an asset library, a marketplace or another
game carries its licence into the sprite sheet and from there into the
repository. Do not import models, and do not reproduce a vehicle from
another game. See the hard rule in `CLAUDE.md`.

## Silhouette

A player identifies a unit by its outline in about a quarter of a second, at
48 pixels, on a phone, over cluttered terrain. That constraint, not detail,
is what these models are shaped around: the artillery's barrel is traversed
across the view because a barrel pointing away foreshortens to a stub, the
helicopter's rotor is the widest thing on the board, the anti-air is the only
unit whose weapons point at the sky, and foot units are drawn taller than
scale because a figure seen from above is mostly shoulders.

Keep that when replacing them. A more detailed model that reads as the same
grey lump as its neighbour is a worse sprite.
