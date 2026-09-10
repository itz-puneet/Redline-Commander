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
- [x] A sprite pipeline: models in `art/blender/`, rendered by
      `tools/render-sprites.sh` into a sheet plus a faction mask, tinted on
      the client through one shader. Proven end to end and checked
      (`sprite_check`, `sprite_preview`, `--check`). See `art/README.md`.
- [ ] Replace the blockout models with finished unit art. The plumbing is
      done and every check around it stays as it is; what remains is the
      modelling itself, which is the part that genuinely cannot be
      scaffolded. Two factions come free - they are a colour, not a render.
- [ ] Terrain and building art. Deliberately *not* through Blender: tiles
      have to sit seamlessly beside each other, which is easier to author
      directly than to render.
- [ ] 3–5 multiplayer maps, including a naval one (`crossing` has no water)
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
