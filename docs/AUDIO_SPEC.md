# Audio specification

What Redline Commander needs to hear, how long each sound gets, in what
format, and what will get one rejected. Written for whoever makes the audio
- including future us - so nothing has to be inferred from the renderer.

Companion documents: `docs/ART_SPEC.md` (the same contract for pictures),
`docs/GAME_DESIGN.md` (what the units and terrain actually are),
`docs/ROADMAP.md` (Phase 5, where this sits).

Everything here must be original or properly licensed, with the provenance
written down. See the hard rule in `CLAUDE.md`: a sound effect from another
game or an unlicensed sample pack carries its licence into this repository
exactly as a traced sprite does, and it is far harder to spot in review. A
`.wav` with no recorded origin is not shippable, however good it sounds.

## Nothing exists yet

There is no `AudioStreamPlayer` anywhere in `client/`, no bus layout, no
autoload, no `assets/audio/`. This document specifies both halves - the
engine and the assets - and the engine half should land first, because the
timing constraints below are not negotiable by the composer and will
reshape what is worth recording.

## The organising principle: classes, not units

Do not author seventeen unit sound sets. `shared/data/units.json` already
groups every unit by `move_type` and `fire_mode`, and those groups are what
a listener actually distinguishes - nobody hears a light tank and a medium
tank as different vehicles, they hear one tank heavier than the other.

Author against the classes and pitch-shift within them. A new unit then
costs a table row, not a recording session. This is the same argument as
rule 8 in `CLAUDE.md`: one sheet plus a mask rather than one sheet per
faction.

| `move_type` | units | count |
|---|---|---|
| `foot` | infantry, anti_tank_infantry | 2 |
| `wheels` | recon, rocket_artillery | 2 |
| `treads` | artillery, light_tank, medium_tank, heavy_tank, anti_air | 5 |
| `air` | helicopter, fighter_jet, bomber, scout_plane | 4 |
| `sea` | transport_ship, patrol_boat, escort, monitor | 4 |

`air` is the one class that must split in two: a helicopter and a jet share
nothing acoustically. Six movement voices, not five.

## Read this first: the animations are extremely short

This is the single most important fact in this document, and it is easy to
miss until sixty seconds of recorded material has been thrown away.

`client/scripts/board/event_animator.gd` sets the entire budget:

| constant | value | what it bounds |
|---|---|---|
| `MOVE_SECONDS_PER_TILE` | 0.09 | a move, per tile of path |
| `MOVE_MINIMUM` | 0.14 | the floor for a one-tile move |
| `LUNGE_SECONDS` | 0.11 | an attacker's lean in, and again back out |
| `DESTROY_SECONDS` | 0.26 | a unit fading and shrinking to nothing |
| `CAPTURE_FLASH_SECONDS` | 0.45 | the tile flashing to its new owner |
| `DAMAGE_FLOAT_SECONDS` | 0.75 | the damage number rising and fading |

So the **longest movement in the game** - a fighter jet or scout plane
crossing its full nine tiles - is 810 ms. The shortest is 180 ms. An entire
attack, lunge out and back, is 220 ms. A destruction is 260 ms.

Three consequences, all of which contradict how vehicle audio is normally
made:

**Movement is not a loop with a tail.** There is no room for a start
transient, a sustain and a stop. Author each movement voice as a single
180-810 ms gesture that can be time-stretched or truncated at a zero
crossing, and make it read from its first 100 ms - on a three-tile infantry
move (270 ms) that first 100 ms is over a third of everything the player
hears.

**A weapon and its impact overlap.** At range 1 the lunge is 220 ms, so a
tank cannon's report has not decayed before the shell lands. Author the
report short and dry and let the impact carry the weight, rather than two
full-length sounds fighting in a quarter of a second.

**Indirect fire is the exception, and needs the engine's help.** Artillery
(range 2-3), rocket_artillery (3-5) and monitor (2-4) shoot at targets that
may be off-screen, and `unitAttacked` carries no flight time. A launch and
an impact separated by 250-400 ms is the effect worth having, and the
audio manager has to schedule the second one itself - the animator will not
do it.

If any of these feel too tight, the fix is to raise the constants above and
re-verify `animation_check`, **not** to author longer sounds and let them be
cut off. Changing them is a deliberate pacing decision about the whole game,
so make it as one - not per sound, and not silently.

