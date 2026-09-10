# Roadmap

## Status

Playable end to end, with rendered unit art. What is missing is content:
finished models, terrain art, more maps, and a campaign.

## Phase 0 — Setup ✅
- [x] Repo structure, docs, `CLAUDE.md` guardrails
- [x] Shared data tables as the single source of truth (`shared/data/`)
- [x] Godot project skeleton with Android-appropriate render/stretch/input settings
- [x] Node/TypeScript server skeleton

## Phase 1 — Rules engine ✅
- [x] Terrain table with per-move-type costs and defense
- [x] Unit table with fuel, ammo, fire mode and range
- [x] Movement range (Dijkstra) and server-side path re-validation
- [x] Combat resolution with seeded, reproducible luck
- [x] Capture progress, production, funds and income
- [x] Turn flow: upkeep, repair, resupply, fuel drain, round counting
- [x] Win conditions (HQ captured / no units and no production)
- [x] Fog of war and per-player filtered views
- [x] Test suite (`cd server && npm test`)

## Phase 2 — Networking ✅
- [x] WebSocket + JSON protocol (`docs/PROTOCOL.md`)
- [x] Create / join by match code, seats filled before the match starts
- [x] One-action-at-a-time submission, validated and persisted per action
- [x] Rejections returned only to the offending client, with a corrective view
- [x] Match persistence (`MatchStore`) so a match survives restarts
- [x] Reconnect / resume by persistent `playerId`
- [x] End-to-end protocol smoke test (`npm run smoke`)
- [x] Headless client boot check (`godot --headless res://tests/boot_check.tscn`)
- [x] **Authenticate `token`** — trust on first use, salted hashes, see
      `server/src/auth` and the Authentication section of `docs/PROTOCOL.md`
- [x] Rate limiting — messages, connections, match creation and frame size

## Phase 3 — Make it playable ✅
- [x] Project imports cleanly in Godot 4.3 and all scripts compile
- [x] Board scene: terrain tilemap, building ownership, units, fog, camera pan/zoom
- [x] Movement/attack/selection overlays, driven by `MovementPreview`
- [x] Headless board checks + a PNG preview renderer
- [x] Touch input: tap to select, tap to move, tap an enemy to attack
- [x] `scenes/match.tscn` - the playable screen, wired through `TurnController`
- [x] Minimal action bar (Capture / Wait / Cancel / End Turn)
- [x] Animate the `events` from `action_confirmed` instead of snapping
- [x] Full HUD: top bar, turn banner, unit info panel, damage forecast
- [x] Build menu when tapping an owned factory/airport/port
- [x] Lobby screen: connect, create match, share code, join by code, rejoin
- [x] End-to-end check against a real server (`tools/live-check.sh`)
- [ ] Hotseat mode on one device (useful for testing without two phones)
- [ ] Transport load/unload actions (data and state exist; engine does not)
- [ ] Faction Field Directives (in `factions.json`; not wired into the engine)

## Phase 4 — Content (next up)

Sizes, formats and the checks that reject bad art are in `docs/ART_SPEC.md`.

- [x] A sprite pipeline: two of them now. `art/blender/` (procedural) was
      first; `art/png/build_sheet.py` (real PNG art in, sheet plus a
      faction mask out) is what ships today. Both feed the same tint
      shader and the same checks (`sprite_check`, `sprite_preview`,
      `--check`). See `art/png/README.md`.
- [x] Finished unit art for all 17 units, two colourways (the rest of the
      faction palette is free - it's a shader tint, not a render). Built
      from a reference sheet the user supplied
      (`art/png/reference_sheet.png`); see the commit history in `art/png/` for how
      it was cropped, aligned and verified. Two units needed a real fix:
      their neutral tone was dark enough that the multiplicative tint
      shader couldn't move it, so team colour barely showed - see rule 8
      in `CLAUDE.md` for why, and keep new art out of that trap.
- [x] Terrain and building art, ingested and wired in: `art/png/terrain/`
      (33 files - 8 terrain types plus 5 buildings x 5 owners) built by
      `art/png/build_terrain_sheet.py` into a 1584x48 sheet + manifest,
      loaded by `TerrainTileSet` in place of its old flat-colour painter
      (which stays as the fallback for a checkout with no sheet).
      `board_check` verifies the real sheet is actually what loads, not a
      silent fallback. See `art/png/README.md`.
- [x] Neighbour-aware tile selection. `TerrainTileSet` chooses a road or
      shoreline tile from a 4-bit connectivity mask of its neighbours
      (N/E/S/W) and falls back to the plain tile when the sheet has no
      variant, so art can land a file at a time. `build_terrain_sheet.py`
      picks up `road_NS.png`, `shallow_water_NE.png` and the like with no
      code change.
- [ ] Seamless terrain tiling. The art is still one illustrated vignette per
      type (a single river crossing, one tree cluster), not a texture
      authored to repeat, and **none of the 20 neighbour variants the
      mechanism above wants have been drawn** - 14 roads and 6 shorelines,
      listed exactly in `art/png/README.md`. Until they are, roads are a
      diagonal strip at every junction and shorelines have no beach.
      Three existing tiles are wrong for where they are used, too: the road
      is a diagonal, the reef is painted on shallow water when it only ever
      sits in deep, and every building sits on opaque black.
- [ ] Wire the cropped-and-staged overlays, VFX and emblems
      (`art/png/overlays/`, `art/png/vfx/`, `art/png/emblems/`) into the
      renderer: selection/range highlights still draw flat translucent
      colour (`tile_overlay.gd`), the capture bar is still a drawn rect
      (`Unit._draw()`), combat is still a procedural flash and fade
      (`event_animator.gd`), and faction emblems are not shown anywhere.
- [x] A naval map (`straits`): two coasts, a deep channel with reefs and
      shallows, and a causeway at each edge so foot units can still cross.
      Every map in the index is checked for playability by
      `server/test/data.test.ts`.
- [ ] 3–5 multiplayer maps. Two so far (`crossing`, `straits`).
- [ ] Campaign missions 1–3

## Phase 5 — Polish and ship
- [ ] Sound and music (original or properly licensed)
- [ ] UI/UX pass, animations, damage popups
- [ ] Push notifications for "it's your turn"
- [x] TLS (`wss://`) — the server terminates it or sits behind a proxy, and
      refuses plaintext from anything but loopback. See `docs/DEPLOYMENT.md`.
- [ ] Postgres-backed `MatchStore` and `CredentialStore`
- [ ] Identity transfer between devices, so a reinstall does not orphan matches
- [ ] Android signing, Play Store listing (if distributing beyond direct APKs)

## Notes

- Phase 3 is client-only: the server contract it builds against is already
  fixed and tested, so board work and any further rules work do not collide.
- Before adding a rule, ask whether it can be a data edit instead. Most
  balance work should touch only `shared/data/`.
- After editing `shared/data/`, run `tools/sync-shared-data.sh`.
