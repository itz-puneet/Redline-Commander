# Art brief — SVG assets

For whoever draws the art. `docs/ART_SPEC.md` is the technical contract and
the pipeline; this is what to actually draw and why.

Three existing files are worth opening before starting:
`art/svg/light_tank.svg`, `art/svg/infantry.svg` and
`art/svg/helicopter.svg`. They are hand-drawn and correct. The other
fourteen in that folder were machine-generated from placeholder geometry and
are **not** a style reference - they are there so the folder is not empty.

## Read this first

Five things that will get an asset rejected by the build, not by taste:

1. **Canvas is `viewBox="0 0 64 64"`, always.** The unit's body belongs
   inside the central 48x48. The outer 1px ring must be completely empty.
2. **Faction colour is a class, not a colour.** Anything that should take
   the player's colour gets `class="team"` (or `team-hi` / `team-lo`). The
   build re-renders the same file with those turned white to make a mask.
   A shape that is "red" but not classed will be red for both players.
3. **No embedded images, no `<text>`, no filters.** Gradients are fine.
   `<image>` defeats the point of vector; `<text>` depends on fonts the
   build machine may not have; filters are slow and rasterise unevenly.
4. **One light direction**, upper-left, across every asset.
5. **Silhouette before detail.** These are seen at 48 pixels on a phone.

