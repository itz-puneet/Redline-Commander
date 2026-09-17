# Asset prompts

Ready-to-paste prompts for generating the art and audio this project still
needs, plus the constraints that decide whether the result is usable.

Companion documents: `docs/ART_SPEC.md` (the technical contract for art),
`docs/AUDIO_SPEC.md` (the same for sound), `art/png/README.md` (how a file
gets from here into the game).

## Read this first

**Audio is not a thing Gemini makes.** Gemini generates images and text; it
does not generate music or sound effects. Everything in the audio half of
this document is written as a brief you can hand to a generator that does
(Google's MusicFX / Lyria for music beds, ElevenLabs' sound-effects tool or
similar for one-shots), to a person, or use to pick from a library. Whatever
route you take, the licence has to allow shipping it in an app - see the
hard rule below. Do not paste the audio prompts into Gemini and expect
files back.

**Nothing may reference another game.** `CLAUDE.md` forbids art, music or
sound copied or closely paraphrased from any existing commercial title, and
a generator will happily imitate one if you name it. So never write "in the
style of <game>" or name a franchise, a studio, or a specific title in a
prompt. Every prompt below describes the *thing* instead - top-down, flat,
readable at small size - which is what you want anyway. A generated asset is
original work made for this project; an imitation of a named game carries
that game's look into the repository, which is the thing the rule exists to
stop.

**A 48x48 tile is very small, and generators do not draw at that size.**
Every image prompt here asks for a large square image, which you then
downscale. Expect to generate at 1024x1024 and end up with 48x48 - roughly
one pixel in the game for every 21 the model drew. Detail below about a
pencil's width vanishes, so the prompts ask for bold shapes and strong
value contrast rather than fine texture.

## The palette the existing art already uses

Match these or the new tiles will not sit beside the old ones. Measured off
the shipped tiles, not invented:

| what | RGB | hex |
|---|---|---|
| grass / plains | 146, 204, 39 | `#92CC27` |
| forest canopy | 46, 116, 44 | `#2E742C` |
| shallow water | 9, 170, 237 | `#09AAED` |
| deep water | 1, 92, 176 | `#015CB0` |
| road asphalt | 109, 111, 118 | `#6D6F76` |
| reef, as drawn today | 41, 125, 181 | `#297DB5` |

The reef row is there to show the defect rather than to match it: `#297DB5`
is a mid blue sitting in `#015CB0` deep water, which is why it reads as a
pale patch in the middle of a dark channel. The replacement should be built
on the deep-water blue.

Note the road in particular. `BoardTheme.TERRAIN_COLORS` in the client
lists road as a pale stone `#B9B2A3`, but that table is the flat-colour
*fallback* painter used when the sheet is missing - the shipped art is dark
asphalt. Generate to the art, not to the fallback, or the new base tile
will not match the 14 road variants already in the sheet.

Faction colours, for the owned-building variants:

| slot | colour | hex |
|---|---|---|
| 0 | neutral grey/white | — |
| 1 | red | `#D9443F` |
| 2 | blue | `#3F7FD9` |
| 3 | green | `#3FB96B` |
| 4 | amber | `#D9A93F` |

---

# Part 1 — Images

## What is actually missing

Units are done - all 17, in two colourways. Overlays, VFX and emblems are
cropped and finished; they need *wiring into the renderer*, which is code,
not art. So the art still wanted is exactly three jobs:

| job | files | why |
|---|---|---|
| Seamless terrain | 8 | today each type is one illustrated vignette, so a field of it repeats visibly |
| Reef on deep water | 1 | the reef is painted a mid blue and only ever sits in deep water, so it reads as a patch |
| Buildings on ground | 25 | every building sits on a dark card instead of the terrain around it |

### The rule that rejects a terrain tile

`build_terrain_sheet.py` refuses any terrain tile that is not **exactly
48x48 and fully opaque corner to corner**. A terrain tile sits edge to edge
against its neighbours, so a transparent pixel is a hole in the map. There
is no overhang margin and no faction mask - unlike units, a building is
painted outright per owner.

## Prompt 1 — the eight seamless terrain tiles

Run this once per terrain type, swapping the subject line. The tileability
instruction is the important half; generators are bad at it, so verify
afterwards (see **Making it actually tile** below).

