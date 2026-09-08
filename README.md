# Redline Commander

An original turn-based tactical strategy game for Android, built to play
online with friends. Inspired by the grid-based tactics genre in general —
not a clone or port of any specific existing game. See `CLAUDE.md` for the
copyright ground rules this project follows.

## Stack

- **Client:** Godot 4.3+ (GDScript) → exports to Android
- **Server:** Node.js 22+ / TypeScript, plain WebSocket + JSON, authoritative

## Repo layout

```
redline-commander/
├── CLAUDE.md                  # Instructions read automatically by Claude Code
├── docs/
│   ├── ARCHITECTURE.md         # Layering, message flow, and why it's shaped this way
│   ├── ARCHITECTURE_REVIEW.md  # What was wrong with the first scaffold, and what changed
│   ├── PROTOCOL.md             # The exact client/server wire contract
│   ├── GAME_DESIGN.md          # Factions, units, terrain, combat rules
│   └── ROADMAP.md              # What's built vs. what's next
├── shared/data/                # SINGLE SOURCE OF TRUTH for all game data
│   ├── units.json  terrain.json  damage_matrix.json  factions.json
│   └── maps/crossing.json
├── tools/sync-shared-data.sh   # shared/data -> client/data (Godot can only export
│                               # files inside the project folder)
├── client/                     # Godot project
│   ├── project.godot
│   ├── data/                   # GENERATED copy of shared/data - do not edit
│   ├── scenes/board.tscn       # The board: terrain, fog, overlays, units, camera
│   ├── tests/                  # Headless checks + a PNG preview renderer
│   └── scripts/
│       ├── data/game_data.gd         # autoload: the shared tables
│       ├── net/player_identity.gd    # autoload: stable per-install player id
│       ├── net/network_client.gd     # autoload: WebSocket + JSON, auto-reconnect
│       ├── state/match_state.gd      # local mirror of the server's view
│       ├── rules/movement_preview.gd # NON-authoritative range preview
│       ├── board/board.gd            # renders a MatchState; render(state)
│       ├── board/board_theme.gd      # placeholder colours and labels
│       ├── board/terrain_tileset.gd  # builds the TileSet from terrain data
│       ├── board/unit.gd             # one unit's presentation
│       ├── board/fog_overlay.gd      # dims tiles outside vision
│       ├── board/tile_overlay.gd     # movement/attack/selection highlights
│       ├── board/board_camera.gd     # pan and zoom (camera gestures only)
│       └── turn_controller.gd        # sends one action, waits, adopts result
└── server/
    ├── src/
    │   ├── game/               # PURE rules engine - no I/O, no randomness
    │   ├── match/              # Match lifecycle + persistence
    │   ├── net/                # WebSocket transport + protocol types
    │   └── index.ts
    ├── scripts/smoke.js     # End-to-end protocol check over real sockets
    └── test/engine.test.ts  # Rules tests, no server required
```

## Getting started

**Server:**

```bash
cd server
npm install
npm run dev     # ws://localhost:2567/play
npm test        # typecheck + 26 rules-engine tests
npm run smoke   # end-to-end protocol check (needs the server running)
```

**Client:** install Godot 4.3+, then `Import` the `client/` folder as a
project. Point `Net.server_url` at your server.

```bash
cd client
godot --headless res://tests/boot_check.tscn    # 33 checks: autoloads, data, rules
godot --headless res://tests/board_check.tscn   # 26 checks: the board renderer

# See it. Needs a real renderer, so use xvfb on a headless machine.
xvfb-run -a godot --resolution 1280x720 res://tests/board_preview.tscn
```

The boot check proves the autoloads come up, the data tables parsed, and the
client-side logic agrees with the server's rules. Note that
`godot --check-only --script <file>` reports false errors for these scripts —
it does not register autoloads — so use the boot check, not that.

**After editing game data:** run `tools/sync-shared-data.sh` to refresh
`client/data`. `cd server && npm run verify:data` fails if they have drifted.

## The three rules worth knowing up front

1. **Game data lives in `shared/data/` and nowhere else.** Never hardcode a
   stat in `.ts` or `.gd`; never edit `client/data/` by hand.
2. **The server decides everything.** Client-side rule code exists only to
   draw overlays. If the two disagree, the client is wrong.
3. **The rules engine is pure.** `server/src/game/` takes state in and returns
   state out — no sockets, no filesystem, no `Math.random()`. That is what
   makes it testable.

`docs/ARCHITECTURE.md` explains the reasoning; `docs/ARCHITECTURE_REVIEW.md`
records what the first scaffold got wrong and why it changed.

## Status

Not playable yet: the rules engine and networking work and are tested, but
there is no rendering or UI. See `docs/ROADMAP.md` — Phase 3 is the board
scene and touch input.

**Do not expose the server publicly yet.** Client tokens are not verified, so
a client can currently claim any player id (`TODO(auth)` in
`server/src/net/server.ts`).

## A note on originality

This project deliberately uses no assets, code, names, or text from any
existing commercial tactics game. All unit names, faction names, terrain,
maps and numbers in `shared/data/` are original starting points to build on.
