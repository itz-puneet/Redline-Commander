# CLAUDE.md — Project Instructions for Claude Code

This file is read automatically by Claude Code at the start of sessions in this repo.

## Project

**Redline Commander** is an original turn-based tactical strategy game for Android,
built for playing online with friends. It is inspired by the *genre* of grid-based
tactics games (unit types with rock-paper-scissors matchups, terrain-based defense
bonuses, capturing bases, fog of war) — it is NOT a clone, port, or derivative work
of any specific commercial title.

## Hard rule: no copyrighted material from other games

Never introduce, reference, copy, or closely paraphrase, from Advance Wars or any
other existing commercial game:
- Faction/character/Commanding-Officer names, portraits, or dialogue
- Unit sprite art, map tile art, music, or sound effects
- Exact stat tables, map layouts, or mission/campaign text
- Box art, logos, or marketing copy

Generic military terminology (Infantry, Tank, Artillery, Anti-Air, Recon, APC,
etc.) and generic tactics-game mechanics (grid movement, terrain defense bonus,
fog of war, capturing buildings) are fine to use — these aren't anyone's IP.
All names, art, and specific numbers in `shared/data/` and `docs/GAME_DESIGN.md`
are original; extend them in the same spirit rather than pulling from reference
games.

## Tech stack

- **Client:** Godot 4.3+, GDScript, exports to Android (APK/AAB)
- **Server:** Node.js 22+ / TypeScript, plain WebSocket + JSON
- **Multiplayer model:** online, turn-based, authoritative server. The client
  sends **one action at a time**; the server validates it, applies it, and
  sends each player their own fog-filtered view (see `docs/ARCHITECTURE.md`).

## Architectural rules — do not break these

These are the things that are expensive to retrofit. They are enforced by the
layout of the code, so keep them that way.

1. **One source of truth for data.** Unit stats, terrain, damage numbers and
   faction traits live in `shared/data/*.json` and nowhere else. The server
   reads them directly; `client/data/` is a generated copy
   (`tools/sync-shared-data.sh`, checked by `npm run verify:data`). Never
   hardcode a stat in `.ts` or `.gd`, and never edit `client/data/` by hand.

2. **The rules engine is pure.** Everything in `server/src/game/` takes state
   in and returns new state out. No sockets, no filesystem, no `Math.random()`
   (use the seeded RNG in `game/rng.ts`), no mutation of its arguments. This
   is what makes `server/test/engine.test.ts` possible — a rule you cannot
   test without a socket is in the wrong file.

3. **The server never sends a player what they cannot see.** Fog of war is
   enforced by building a *separate payload per player* in `game/view.ts`.
   Do not add a broadcast path that sends full state to everyone; a modified
   client would read straight through the fog.

4. **The client is never authoritative.** `MovementPreview`,
   `CombatForecast`, `GameData.build_cost()` and any other client-side rule
   code exists only to put something on screen. The server re-validates
   everything. If they disagree, the client is the bug.

   Where the client mirrors a server formula, **cross-check it with matching
   numbers on both sides** rather than trusting two implementations to stay
   in step. `build_check` asserts the same production costs as
   `engine.test.ts`, and `hud_check` asserts the damage forecast brackets the
   two reference duels that suite pins. Neither can drift without a test
   going red. Anything the player is shown and then charged or dealt
   differently is a bug they notice immediately.

5. **Credentials are secrets, and ids are not to be trusted.** The device
   token is never stored, logged, or committed - only a salted hash, in
   gitignored `server/.state/`. Any id that becomes part of a filename is
   validated against a whitelist pattern rather than escaped, so path
   traversal is refused at the door. Never add a log line, error message, or
   test fixture that carries a real token.

   That secret travels in the `hello` frame, so the server refuses plaintext
   connections from anything but loopback (`net/tls.ts`). Do not weaken that
   default, and do not make the client skip certificate verification to get a
   self-signed certificate working - both turn a loud failure into a silent
   leak.

6. **The adopted state is the truth; animation is decoration.** The board
   is not re-rendered until an event animation finishes - that is what
   leaves the old unit positions on screen to animate away from. Every
   sequence ends in a render of the server's state, so a dropped frame or an
   abandoned tween cannot leave the board wrong. Never animate *instead* of
   rendering.