```
Create a seamless, perfectly tileable top-down texture tile for a
2D strategy game map, viewed from directly overhead at 90 degrees.

SUBJECT: <subject line from the table below>

STYLE: flat, clean, bright cartoon vector art with crisp edges and
simple shapes. Bold, saturated colour with clear light-to-dark value
contrast. No outline border around the tile. No text, no labels, no
icons, no characters, no vehicles, no buildings. Even, flat lighting
with no directional shadow and no vignette - the tile must look the
same at every rotation of the map.

COMPOSITION: the pattern must be evenly distributed across the whole
square with no focal point, no single large feature, and nothing
centred. Imagine this square repeated 20 times in both directions:
no seam, no line, and no obvious repeating landmark should be
visible. Detail must stay small and even.

OUTPUT: a single square image, 1024x1024, filling the entire frame
edge to edge with no border, no padding, no drop shadow and no
transparent areas.
```

Subject lines:

| file | subject |
|---|---|
| `plains.png` | short bright green grassland `#92CC27`, with small sparse tufts of darker grass evenly scattered |
| `road.png` | a dark worn asphalt surface, mid-dark neutral grey `#6D6F76`, with fine gravel speckle and faint tyre wear |
| `forest.png` | a dense canopy of rounded treetops seen from above, mid and dark green around `#2E742C`, packed edge to edge |
| `mountain.png` | grey rocky ground with angular stone facets and scree, cool grey with lighter highlights |
| `river.png` | shallow flowing fresh water over a pale bed, light blue-green with soft current ripples |
| `shallow_water.png` | bright turquoise shallow sea `#09AAED` with gentle ripples and a hint of pale sand beneath |
| `deep_water.png` | deep blue open ocean `#015CB0` with small even wave texture, darker and flatter than shallow water |
| `reef.png` | dark blue open ocean, the same `#015CB0` as open sea, with jagged brown-grey coral heads breaking the surface |

Note the reef line: it is deliberately **deep** blue. The current reef tile
is a mid blue and reefs only ever sit in deep water by the map rules, so it
currently reads as a pale patch in a dark channel.

### Making it actually tile

Generators ignore "seamless" about half the time, and you cannot see it by
looking at one copy. `art/png/check_tile.py` answers it:

```bash
# Look at a generated image - any size, it downscales to compare
art/png/check_tile.py ~/Downloads/plains_attempt_1.png

# Happy with it? The same command writes the finished 48x48 tile
art/png/check_tile.py --write art/png/terrain ~/Downloads/plains_attempt_1.png
```

It reports three things: whether the file is square and fully opaque,
whether the wrap holds, and the tile's mean colour so you can compare it
against the palette above. It exits non-zero on a problem, so you can loop
it over a batch of generations.

The wrap test compares the difference between the tile's opposite edges
against how big a step that texture normally takes between neighbouring
lines. That comparison is the whole trick: a smooth gradient has wildly
different left and right edges, but so does every other pair of opposite
columns in it, so a naive check calls the least tileable image imaginable
seamless.

It also downscales through a 3x3 tiling of the source and crops the middle
back out, because resampling straight down clamps at the border rather than
wrapping - which puts a seam into art that tiled perfectly before it was
resized. Worth knowing if you do the downscale yourself in an image editor:
do it on a 3x3 tiling, not on the single tile.

**What the shipped tiles score today**, as a baseline to beat - the number
is the wrap difference against a steep in-tile step, so lower is better and
anything under about 1.25x passes:

| tile | left/right | top/bottom | verdict |
|---|---|---|---|
| `shallow_water` | 1.2 vs 2.5 | 2.1 vs 2.5 | **generated, wraps exactly** |
| `river` | 1.8 vs 5.3 | 2.1 vs 5.0 | **generated, wraps exactly** |
| `plains` | 4.1 vs 6.4 | 9.1 vs 19.8 | already wraps |
| `reef` | low | low | already wraps |
| `deep_water` | 8.3 vs 5.4 | ok | marginal |
| `road` | 36.3 vs 21.9 | 38.7 vs 20.1 | seams |
| `forest` | 50.4 vs 19.7 | 31.1 vs 18.7 | seams |
| `mountain` | 47.8 vs 36.3 | 47.1 vs 18.8 | seams |