## The technical envelope

| | short SFX | music and ambience |
|---|---|---|
| format | 16-bit PCM WAV | OGG Vorbis, q5 |
| sample rate | 44.1 kHz | 44.1 kHz |
| channels | **mono** | stereo |
| loop | none | loop points set at import |
| peak | -1 dBFS | -1 dBFS |

**WAV for anything triggered by a tap or an event.** Godot decodes Vorbis on
play, and the delay is audible on a UI tap - the sound arrives after the
finger has left the screen, which reads as lag in the game rather than in
the audio. Vorbis is correct for the long beds, where a few milliseconds at
the start of a two-minute loop is nothing.

**Mono for SFX, and this is not a size optimisation.** The board pans and
zooms; a sound authored in stereo has a width that fights whatever position
the listener is at. Position comes from the engine, or it does not come at
all. Phone speakers are near enough mono anyway, and a stereo effect that
collapses badly to mono is worse than one that never had width.

**Loudness:** mix so the game sits around -16 LUFS integrated with music
and ambience roughly 12 dB under the effects. Check everything on a phone
speaker, not headphones. A sound designed on monitors and judged on its low
end will be inaudible on the hardware this ships to - there is no low end on
a phone speaker, and anything relying on it is a gap, not a rumble.

**Budget:** 8 MB for the whole audio set in the APK. That is generous for
~65 short mono WAVs (roughly 2 MB) plus five Vorbis beds, and it is a
ceiling worth keeping because the alternative is an install size that costs
downloads.

## The engine side

None of this exists. It should be built before the assets, because the
catalogue below assumes it.

**An `AudioManager` autoload**, beside the four in `client/project.godot`
(`GameData`, `PlayerIdentity`, `Session`, `Net`), owning a pool of
`AudioStreamPlayer` nodes and a
`play(id)` API keyed by the sound ids in the catalogue. Not a player per
caller: a pool with a **voice limit per sound id**, because of the next
point.

**A turn arrives as a batch.** `EventAnimator.plan()` turns one
`action_confirmed` into a queue of steps, so a six-unit turn can fire six
movement sounds and four explosions in sequence, several of them the same
sample. Without a voice limit and a small random pitch offset (±2 semitones
is plenty) that becomes a machine-gun of identical clips, which is the
single most common way a competent sound set ends up sounding cheap. Build
both into the manager, not into the assets.

**Three buses** - `sfx`, `music`, `ui` - with independent volume, so the
settings screen is a slider per bus rather than a rewrite. There is no
`default_bus_layout.tres` in `client/` today; adding one is the first
commit. Respect the
device's silent switch and duck under a system notification.

**The audio follows the animation, not the event.** Rule 6 in `CLAUDE.md`
says the adopted state is the truth and animation is decoration. Audio is
decoration on decoration: it hangs off `_play_step()`, and a step for a unit
hidden by fog has no node and must make no sound. A sound for something the
player cannot see is a fog leak through the speaker.

---

# The catalogue

Durations are maxima, set by the animator constants above. Where a count of
variations is given, that many separate files are wanted; see **Variation**
at the end for which sounds need them and why.

## 1. Movement — 6 voices

Triggered by `unitMoved`, one per moving unit, stretched or truncated to
the path length (180-810 ms).

**`move_foot`** — boots on ground with a gear rattle over the top: webbing,
a canteen, a rifle sling. Human-scale and slightly ragged, because these
are the two units that capture and the player should feel them as people
rather than counters. No music-box tidiness; a little asymmetry in the step
timing is what makes it read as a squad rather than a metronome.

**`move_wheels`** — a light engine under tyre noise on a hard surface, the
engine note fast and buzzy rather than throaty. This class is recon and
rocket_artillery: fast, light, thin-skinned. It should sound like something
that does not want to be shot at.

**`move_treads`** — track clatter over a diesel note. The clatter is the
identity, not the engine: it is the metal-on-metal of links coming round.
Author at medium_tank weight and let the manager pitch it down ~3 semitones
for heavy_tank and up ~2 for light_tank and anti_air; artillery sits at
centre. Dense, mechanical, and the heaviest thing on the board.

**`move_rotor`** — main rotor wash with the blade slap just present, plus
the turbine whine under it. Air, not ground: it should sound suspended.
Helicopter only.

