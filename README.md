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
│   ├── scenes/                 # main (router), lobby, match, board, action bar
│   ├── tests/                  # Checks + a PNG preview renderer
│   └── scripts/
│       ├── data/game_data.gd         # autoload: the shared tables
│       ├── net/player_identity.gd    # autoload: stable per-install player id
│       ├── net/network_client.gd     # autoload: WebSocket + JSON, auto-reconnect
│       ├── state/match_state.gd      # local mirror of the server's view
│       ├── rules/movement_preview.gd # NON-authoritative range preview
│       ├── rules/combat_forecast.gd  # NON-authoritative damage forecast
│       ├── board/board.gd            # renders a MatchState; render(state)
│       ├── board/board_theme.gd      # placeholder colours and labels
│       ├── board/terrain_tileset.gd  # builds the TileSet from terrain data
│       ├── board/unit.gd             # one unit's presentation
│       ├── board/fog_overlay.gd      # dims tiles outside vision
│       ├── board/tile_overlay.gd     # movement/attack/selection highlights
│       ├── board/board_camera.gd     # pan and zoom (camera gestures only)
│       ├── board/event_animator.gd   # plays server events before the render
│       ├── net/session_store.gd       # autoload: last match, for rejoining
│       ├── app.gd                     # owns the connection, swaps screens
│       ├── ui/lobby_screen.gd         # connect, create, join by code, rejoin
│       ├── ui/action_bar.gd          # Capture / Wait / Cancel / End Turn
│       ├── ui/build_menu.gd          # what a production tile can make
│       ├── ui/top_bar.gd             # turn, round, funds
│       ├── ui/unit_info_panel.gd     # unit stats and the attack forecast
│       ├── ui/turn_banner.gd         # "Your turn" when it comes round
│       ├── match_controller.gd       # what a tap means: select, move, attack
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
godot --headless res://tests/board_check.tscn   # 28 checks: the board renderer
godot --headless res://tests/input_check.tscn   # 34 checks: what a tap does
godot --headless res://tests/lobby_check.tscn   # 26 checks: lobby and routing
godot --headless res://tests/animation_check.tscn  # 24 checks: event animation
godot --headless res://tests/build_check.tscn   # 43 checks: costs and production
godot --headless res://tests/hud_check.tscn     # 41 checks: forecast and panels

# These need a real renderer, so use xvfb on a headless machine.
xvfb-run -a godot --resolution 1280x720 res://tests/gesture_check.tscn
xvfb-run -a godot --resolution 1280x720 res://tests/board_preview.tscn
```

**End to end**, from the repo root — builds the server, hosts a match, and
runs the real client against it:

```bash
tools/live-check.sh
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

Playable end to end. Start the server, open the app, create a match, share
the code, and your friend joins from theirs — then move, attack and capture
with the server validating every step and fog of war enforced per player.
`tools/live-check.sh` proves that whole path in one command.

Moves walk their path, attacks lunge and pop damage numbers, kills fade out
and captures flash. Income accumulates and can be spent: tap one of your
factories, airports or ports to build. Attacking takes two taps — the first
shows what the exchange would cost you, the second commits.

Missing before it is a game: art, more maps, and a campaign. See
`docs/ROADMAP.md`.

**Do not expose the server publicly yet.** Client tokens are not verified, so
a client can currently claim any player id (`TODO(auth)` in
`server/src/net/server.ts`).

## A note on originality

This project deliberately uses no assets, code, names, or text from any
existing commercial tactics game. All unit names, faction names, terrain,
maps and numbers in `shared/data/` are original starting points to build on.