`river` and `shallow_water` are done - they are not generated by an image
model at all but built by `art/png/make_water_tiles.py`, because water has
no landmark to draw, only a surface, and a surface is a sum of waves. Every
wave in it has an integer number of periods across the tile, so it is
exactly periodic rather than blended-to-fit, and there is no downscale step
to lose the wrap in. Read that script before generating the rest: the three
things it had to get right (cut the low frequencies, quantise to flat
bands, no isolated bright specks) are the three ways a tileable texture
still comes out looking wrong.

So `forest`, `mountain` and `road` are where the remaining work is, plus
`deep_water` if its marginal wrap bothers you. `reef` still wants redrawing
for its colour, not its edges.

A caveat worth knowing: this measures *edge discontinuity*, not
*repetitiveness*. A tile can wrap perfectly and still look wrong across a
field because it carries one recognisable feature that the eye picks out on
every repeat. That is why the prompt insists on even distribution with no
focal point - no tool will catch it for you.

## Prompt 2 — the 25 building tiles

Five building types, five owner variants each (`_0` neutral, `_1` to `_4`
per player slot). The thing being fixed: they are currently painted on a
dark background, so on the board each building sits on a dark card instead
of on the ground.

```
Create a single top-down building tile for a 2D strategy game map,
viewed from directly overhead at 90 degrees.

SUBJECT: <building line> The building occupies the centre of the
square and is surrounded by, and sitting on, <ground line>. The
ground must reach every edge of the image so the tile blends into
the map around it.

COLOUR: the building's main roof and walls are <owner colour>.
Keep the team colour on large flat surfaces, in a light-to-mid tone
- never near-black, or it will not read at small size.

STYLE: flat, clean, bright cartoon vector art, crisp edges, simple
bold shapes, readable as a silhouette when shrunk to a thumbnail.
Even flat lighting, no long directional shadow, no vignette, no
outline border around the tile.

OUTPUT: a single square image, 1024x1024, filling the entire frame
with no border, no padding, no transparency anywhere - including
the corners.
```

Building lines:

| file stem | subject | ground |
|---|---|---|
| `city_*` | a small cluster of flat-roofed low-rise buildings around a tiny courtyard | bright green grass, `#92CC27` |
| `factory_*` | a wide industrial shed with a sawtooth roof and two short chimneys | bright green grass, `#92CC27` |
| `airport_*` | a hangar with a curved roof beside a short strip of pale apron concrete | bright green grass, `#92CC27` |
| `port_*` | a small quay with a crane and a short jetty | grass on one side meeting turquoise shallow water `#09AAED` on the other |
| `hq_*` | one larger prominent headquarters building with a flag mast and a walled forecourt | bright green grass, `#92CC27` |

Owner colour lines:

| variant | owner colour |
|---|---|
| `_0` | neutral light grey and off-white, no team colour at all |
| `_1` | strong red `#D9443F` |
| `_2` | strong blue `#3F7FD9` |
| `_3` | strong green `#3FB96B` |
| `_4` | warm amber `#D9A93F` |

The neutral `_0` variant matters more than it looks: it is what an
uncaptured city looks like, and it must be clearly *not* any player's
colour at a glance.

## Getting a generated image into the game

```bash
# Drop the finished 48x48 files into art/png/terrain/, then:
art/png/build_terrain_sheet.py client/assets/terrain
cd client && godot --headless res://tests/board_check.tscn
```

The build refuses anything not exactly 48x48 and fully opaque, so a bad
export fails there rather than on a phone. One Godot trap to know about:
**replacing a committed PNG with one of a different size does not reliably
invalidate Godot's import cache.** If the board renders the old art after a
rebuild, delete `client/assets/terrain/terrain.png.import` and the matching
`.godot/imported/terrain.png-*.{ctex,md5}` pair, then re-import. This is
written up in full in `CLAUDE.md`.

To look at the result at real zoom, with no units or HUD in the way:

```bash
cd client && xvfb-run -a godot --resolution 1280x720 \
  res://tests/terrain_preview.tscn -- --map reach
```

---

# Part 2 — Audio

`docs/AUDIO_SPEC.md` is the full brief: every sound, what it is for, and -
critically - **how long the animator actually gives it**. Read the timing
section there before generating anything, because the budget is much
tighter than sound effects are normally made for. The short version:

| moment | budget |
|---|---|
| a unit moving, whole path | 180-810 ms |
| an entire attack | 220 ms |
| a unit being destroyed | 260 ms |
| a tile changing hands | 450 ms |

A sound longer than its budget is cut off mid-tail on a real board, every
time. Generate short and dry.

## Format

