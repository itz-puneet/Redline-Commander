# Architecture

## Overview

Client–server, authoritative server, turn-based, asynchronous. The server is
the single source of truth. Clients render a **fog-filtered view** of that
truth and send **one intent at a time**.

```
[Godot Client A] --WS/JSON--\                        /-- game/ (pure rules engine)
                              > net/ -> MatchService <
[Godot Client B] --WS/JSON--/                        \-- MatchStore (durable)
```

## Layers

The dependency arrow points one way only, and that is the whole design:

| Layer | Path | Knows about |
|---|---|---|
| Data tables | `shared/data/*.json` | nothing |
| Rules engine | `server/src/game/` | data tables |
| Match lifecycle | `server/src/match/` | rules engine, storage |
| Transport | `server/src/net/` | match lifecycle |
| Client | `client/` | the wire protocol, data tables |

The rules engine never imports from `net/` or `match/`. That is what lets
`server/test/engine.test.ts` exercise capture rules, fuel, fog and win
conditions with no server running.

## One source of truth for game data

`shared/data/` holds units, terrain, the damage matrix, factions and maps.
The server reads it directly. Godot can only export files inside the project
folder, so `client/data/` is a **generated copy** produced by
`tools/sync-shared-data.sh` and verified in CI by `npm run verify:data`.

This matters more than it looks: the client has to compute movement range to
draw the blue overlay, and the server has to compute it to validate the move.
Two implementations are unavoidable — two *sets of numbers* are not, and a
silent drift between them shows up as moves the player is shown and then
denied.

## Server

### `game/` — the rules engine (pure)

`applyAction(state, slot, action)` returns either `{ok: true, state, events}`
or `{ok: false, reason}`. It never throws on bad input, never mutates its
argument (it clones first), and never calls `Math.random()`.

- `data.ts` — loads and validates `shared/data`
- `movement.ts` — Dijkstra over per-terrain move costs; path re-walking
- `combat.ts` — the damage formula, written down once
- `vision.ts` — per-player visible tile sets
- `view.ts` — builds the per-player payload
- `rng.ts` — seeded PRNG; the seed and counter live *in* the match state
- `engine.ts` — action dispatch, turn flow, win conditions

Combat randomness is seeded from match state, so a saved match replays
identically, a reconnecting client resyncs exactly, and a modified client
cannot reroll an unlucky hit.

### `match/` — lifecycle and persistence

`MatchService` is the seam between transport and rules. It holds the live
cache, writes each committed turn through `MatchStore` **before**
acknowledging it, and fans one authoritative state out as one filtered
payload per player.

There is no "room" object binding a match to a live connection. A match is a
persisted record; connections attach to and detach from it. That is what makes
"my friend takes their turn tomorrow morning" and "my phone dropped wifi"
ordinary rather than special cases.

`FileMatchStore` (JSON files, write-then-rename) is fine for development and
small groups. Swap in Postgres behind the same four methods when you outgrow
it; nothing else changes.

### `net/` — transport

A thin `ws` server. Parses a frame, calls `MatchService`, writes the results
back. It contains no game rules at all.

## Client (Godot 4 / GDScript)

- `scripts/data/game_data.gd` *(autoload `GameData`)* — the shared tables
- `scripts/net/player_identity.gd` *(autoload `PlayerIdentity`)* — a stable
  per-install id persisted to `user://`, so a seat survives a reconnect
- `scripts/net/network_client.gd` *(autoload `Net`)* — `WebSocketPeer` + JSON,
  with reconnect backoff and automatic `rejoinMatch`
- `scripts/state/match_state.gd` — local mirror, replaced wholesale from
  server views, never mutated optimistically
- `scripts/rules/movement_preview.gd` — **non-authoritative** range preview
- `scripts/turn_controller.gd` — sends one action, waits, adopts the result
- `scenes/board.tscn` + `scripts/board/` — the board renderer

The board has a single entry point, `Board.render(state)`, and derives
everything it draws from the `MatchState` the server sent. It holds no game
state and makes no rules decisions, so the same scene is driven identically
by a live match, a replay, or a test fixture. Draw order is terrain, fog,
range overlays, units — fog sits under the overlays because a player may
move into ground they have not scouted, so the movement range has to stay
readable through it.

Placeholder colours stand in for art (`board_theme.gd`), and the terrain
TileSet is generated at runtime from `terrain.json` rather than authored, so
the repo carries no placeholder art and a new terrain type appears on the
board without touching a `.tres`.

Input is split in two so the interesting half is testable. `Board` reports
only *where* the player tapped; `MatchController` decides what that means —
select, move, attack — and submits through `TurnController`. Its entry point
`tap_tile()` takes a tile, so the interaction rules are exercised by feeding
tiles rather than synthesising touch events; the thin layer in front of it
(screen coordinates, telling a tap from a pan) is covered separately by
`gesture_check`, which needs a real display server.

`MatchController` holds exactly one piece of UI state — which unit is
selected — and re-validates it against every server view rather than trusting
it. A unit that died, moved, or was spent while the player was deciding
cannot leave a stale selection behind.

## Message flow

1. Client connects and sends `hello` with its persistent `playerId`.
2. Client sends `createMatch` (gets a join code) or `joinMatch`.
3. The match starts only when **every** seat is filled.
4. On their turn the player sends **one** action; the server validates,
   applies, persists, and sends every player an `update` — their own events,
   their own view.
5. An illegal action returns `actionRejected` **to that client only**, with a
   fresh view attached so a drifted client is corrected rather than left
   arguing.
6. Repeat until an HQ is captured or a player has neither units nor
   production.

`docs/PROTOCOL.md` has the exact message shapes.

## Why these choices

**Why an authoritative server for a turn-based game?** Cheating, mostly: a
modified client could otherwise claim any move happened. It also gives a
natural home for match state when a player disconnects mid-game — which, on
mobile, is constantly.

**Why one action at a time instead of submitting a whole turn?** Two reasons,
both fatal to batching. With fog of war the player cannot know what is on a
tile until they move next to it, so every action after the first would be a
guess. And damage carries a server-side luck roll, so the client cannot
predict the board state its own second action would apply to. A rejection
also costs one action rather than the whole turn.

**Why a hand-rolled protocol rather than a state-sync framework?** The client
is Godot, which has to be able to speak the protocol with nothing but
`WebSocketPeer` and `JSON`. Turn-based play exchanges a handful of small
messages per minute, so automatic state diffing buys little — and the server
has to build a *different* payload per player for fog of war anyway, which is
exactly the case broadcast-style state sync handles worst.

**Why is the whole map sent to both players?** Terrain is public knowledge in
this design (players can see the battlefield; they cannot see who is standing
on it). Unit positions and tile ownership are filtered per player. If you
later want unexplored terrain hidden too, filter `map.terrain` in
`view.ts` — that is the only place it would need to change.