**`move_jet`** — a turbine pass-by, doppler-shaped, peaking just past the
middle of the gesture. fighter_jet, bomber and scout_plane share it; pitch
the bomber down ~2 semitones for mass. At nine tiles this is the longest
sound in the game (810 ms) and the only one with room for a real shape.

**`move_ship`** — hull pushing water, with the screw wash under it. Slow and
heavy even at patrol_boat speed; nothing in the naval class should sound
nimble. The one voice where a little low end is worth having even knowing
the phone speaker will lose it, because it survives as weight in the mids.

### Foot movement varies by surface — 4 sets, 3 variations each

`move_foot` alone is terrain-aware, because infantry are the only units a
player watches step by step, and the map already distinguishes the
surfaces. The other five voices are not: a tank on a road and a tank on
plains is a distinction nobody is listening for.

| set | terrain | sound |
|---|---|---|
| `step_hard` | `road` | boot on asphalt, a slight scuff |
| `step_soft` | `plains`, `forest` | grass and soil, dampened; forest adds a little leaf litter |
| `step_rock` | `mountain` | grit and loose stone, the least regular of the four |
| `step_water` | `river`, `shallow_water` | wading - water displaced, heavier and slower |

Three variations each (12 files), because a three-tile infantry move plays
the set three times in 270 ms and identical repeats at that spacing are
extremely obvious.

## 2. Weapons — 10 families

Triggered by `unitAttacked`. Direct fire is ≤220 ms of lunge; indirect fire
is a launch plus a scheduled impact.

### Direct fire

**`fire_small_arms`** — infantry. A short burst of rifle fire, three or four
rounds, dry and close. Not a single shot: a squad firing, not a duel. The
quietest weapon in the game and it should stay that way, because it is also
the most frequent.

**`fire_at_rocket`** — anti_tank_infantry. A shoulder-launched rocket: the
back-blast crack first, then the motor departing. Distinct from
`fire_small_arms` at a glance, because the two infantry units look similar
on the board and the audio is doing real identification work.

**`fire_autocannon`** — recon. A short, fast burst of light cannon. Metallic
and mechanical rather than explosive.

**`fire_aa`** — anti_air. The same family, but longer, and shaped upward:
sustained, with a slight rising tail that suggests the rounds going away
from the listener. The one weapon where the sound should imply somewhere to
be rather than something to hit.

**`fire_cannon`** — light_tank, medium_tank, heavy_tank. A single tank gun:
a hard crack with a very short tail, and dry, because it has 220 ms before
the impact lands on top of it. One recording, pitched down ~4 semitones for
heavy_tank and up ~2 for light_tank. This is the signature sound of the
game's midgame and deserves the most care of anything in this section.

**`fire_naval_gun`** — escort. Heavier and more open than `fire_cannon`,
with a fraction more tail - a gun on a stable platform rather than a
suspension.

**`fire_naval_light`** — patrol_boat. A light naval autocannon, close to
`fire_autocannon` but wetter and more open.

**`fire_bomb_release`** — bomber. Not a gun. The release and the fall: a
mechanical clunk and a brief descending whistle, followed by a detonation
scheduled ~300 ms later. The longest single attack in the game and the only
one that should feel like it takes time.

### Indirect fire — launch, then a scheduled impact

**`fire_howitzer`** — artillery. A deep, open report with a real tail, since
nothing is landing on top of it: the target is two or three tiles away and
likely off-screen. Followed by `impact_shell` at +300 ms.

**`fire_rocket_salvo`** — rocket_artillery. Four or five rockets leaving in
quick succession, each a hiss and a roar rather than a crack. Ripple-fired,
not simultaneous - the stagger is the identity. Followed by `impact_shell`
at +400 ms, the longest gap on the roster, because it ranges out to five
tiles.

**`fire_monitor_gun`** — monitor. The heaviest report in the game: a naval
rifle, slow, with a long low tail. Followed by `impact_shell` at +350 ms.

**`transport_ship` and `scout_plane` have `fire_mode: null`.** They have no
weapon audio at all. Do not author a courtesy sound for them - the silence
is correct and tells the player something true.

## 3. Impacts — 5, chosen by what was hit