Short effects as 16-bit 44.1 kHz **mono WAV** - Vorbis has a decode delay
you can hear on a UI tap. Music and ambience as OGG Vorbis, stereo. Peak
-1 dBFS. Mix and judge on a phone speaker, not headphones: anything whose
identity lives below ~300 Hz has no identity on the target hardware.

## Prompt shape for one-shot effects

```
A single short sound effect for a turn-based strategy game, dry and
close, with no reverb tail, no music, and no speech.

SOUND: <description>
LENGTH: <budget> maximum.
CHARACTER: punchy and readable in isolation, mixed for a small phone
speaker - the identifying character of the sound must sit in the
mid-range rather than in deep bass.
```

The descriptions to drop in, grouped as `AUDIO_SPEC.md` groups them.
Author against these classes rather than per unit: seventeen units share
six movement voices and ten weapon families, because `units.json` already
groups them by `move_type` and `fire_mode`.

### Movement — 6, each 180-810 ms, gesture not loop

| id | description |
|---|---|
| `move_foot` | boots on ground with webbing and gear rattling over the top, a small squad walking, slightly irregular |
| `move_wheels` | a light fast engine under tyre noise on a hard surface, buzzy rather than throaty |
| `move_treads` | metal tank-track links clattering over a diesel engine, the clatter dominant |
| `move_rotor` | a helicopter main rotor wash with light blade slap and turbine whine underneath |
| `move_jet` | a jet turbine pass-by, rising then falling, peaking just past the middle |
| `move_ship` | a heavy hull pushing through water with propeller wash underneath |

### Footsteps by surface — 4 sets, 3 variations each

| id | description |
|---|---|
| `step_hard` | a single boot step on asphalt with a slight scuff |
| `step_soft` | a single boot step on grass and soil, dampened |
| `step_rock` | a single boot step on loose stone and grit, irregular |
| `step_water` | a single boot step wading through shallow water |

### Weapons — 10 families

| id | description |
|---|---|
| `fire_small_arms` | a short burst of three or four rifle shots, dry and close, not a single shot |
| `fire_at_rocket` | a shoulder-launched anti-tank rocket: a sharp back-blast crack then the motor departing |
| `fire_autocannon` | a short fast burst of light cannon fire, metallic and mechanical |
| `fire_aa` | a longer burst of anti-aircraft cannon fire with a slight rising tail, shaped as if firing upward |
| `fire_cannon` | a single tank gun firing: a hard crack with a very short tail, dry |
| `fire_naval_gun` | a naval gun firing, heavier and more open than a tank gun, slightly longer tail |
| `fire_naval_light` | a light naval autocannon burst, close to the autocannon but wetter and more open |
| `fire_bomb_release` | a mechanical bomb-release clunk followed by a brief descending whistle |
| `fire_howitzer` | a deep artillery howitzer firing, open report with a real tail |
| `fire_rocket_salvo` | four or five rockets leaving a launcher in quick ripple succession, hiss and roar rather than cracks |
| `fire_monitor_gun` | a very heavy naval rifle firing, slow, with a long low tail |

Indirect fire needs a **second** sound scheduled 250-400 ms later at the
target: `impact_shell`, a heavy high-explosive shell landing with debris.

### Impacts — 5

| id | description |
|---|---|
| `impact_armour` | a shell striking armour plate: the strike plus the structure behind it |
| `impact_infantry` | a softer duller impact with dirt and debris, no metal ring |
| `impact_air` | a metallic hit on an aircraft with airflow around it, thin and unstable |
| `impact_hull` | a metallic hit on a ship's hull with water disturbed around it |
| `impact_water` | a heavy splash of a shell landing in open water and nothing else |

### Destruction — 4, 260 ms

| id | description |
|---|---|
| `destroy_infantry` | a muffled blast with equipment scattering - restrained, no voices |
| `destroy_vehicle` | a vehicle cooking off: an initial blast then a secondary crumple of burning metal |
| `destroy_air` | an explosion followed by a short descending whine, cut off |
| `destroy_ship` | an explosion followed by water rushing in and closing over |

### Capture, production and money

| id | description |
|---|---|
| `capture_tick` | a mechanical ratchet turning one notch, as if winding toward a release |
| `capture_complete` | a satisfying latch closing and a flag running up, resolved and final, 450 ms |
| `build_factory` | a factory door rolling up and a vehicle engine starting, 600 ms |
| `build_airport` | a hangar door and a jet turbine spooling up, 600 ms |
| `build_port` | a dockside crane and a hull entering water, 600 ms |
| `funds_spent` | a short soft cash-register style confirmation, subtle, plays underneath another sound |

