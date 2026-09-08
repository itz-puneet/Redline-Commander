# Roadmap

## Status

The rules engine and networking work and are tested. There is **no rendering
and no UI** — you cannot see or play a match yet, only drive one through the
protocol.

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
- [ ] **Authenticate `token`** — currently unverified, so a client can claim
      any seat. Blocks any public deployment. (`TODO(auth)` in
      `server/src/net/server.ts`)
- [ ] Rate limiting per connection

## Phase 3 — Make it playable (next up)
- [x] Project imports cleanly in Godot 4.3 and all scripts compile
- [x] Board scene: terrain tilemap, building ownership, units, fog, camera pan/zoom
- [x] Movement/attack/selection overlays, driven by `MovementPreview`
- [x] Headless board checks + a PNG preview renderer
- [x] Touch input: tap to select, tap to move, tap an enemy to attack
- [x] `scenes/match.tscn` - the playable screen, wired through `TurnController`
- [x] Minimal action bar (Capture / Wait / Cancel / End Turn)
- [ ] Animate the `events` from `action_confirmed` instead of snapping
- [ ] Full HUD: funds, turn banner, unit info panel, damage forecast
- [ ] Build menu when tapping an owned factory/airport/port
- [ ] Lobby screen: create match, share code, join by code
- [ ] Hotseat mode on one device (useful for testing without two phones)
- [ ] Transport load/unload actions (data and state exist; engine does not)
- [ ] Faction Field Directives (in `factions.json`; not wired into the engine)

## Phase 4 — Content
- [ ] Original sprite art for all v1 units, two factions minimum — this is
      the one part that genuinely cannot be scaffolded; commission, draw or
      generate art that is yours
- [ ] 3–5 multiplayer maps, including a naval one (`crossing` has no water)
- [ ] Campaign missions 1–3

## Phase 5 — Polish and ship
- [ ] Sound and music (original or properly licensed)
- [ ] UI/UX pass, animations, damage popups
- [ ] Push notifications for "it's your turn"
- [ ] Server deployment behind TLS (`wss://`), Postgres-backed `MatchStore`
- [ ] Android signing, Play Store listing (if distributing beyond direct APKs)

## Notes

- Phase 3 is client-only: the server contract it builds against is already
  fixed and tested, so board work and any further rules work do not collide.
- Before adding a rule, ask whether it can be a data edit instead. Most
  balance work should touch only `shared/data/`.
- After editing `shared/data/`, run `tools/sync-shared-data.sh`.