7. **The server stays up.** It holds live matches, so a crash drops everyone
   mid-turn. `ws` emits `error` on a socket for protocol violations, and an
   async event listener that rejects becomes an unhandled rejection - both
   are fatal by default, which turns a frame-size *protection* into a
   one-packet remote kill switch. Every socket gets an error listener, async
   listeners catch their own failures, and `index.ts` logs unhandled
   rejections rather than dying. Never add an `async` event listener without
   a `.catch`.

8. **A match is a persisted record, not a live connection.** Players drop,
   background the app, and take their turn hours later. Committed turns are
   written through `MatchStore` before being acknowledged, and a seat is keyed
   to a stable `playerId`, never a socket id.

## Current status

Playable end to end: connect, create or join a match by code, and fight it
out - board, fog, touch input, animated moves and combat, production, and a HUD
with a damage forecast, all validated by the server and verified against a
real one by `tools/live-check.sh`. Still
missing before it is a game: art, more maps, and a campaign.

Devices authenticate on connect (trust on first use, see `server/src/auth`),
the server refuses unencrypted connections from anything but loopback, and
messages, connections and match creation are rate limited.
`docs/DEPLOYMENT.md` covers running it for real.

## Where to start

1. `docs/ARCHITECTURE.md` — layering, message flow, and *why* it is shaped this way.
2. `docs/GAME_DESIGN.md` — factions, units, terrain, combat rules.
3. `docs/PROTOCOL.md` — the exact client/server wire contract.
4. `docs/DEPLOYMENT.md` — TLS, environment variables, running it for real.
5. `docs/ROADMAP.md` — pick up the next unchecked item.

## Commands

```bash
cd server
npm install
npm run dev          # ts-node-dev, ws://localhost:2567/play
npm test             # typecheck + rules engine tests
npm run smoke        # end-to-end protocol check (server must be running)
npm run verify:data  # fail if client/data has drifted from shared/data

cd client
godot --headless res://tests/boot_check.tscn    # autoloads, data tables, rules
godot --headless res://tests/board_check.tscn   # the board renderer
godot --headless res://tests/input_check.tscn   # what a tap on a tile does
godot --headless res://tests/lobby_check.tscn   # the lobby and screen routing
godot --headless res://tests/animation_check.tscn  # event animation
godot --headless res://tests/build_check.tscn   # production costs and the build menu
godot --headless res://tests/hud_check.tscn     # damage forecast, panels, banner

# These need a real renderer - use xvfb on a headless machine.
xvfb-run -a godot --resolution 1280x720 res://tests/gesture_check.tscn
xvfb-run -a godot --resolution 1280x720 res://tests/board_preview.tscn
xvfb-run -a godot --resolution 1280x720 res://tests/lobby_preview.tscn
xvfb-run -a godot --resolution 1280x720 res://tests/animation_preview.tscn
xvfb-run -a godot --resolution 1280x720 res://tests/build_preview.tscn

# End to end against a real server: builds, hosts a match, runs the client.
tools/live-check.sh
tools/live-check.sh --tls   # the same, over wss:// with a generated cert
tools/dev-cert.sh           # a self-signed cert for local wss:// testing
```

Two Godot gotchas worth knowing:

- `godot --check-only --script <file>` reports false "Identifier not found"
  errors for the autoloads (`GameData`, `Net`, `PlayerIdentity`) and for
  `class_name` types, because that mode does not register them. Use the
  checks above to validate the client. If a `class_name` you just added is
  not found, run `godot --headless --import` to refresh the class cache.
- Under `--headless` the dummy display server never dispatches synthesised
  input, so `Input.parse_input_event` and `Viewport.push_input` go nowhere
  and input tests would pass vacuously. That is why `gesture_check` needs
  xvfb, and why it fails loudly if nothing was delivered.
- A GDScript function containing `await` is a coroutine, and calling it
  *without* `await` returns immediately at its first suspension. In a test
  suite that means `_ready()` races ahead to the summary and prints "all
  checks passed" for checks that never ran. Await every phase, and give a
  suite whose phases can suspend a completion sentinel (see the `_phases`
  counter in `build_check`). A suite that reports success while its scene
  failed to load is worse than one that fails.