## The technical envelope

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <style>
    .team-hi{fill:#cfcfd1}.team{fill:#bdbdbe}.team-lo{fill:#93939a}
    .dark{fill:#43454d}.dark-hi{fill:#55575f}
    .light{fill:#d2d4d9}.glass{fill:#5b8ab4}
    .edge{stroke:#2b2d33;stroke-width:0.7;stroke-linejoin:round}
  </style>
  <!-- shapes here -->
</svg>
```

| class | use | fill |
|---|---|---|
| `team-hi` | faction colour, lit top surface | `#cfcfd1` |
| `team` | faction colour, front face | `#bdbdbe` |
| `team-lo` | faction colour, shaded side | `#93939a` |
| `dark` | tracks, wheels, weapons, rotors | `#43454d` |
| `dark-hi` | lit top of a dark part | `#55575f` |
| `light` | highlights that must read against **every** faction colour | `#d2d4d9` |
| `glass` | canopies, windscreens, viewports | `#5b8ab4` |

Everything is drawn in neutral grey. The game paints the faction colour at
runtime by multiplying it through `team*` pixels, which is why `team` is
`#bdbdbe` exactly - that value comes out as the faction colour unchanged.
Do not substitute a colour you like better; it will shift every faction.

Add `class="edge"` alongside the fill class to get the outline:
`class="team-hi edge"`. The outline is doing more work than anything else at
this size - it is what stops a unit dissolving into grass or forest.

Deliver one `.svg` per asset, named exactly as listed below.

## Art direction

**Viewpoint.** A high three-quarter view, looking down from the south, with
each vehicle turned about 30 degrees to its left so you see its front and
one flank. Enough tilt that a turret still reads as a turret, not a disc.
Two consequences worth internalising:

- **Anything pointing away from the viewer disappears.** A gun barrel aimed
  "forward and up" foreshortens to a stub. Traverse barrels across the view
  instead - the artillery keeps its length that way, and that length is its
  whole silhouette.
- **A figure seen from above is mostly shoulders.** Foot units are drawn
  taller than scale on purpose. Every game in this genre cheats this.

**Light** from the upper left, and only three tones per material - lit top,
front, shaded side. Resist a fourth. Flat facets read at 48px; smooth
gradients turn to mush.

**Scale hierarchy.** These sit next to each other on a grid, so relative
size carries information. Roughly, by footprint:

```
infantry  <  recon  <  light tank  <  medium tank  <  heavy tank
scout plane  <  helicopter  <  fighter  <  bomber
patrol boat  <  escort  <  monitor  ~  transport ship
```

Cost is the honest guide - a 1600 unit should look like it costs twice a 700
one.

## The seventeen units

Each entry is: what it does, the one feature that must survive at 48px, and
what it must not be confused with.

### Foot

**`infantry.svg`** — 100. The cheapest unit; takes buildings.
Signature: a visible helmet, clear of the shoulders. The only unit with a
head. Small.
Not: the anti-tank infantry.

**`anti_tank_infantry.svg`** — 300. Foot unit that kills armour.
Signature: a launcher tube carried well clear of the body, angled across the
view so its length shows.
Not: plain infantry — the tube must be unmissable, not a detail.

### Wheels and treads

**`recon.svg`** — 400. Fast, sees far, dies to everything.
Signature: four exposed wheels and a windscreen. The clearest "not a tank"
on the board. Low and light.
Not: any tracked vehicle.

**`artillery.svg`** — 600. Indirect fire, range 2–3. Cannot defend itself.
Signature: one very long barrel, traversed hard across the hull. Longest
barrel in the game relative to its body.
Not: the tanks — the barrel must read as disproportionate.

**`light_tank.svg`** — 700. The baseline armour. *Already drawn.*
Signature: round turret, short barrel, visible tracks.

**`medium_tank.svg`** — 1100. Between light and heavy.
Signature: a turret turned off the hull's axis, and a stowage box on the
rear deck. Noticeably bigger than the light tank.
Not: "the light tank scaled up" — the angled turret is what separates them.

**`heavy_tank.svg`** — 1600. The most expensive ground unit.
Signature: wide, skirted tracks, a thick barrel, a commander's hatch.
Should look heavy and slab-sided. Biggest ground footprint.

**`rocket_artillery.svg`** — 1400. Indirect, range 3–5, dies to anything
that reaches it.
Signature: a boxy launcher pod raised off the back of a **wheeled** chassis.
The only rectangle standing on end.
Not: artillery — no barrel at all, and wheels not tracks.

**`anti_air.svg`** — 800. Kills aircraft, weak against armour.
Signature: twin barrels elevated almost vertically, plus a small radar
plate. The only ground unit whose weapons point at the sky.

### Air

Aircraft fly above the board, so draw them clear of the ground with their
shadow implied by height rather than a cast shadow. All four need
**hand-drawing** — the generated versions are wrong.

**`helicopter.svg`** — 900. *Already drawn.*
Signature: rotor blades, the widest thing on the board, overhanging the
tile. Skids visible underneath.

**`fighter_jet.svg`** — 2000. Attacks only other aircraft.
Signature: hard-swept delta wings and a pointed nose. Sleek.
Not: the bomber — wing shape is the only thing separating two aircraft from
above, so make the sweep extreme.

**`bomber.svg`** — 1900. Devastating on ground and sea, helpless against
aircraft.
Signature: **straight** wings, two engine pods, a fat fuselage. Big and slow
looking.
Not: the fighter. Straight wing versus swept wing is the whole distinction.

**`scout_plane.svg`** — 600. Sees a long way, carries no weapon.
Signature: a propeller disc at the nose, a high straight wing, and a small
body. Should look unarmed and flimsy. The smallest thing in the air.

### Sea

Ships sit low in the water. Their length is what separates them.

**`patrol_boat.svg`** — 500. Cheap, fast, loses to anything serious.
Signature: short open hull, one small gun forward. Visibly the smallest ship.

**`escort.svg`** — 1200. The only unit that answers aircraft at sea.
Signature: twin mounts elevated steeply — deliberately echoing the anti-air
— plus a superstructure and a radar mast. A player should read "that is the
anti-air one" without being told.

**`monitor.svg`** — 1500. Indirect fire from the water, range 2–4.
Signature: one large forward turret with two long barrels traversed across
the view, deliberately echoing the artillery. Same trick: shape says role.

**`transport_ship.svg`** — 500. Carries land units. No weapons.
Signature: a long flat empty deck and a bridge tower pushed right to the
stern. Should look like cargo space. No guns at all.

## Terrain — 33 tiles

Not started, and the bigger visual gap. The board is currently flat colour
rectangles, which is what makes it look unfinished.

**Hard constraints:** exactly 48x48, fully opaque, **no overhang** — unlike
units, terrain gets no margin — and every tile must sit seamlessly against
every other tile it can touch. Draw them as a set, not one at a time.

Fog of war is a separate dark overlay drawn on top, so do not build shadow
into the tiles.

| tile | defence | should feel |
|---|---|---|
| `plains` | 10 | Open, walkable, slightly textured. The default; must not compete for attention. |
| `road` | 0 | Fast and exposed. Reads as a surface, not a strip — it has to connect in all four directions. |
| `forest` | 30 | Cover. Canopy texture, darker, visibly "hides things". |
| `mountain` | 40 | The best cover and impassable to vehicles. Must look unclimbable at a glance. |
| `river` | 0 | Crossable on foot only. Must read differently from sea water. |
| `shallow_water` | 0 | Ships pass. Lighter, with a visible bed. |
| `deep_water` | 0 | Ships pass. Darkest water; the open channel. |
| `reef` | 20 | Slow going for ships and the only water with cover. Broken texture. |

The five capturable buildings each need **five variants**: neutral, then one
per player seat. Only the ownership marking changes between variants — the
building itself must be identical, or it will appear to jump when captured.
Faction colour here is **not** done by mask; draw a distinct roof or banner
colour per variant, and the build will tell you which.

| building | defence | should read as |
|---|---|---|
| `city` | 30 | Income. Several small rooftops. The most common building. |
| `factory` | 30 | Builds ground units. Industrial, big doors, chimney. |
| `airport` | 30 | Builds aircraft. Flat apron, hangar, markings. |
| `port` | 30 | Builds ships. A quay meeting water — must work against the water tiles. |
| `hq` | 40 | Losing it loses the match. The most important tile on the board: largest, most distinctive, unmistakable from across a zoomed-out map. |

## Other assets worth having

In rough order of value:

1. **App icon** — one 1024x1024 master. The build needs it at 432x432
   (Android adaptive foreground and background, safe zone the central
   288x288), 192x192 (legacy launcher) and 512x512 (store listing). Current
   icon is a placeholder.
2. **Faction emblems**, five of them, 64x64 — one per faction in
   `shared/data/factions.json`. Shown in the lobby and the top bar. These
   are the game's identity and there is nothing at all today.
3. **Selection and range motifs.** Movement and attack ranges are flat
   translucent colour over the tile. A drawn corner-bracket or hatch would
   read far better, especially over forest.
4. **A capture-progress mark** — currently a plain yellow bar.
5. **Explosion and muzzle-flash frames** — combat is a lunge and a fade
   today. Three or four 64x64 frames would carry it.

Nothing above blocks anything. The units and terrain do.

## Delivering

Drop unit `.svg` files into `art/svg/`, named exactly as above. To see them
on a sheet:

```bash
python3 art/svg/render_prototype.py /tmp/sheet
```

Be aware of where the pipeline actually stands, so nothing here is a
surprise:

- **`tools/render-sprites.sh` still renders from Blender**, not from SVG.
  The committed sheet the game loads comes from `art/blender/`. The SVG path
  is `render_prototype.py` above, and it produces the identical sheet, mask
  and manifest - it is simply not wired in yet. It gets promoted once the
  four aircraft are drawn, because switching while they are wrong would ship
  broken art.
- **There is no terrain pipeline at all yet.** Tiles are still generated at
  runtime from flat colours. When the tiles exist I will build the loader
  and the checks for them; nothing about the drawing brief above changes,
  but do not expect a command to run them through today.

Once the units are wired up, `sprite_check` refuses art that breaks the
envelope - a missing unit, a frame touching its border, a unit with no
faction-coloured pixels at all. That is meant to catch those before they
reach a phone, so a failure is information rather than a problem.