Fired at the defender's tile. `unitAttacked` carries `damage` and
`counterDamage` as separate numbers, so a counter-attack gets its own
impact beat ~150 ms after the first - the exchange should read as two
events, because mechanically it is.

**`impact_armour`** — a shell on a vehicle. Two things in one: the strike
and the structure behind it. Scale with damage if the manager can - a
glancing hit and a killing blow should not be the same clip.

**`impact_infantry`** — softer and duller, with debris. No metal ring. The
contrast with `impact_armour` is how a player learns, without reading a
number, that infantry in a forest are not worth shooting.

**`impact_air`** — a hit on an aircraft: metal, with airflow around it.
Thinner than `impact_armour`, and unstable.

**`impact_hull`** — a hit on a ship. Metal over water: the strike, and then
water disturbed around it.

**`impact_water`** — a shot that lands in `shallow_water`, `deep_water` or
`reef` without hitting anything. A heavy splash and nothing else. This is
the sound of a wasted shot and should feel like one.

## 4. Destruction — 4, by class

Triggered by `unitDestroyed`, 260 ms.

**`destroy_infantry`** — restrained. No screaming, no gore: this is a
tactics game about counters, not a war film, and it will be played by
people who do not want that. A muffled blast and equipment scattering.

**`destroy_vehicle`** — a cook-off: the initial blast then the secondary
crumple of something burning. The most satisfying sound in the game, and
the reward for a plan working.

**`destroy_air`** — the blast, then a descending note cut short. It has 260
ms, so the fall is implied rather than played.

**`destroy_ship`** — the blast, then water: rushing in, closing over. The
only destruction with a wet tail.

## 5. Capture and production

**`capture_tick`** — on `captureProgressed`. Plays once per capture step,
and the manager should **pitch it up with `progress`**: capture takes two
turns at full health and the rising pitch says "nearly" without a number.
A ratchet or a mechanism turning - something that sounds like it is being
wound toward a release.

**`capture_complete`** — on `tileCaptured`, 450 ms of tile flash to fill.
The release the ticks were winding toward: a flag run up, a latch closing.
Resolved and final. One of the three most important sounds in the game -
capture is how matches are won.

**`build_factory`**, **`build_airport`**, **`build_port`** — on `unitBuilt`,
keyed by the building. Every unit's `built_at` is one of these three. A
factory door and a vehicle rolling out; an airport's hangar and a turbine
spooling; a port's crane and a hull entering water. Roughly 600 ms each,
and not gated by an animator constant - production has no animation, so
this is one of the few places with room.

**`funds_spent`** — a short register-like confirmation under the build
sound, because `cost` is deducted immediately and the player should hear
the money leave. Subtle; it plays under something else.

## 6. Turn flow and match end

**`turn_yours`** — on `turnStarted` for your own slot. The most important
sound in the game. This is an asynchronous game where a player opens the
app hours later to find out whether it is their move, and this sound is the
answer. Confident, upward, unmistakable, ~1.2 s. It should be possible to
recognise from another room.

**`turn_theirs`** — on `turnStarted` for anyone else. Deliberately its
opposite: shorter, flatter, downward, ~0.6 s. Informative, not disappointing
- it will be heard as often as `turn_yours`.

**`income`** — a light tone under `turn_yours` when `income` is non-null.
The field is redacted to `null` for everyone but the player whose turn it
is, so this must key off the value being present, never off the slot. A
sound that plays when income is hidden is a fog leak.

**`player_defeated`** — on `playerDefeated`. A single heavy, final note.
Used for both `hq_captured` and `no_units`.

**`victory`** and **`defeat`** — on `matchFinished`, keyed by `winnerSlot`
against your own. Full stings, 2-3 s, the only effects allowed real length.
`matchFinished` can also carry `winnerSlot: null` for a draw - that takes
`defeat`'s length with neither its fall nor `victory`'s lift.

## 7. UI — 12

All ≤150 ms except where noted, all on the `ui` bus, all dry. These are
touched constantly and are the first thing to become irritating.

