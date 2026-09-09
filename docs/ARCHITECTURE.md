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
- `view.ts` — builds the per-player payload, and **redacts** events rather
  than merely filtering them: an enemy move is cut to the tiles actually
  watched, `turnStarted` carries income only for the player whose turn it is
  (income is their building count, and their hidden funds follow from it),
  and builds and captures out of sight are not announced. Tile ownership is
  what a player has seen, not the live grid. Events carry the slot they
  concern rather than having it looked up, because filtering runs against the
  state *after* the action — where a unit that just died no longer exists,
  and a lookup would drop every event about it, including from its owner
- `rng.ts` — seeded PRNG; the seed and counter live *in* the match state
- `engine.ts` — action dispatch, turn flow, win conditions

Combat randomness is seeded from match state, so a saved match replays
identically, a reconnecting client resyncs exactly, and a modified client
cannot reroll an unlucky hit.

### `auth/` — who is connecting

Trust on first use: the first connection to claim a player id registers it
with a salted hash of its secret, and every later connection must present the
same one. `tokens.ts` holds the hashing and the validation, `CredentialStore`
persists it behind the same three-method interface as `MatchStore`, and
`AuthService` is the register-or-verify decision.

It authenticates a *device*, not a person — no accounts, no email, no
password reset, which is the right trade for a game played with friends. The
cost is that losing the device loses the identity. `docs/PROTOCOL.md` has the
rules and the failure codes.

Deliberately a plain salted SHA-256 rather than scrypt or argon2: the secret
is 256 bits of machine-generated randomness, and slow KDFs exist to make
guessing *low-entropy* human-chosen secrets expensive. That module must not
be reused for passwords.

### `match/` — lifecycle and persistence

`MatchService` is the seam between transport and rules. It holds the live
cache, writes each committed turn through `MatchStore` **before**
acknowledging it, and fans one authoritative state out as one filtered
payload per player.

Every operation on a match runs with exclusive access to it. Each one is a
read-modify-write, and two can start in the same tick from different sockets
— a player's action and the other player's socket closing. Serializing only
the disk write would leave both computing from the same snapshot, and the
later commit would erase a turn that had already been acknowledged and
animated. The transport orders messages within a connection; this orders them
between connections.

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

`net/tls.ts` decides whether a connection is allowed at all, before a single
frame is read: encrypted, or forwarded as encrypted by a trusted local proxy,
or loopback. Anything else is refused, because the client's first frame
carries its secret. The policy is a pure function of the connection's facts
and the configured settings, so it is tested directly rather than by standing
up servers with certificates. `docs/DEPLOYMENT.md` has the deployment shapes.

`net/rate_limit.ts` meters messages, connections and match creation. Its own
memory is the subtle part: a limiter keyed by address is itself an attack
surface, so the registries are bounded, sweep idle keys, and fail closed when
full rather than growing. Clock-injected and pure, so behaviour over time is
tested without sleeping.

Messages from one connection are chained onto a per-session promise so they
are handled in order. `ws` calls the handler again as soon as the previous
call *returns*, not when its promise settles — so the moment any handler
awaits, as authentication does, a later message can overtake an earlier one.
Clients legitimately send `hello` and then immediately `rejoinMatch`.

## Client (Godot 4 / GDScript)

- `scripts/data/game_data.gd` *(autoload `GameData`)* — the shared tables
- `scripts/net/player_identity.gd` *(autoload `PlayerIdentity`)* — a stable
  per-install id persisted to `user://`, so a seat survives a reconnect
- `scripts/net/network_client.gd` *(autoload `Net`)* — `WebSocketPeer` + JSON,
  with reconnect backoff and automatic `rejoinMatch`
- `scripts/state/match_state.gd` — local mirror, replaced wholesale from
  server views, never mutated optimistically
- `scripts/net/session_store.gd` *(autoload `Session`)* — remembers the last
  match id so the app can offer to rejoin after being closed
- `scripts/app.gd` — application root: owns the connection and swaps screens
- `scripts/ui/lobby_screen.gd` — connect, create, join by code, rejoin
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
it. Every order goes through one guard, so nothing is submitted while an
animation is playing: the board is showing stale positions, and a button
press means whatever was true before it started.

A `state` frame — what a rejoin is answered with — redraws the board. That is
easy to miss, because unlike an `update` it carries no events to animate;
without it a player who reconnects sits looking at the position from before
they dropped. A unit that died, moved, or was spent while the player was deciding
cannot leave a stale selection behind.

Attacking takes two taps: the first arms the target and puts the damage
forecast on screen, the second commits. A forecast the player cannot read
before committing is not worth computing, and an attack is the one action
that cannot be undone. `CombatForecast` mirrors the server's combat maths and
reports a *range* rather than a number — the server rolls the luck, and
pretending to know it would be a lie the server then contradicts.

Production goes through the same one-action-at-a-time path as everything
else: tapping an owned, empty production tile opens a menu of what it can
build, and choosing one submits a `build`. The menu shows options the player
cannot yet afford, greyed out, so they can see what they are saving toward.
Prices come from `GameData.build_cost()`, which mirrors `buildCost()` in the
server engine — unlike a movement preview this has to agree *exactly*, since
a price shown and then charged differently is a bug the player notices
immediately, so both sides read the same modifiers out of `factions.json` and
both test suites assert the same figures.

That is the general pattern for client mirrors of server formulas: the two
implementations are cross-checked by asserting matching numbers on both
sides, not by hoping they stay in step. `engine.test.ts` pins two reference
duels; `hud_check` asserts the forecast brackets them.

Server events are animated before the new state is drawn. The ordering is
the whole trick: `TurnController` adopts the incoming view immediately, but
`MatchController` holds off rendering until `EventAnimator` has played the
events — so the unit nodes still stand where they were, and there is
something to animate away from. The render afterwards is what makes the
result exact, so a dropped frame or an abandoned tween cannot leave the board
disagreeing with the server. Taps are dropped while a sequence plays, because
the board is showing stale positions and a tap on what is drawn would mean
something else by the time it landed.

`EventAnimator.plan()` is pure — events in, steps out — so the sequencing is
asserted with no waiting, and `play()` tolerates anything missing: a unit
revealed by the very update being animated has no node yet, which is ordinary
rather than an error.

`App` is the only place that swaps screens, and the lobby and the board know
nothing about each other. The lobby is a view that emits intents
(`create_requested`, `join_requested`, …) and never touches `Net` itself,
which is what lets its rules be tested by pressing buttons with no socket
anywhere. A match starts only when a view arrives in `active` phase — a
created match sits in `lobby` phase until the second player joins — and the
view that triggers the swap is handed to the board explicitly, because it
arrives before the board's own `TurnController` exists to receive it.

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