### Turn flow and match end

| id | description |
|---|---|
| `turn_yours` | a confident rising two-note fanfare, unmistakable, warm, 1.2 s |
| `turn_theirs` | a short flat falling two-note cue, informative and neutral, 0.6 s |
| `income` | a light bright ascending chime, plays underneath the turn cue |
| `player_defeated` | a single heavy final low note |
| `victory` | a short triumphant orchestral-electronic sting, 2-3 s |
| `defeat` | a short descending sombre sting, 2-3 s |

`turn_yours` is the single most important sound in the game: this is an
asynchronous game where someone opens the app hours later to find out
whether it is their move. It should be recognisable from another room.

### UI — all under 150 ms unless noted, dry

| id | description |
|---|---|
| `ui_select` | a soft short click with a little pitch to it - the most-played sound in the game, err quiet |
| `ui_deselect` | the same click, lower and shorter |
| `ui_move_confirm` | a positive definite click, more committed than select |
| `ui_attack_arm` | a tenser slightly metallic click |
| `ui_invalid` | a flat dull refusal, NOT a harsh buzz - it fires on ordinary mis-taps |
| `ui_rejected` | a more serious two-tone error cue, distinctly negative |
| `ui_menu_open` | a short rising sweep, 200 ms |
| `ui_menu_close` | the same sweep falling, 200 ms |
| `ui_end_turn` | a weighty switch being thrown |
| `ui_connect` | two short rising tones |
| `ui_disconnect` | two short falling tones, informative not alarming |
| `ui_notify` | a distinctive phone notification tone, 1.5 s - must work with the app closed |

### Music — 5 beds

For a music generator, not a sound-effects one. All original, all loopable
except the stings.

| id | prompt |
|---|---|
| `music_lobby` | Instrumental loop for a strategy game menu. Calm, anticipatory, unhurried. Restrained electronic pulse with warm synth pads and a simple bass line. No vocals, no strong melodic hook. Loops seamlessly. 60-90 seconds. |
| `music_match` | Instrumental background loop for a turn-based strategy game, playing while a player thinks for minutes at a time. Sparse, low, slow-moving, atmospheric. Subtle percussion, long pads, no strong hook and no obvious loop point. Must not become irritating on the twentieth repeat. No vocals. 2-3 minutes. |
| `music_tension` | The same sparse instrumental bed as a strategy game's main loop, but thinner, lower and more uneasy - for a losing position. Same tempo and key so it can cross-fade with the calmer version. No vocals. 2-3 minutes. |
| `music_victory` | A short triumphant instrumental fanfare for winning a strategy match. Bright, resolved, warm. No vocals. 8-12 seconds, does not loop. |
| `music_defeat` | A short sombre instrumental cue for losing a strategy match. Descending, quiet, resigned but not bleak. No vocals. 8-12 seconds, does not loop. |

**Faction themes are deliberately out of scope.** Five factions times a
theme is the same combinatorial trap that `CLAUDE.md` rule 8 exists to
prevent, for a payoff nobody asked for.

### Ambience — 2 beds

| id | prompt |
|---|---|
| `amb_land` | A quiet outdoor ambience loop: open grassland, gentle wind, distant birds, occasional insects. No music, no voices, nothing rhythmic or attention-catching. Loops seamlessly. 30-60 seconds. |
| `amb_naval` | A quiet coastal ambience loop: gentle surf, distant gulls, wind with water in it. No music, no voices. Loops seamlessly. 30-60 seconds. |

## Before any of it ships

None of the engine side exists yet - there is no `AudioManager`, no bus
layout, no `client/assets/audio/`. `docs/AUDIO_SPEC.md` specifies both
halves and argues the engine should land first, because a turn arrives as
one batch of events and six units moving will fire six copies of one sample
unless the manager imposes a voice limit and a small pitch offset. That is
the single most common way a competent sound set ends up sounding cheap,
and no amount of re-generating fixes it.

## Licensing, whatever the source

Record where every file came from - generator and prompt, or library and
licence - before it goes in the repository. A file with no provenance is
not shippable however good it sounds, and audio is far harder to spot in
review than a traced sprite.