| id | when | description |
|---|---|---|
| `ui_select` | tapping a unit or tile | a soft click with a little pitch to it; the most-played sound in the game, so err quiet |
| `ui_deselect` | cancelling a selection | `ui_select` inverted - lower, shorter |
| `ui_move_confirm` | committing a move | a positive, definite click; distinct from `ui_select` because it spends the unit's turn |
| `ui_attack_arm` | tapping an enemy in range | tenser, slightly metallic - the forecast is now on screen and a decision is pending |
| `ui_invalid` | a tap that cannot do anything | a flat, dull refusal. **Not** a harsh buzz: it fires on ordinary mis-taps |
| `ui_rejected` | `Net.action_rejected` (the wire's `actionRejected`) | distinct from `ui_invalid` and more serious - the client thought this was legal and was wrong. Rare, and worth noticing |
| `ui_menu_open` | build menu, action bar | a short rising sweep, ~200 ms |
| `ui_menu_close` | dismissing either | the same, falling |
| `ui_end_turn` | committing the turn | weightier than any other UI sound: a switch being thrown. The turn is now gone |
| `ui_connect` | the socket comes up | two rising tones |
| `ui_disconnect` | the socket drops | two falling tones. Will be heard on a phone that lost signal mid-match, so: informative, not alarming |
| `ui_notify` | the "it's your turn" push | ~1.5 s, and **not** `turn_yours`. It plays with the app closed and has to work as a notification tone next to everything else on the phone |

## 8. Music — 5 beds

Original composition, and the place where the licensing rule bites hardest.

**`music_lobby`** — 60-90 s loop. Anticipatory, unhurried. Players sit here
connecting, sharing a code and waiting for a second player, sometimes for
minutes.

**`music_match`** — 2-3 min loop, and the hardest brief in this document:
it has to be interesting enough not to be muted and unobtrusive enough to
think over. Turn-based means a player may stare at one screen for five
minutes planning. Sparse, low, slow-moving, no strong hook, no loop point
that announces itself.

**`music_tension`** — a variant of `music_match` for a losing position: few
units left, or the HQ threatened. Same material, thinner and lower. It
should be possible to cross-fade between the two on a bar line rather than
cutting.

**`music_victory`**, **`music_defeat`** — 8-12 s, non-looping, under the
`victory` / `defeat` stings.

**Faction themes are out of scope.** Five factions times a theme is the
same combinatorial trap rule 8 exists to prevent, for a payoff nobody asked
for. If a faction must sound like itself, it is an instrument colour laid
over `music_match`, not another track.

## 9. Ambience — 2 beds

30-60 s loops, well under the music, keyed by the map.

**`amb_land`** — `crossing`. Wind through open ground, distant birds,
occasional insects. Nothing rhythmic; nothing that becomes a landmark on
loop.

**`amb_naval`** — `straits`. Surf, gulls, wind with water in it.

A third map will need its own or a reuse decision; two maps ship today.

---

## Variation

Three variations for anything that can play more than twice in one
animation batch: the four `step_*` sets, `fire_small_arms`,
`fire_cannon`, `impact_armour`, `impact_infantry`, `destroy_vehicle`.
Everything else is one file, with the manager's pitch offset doing the
work.

Variations must differ in **content**, not just level - a different take,
not the same take quieter. Three copies of one recording at three volumes
is audibly one sound, and costs three times the space to prove it.

## What gets a sound rejected

1. **No recorded provenance.** Where it came from, who made it, under what
   licence. A file without that cannot ship, whatever it sounds like.
2. **Longer than its animator constant.** It will be cut off mid-tail on a
   real board, every time, and the fix is not a fade-out on the asset.
3. **Stereo, for an effect.** See the envelope above.
4. **Vorbis, for anything triggered by a tap.** The decode delay reads as
   input lag.
5. **Inaudible on a phone speaker.** If the identity of the sound is below
   ~300 Hz, there is no identity on the target hardware.
6. **Peaks above -1 dBFS**, or a sound that only works at a level that
   makes everything else quiet.

## What this document does not decide

- **Positional audio.** Whether a sound is panned by tile position, and
  what happens when the camera is zoomed out far enough that everything is
  near the centre. Start mono and centred; revisit if the board feels flat.
- **A settings screen.** Three buses are specified; the UI for them is not.
- **Whether the animator constants should change.** They are treated as
  fixed above, and the tightness they impose is real. Raising them is a
  pacing decision about the whole game, and is a separate conversation from
  this one - but it is the right lever if this catalogue feels cramped
  rather than crisp when it is first heard on a board.
