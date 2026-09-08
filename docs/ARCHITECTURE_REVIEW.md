# Architecture review of the original scaffold

The scaffold this repo grew from was sound in its *instincts* — authoritative
server, data-driven stats, turn-based — but several decisions would have had
to be undone later, some of them after a lot of code had been built on top.
This is the record of what was changed and why, so the reasoning is not lost.

## 1. The client could not have spoken the server's protocol

**Was:** Colyseus on the server, and `ARCHITECTURE.md` describing
`NetworkClient.gd` as "a thin wrapper around Godot's WebSocket client for
talking to the Colyseus room".

**Problem:** Colyseus does not speak JSON over WebSocket. It uses a binary
schema-serialisation protocol with its own handshake, room lifecycle and
state-patch encoding, and it ships SDKs for JS/C#/Lua — not GDScript. A
"thin WebSocketPeer wrapper" cannot join a Colyseus room. Building this would
have meant reimplementing Colyseus's binary patch protocol in GDScript before
a single unit could move.

**Now:** a plain WebSocket + JSON protocol (`docs/PROTOCOL.md`) that Godot
speaks with `WebSocketPeer` and `JSON` and nothing else. A turn-based game
exchanges a few small messages per minute; the state-diffing machinery was
paying for a problem this game does not have — and, per §2, was actively in
the way of the one it does.

## 2. Broadcasting state to everyone defeats fog of war

**Was:** "Server broadcasts the updated `GameState` diff to all clients in the
room", with fog of war listed as a feature.

**Problem:** these cannot both be true. If both clients receive the full
state, a modified client sees every hidden unit regardless of what the UI
draws. Colyseus's per-client filtering (`@filter`) was deprecated and dropped
precisely because it is hard to do correctly, so the framework was pushing
towards the leaky version.

**Now:** `game/view.ts` builds a **separate payload per player**. Enemy units
outside your vision are not redacted, they are simply absent. Enemy units you
*can* see arrive without `fuel`/`ammo`/`cargo`, opponents' funds read `null`,
and events are filtered too, so you are not told an enemy moved somewhere you
cannot see. There is a test asserting nothing leaks.

## 3. Batched turn submission is incompatible with fog of war and luck

**Was:** `TurnManager.gd` queued a whole turn's actions locally and sent them
as one `submitTurn` batch.

**Problem:** with fog of war the player cannot know what is on a tile until
they move next to it, so every action after the first in a batch is a guess —
and an ambush should interrupt a move, which a pre-committed batch cannot
express. Damage also carries a server-side luck roll, so the client cannot
know the board its own second action would apply to. And one illegal action
in a batch raises the question of whether to roll back the whole turn.

**Now:** one action per message, server answers, client adopts the result,
repeat. `endTurn` is the only commit point. A rejection costs one action.

## 4. State had no map, so "validate against terrain" was impossible

**Was:** `GameState` held units, players, `currentTurnPlayerId` and
`turnNumber`. The docs said the server validates "legal move range,
fuel/ammo, ownership, fog of war".

**Problem:** none of that was representable. There was no terrain grid, so
movement cost and defense bonus had nothing to read; `UnitState` had no
`fuel`, no `ammo` and no id.

**Now:** `MatchState` carries the map (terrain + per-tile ownership), and
units carry `id`, `fuel`, `ammo`, `captureProgress` and `cargo`. Maps are
data (`shared/data/maps/*.json`), validated on load.

## 5. Stats were duplicated by hand in two languages

**Was:** stats in `client/scripts/unit_data.gd` and again in the server
schema, with the comment "keep these two in sync manually for now".

**Problem:** they will drift, and the failure mode is nasty — the client
offers the player a move the server then refuses, which reads as a network
bug rather than a data bug.

**Now:** `shared/data/*.json` is the single source. The server reads it
directly; `client/data/` is a generated copy with a drift check
(`npm run verify:data`). The client still *computes* movement range for the
overlay — that duplication is unavoidable — but both sides read the same
numbers, and the client's version is explicitly labelled non-authoritative.

## 6. Rules lived in the room class, so they could not be tested

**Was:** `GameRoom.applyAction()` — game rules inside a Colyseus room, which
needs a running server and a connected client to exercise.

**Now:** `server/src/game/` is pure: state in, new state out, no I/O, no
`Math.random()`. `server/test/engine.test.ts` covers capture timing, fuel,
turn order, indirect fire, production costs, fog leakage and win conditions
with no server running.

## 7. Combat randomness was unseeded

**Was:** "a small luck factor (+/-0-10%)" with no home for the RNG.

**Problem:** an unseeded `Math.random()` makes matches unreplayable, makes a
resync after reconnect unverifiable, and makes desync bugs irreproducible.

**Now:** `rngSeed` and `rngCounter` live *in* the match state and advance with
each roll, so a persisted match replays identically. Tested.

## 8. Turn order was derived from map iteration order

**Was:**

```ts
const ids = Array.from(this.state.players.keys());
const currentIndex = ids.indexOf(this.state.currentTurnPlayerId);
this.state.currentTurnPlayerId = ids[(currentIndex + 1) % ids.length];
this.state.turnNumber += 1;
```

**Problems:** (a) `MapSchema` key order is an implementation detail, not a
turn order; (b) `turnNumber` incremented once per *player* turn, so "round 3"
meant different things for different player counts — and per-round effects
like income and repair would have been wrong; (c) defeated players stayed in
the rotation.

**Now:** an explicit slot ordering that skips defeated players, and
`roundNumber` advances once per full pass. Tested.

## 9. The match started before the opponent arrived

**Was:** `onJoin` set `currentTurnPlayerId` as soon as the first player
joined.

**Now:** a match sits in `lobby` with `currentSlot = 0` until every seat is
filled, then transitions to `active` and runs the first turn's upkeep.

## 10. Seats were keyed to socket ids, so reconnection was impossible

**Was:** `player.id = client.sessionId`, with a TODO for a reconnect grace
period.

**Problem:** a Colyseus `sessionId` is per-connection. A player who
backgrounds the app on a phone gets a new one, so there was nothing to
reconnect *to*. The grace period could never have been implemented on top of
this.

**Now:** seats are keyed to a persistent `playerId` stored in `user://` on
the device. `rejoinMatch` reattaches and returns a fresh snapshot. There is
no grace period because none is needed — disconnecting is not a state the
match cares about.

## 11. Matches existed only in memory

**Was:** state in a Colyseus room, which dies with the room.

**Problem:** friends playing asynchronously take turns hours apart. Any
deploy, crash or idle-room timeout would have destroyed every match in
progress.

**Now:** `MatchStore` persists each committed turn (write-then-rename)
*before* it is acknowledged. `FileMatchStore` is the development
implementation; the interface is four methods, so swapping in Postgres later
touches nothing else.

## 12. Dependency and config problems

- `colyseus@^0.15` with `@colyseus/schema@^2` and `new Server({ server })` —
  the deprecated transport form. Moot now that Colyseus is gone.
- No test script, no typecheck script, no lint. Now `npm test` typechecks
  and runs the engine suite.
- `renderer/rendering_method="mobile"` selects the Vulkan mobile backend,
  which has patchy driver support across the Android install base. A 2D
  tactics grid needs nothing from it — switched to `gl_compatibility`.
- No stretch settings, so the viewport would have letterboxed or distorted
  across phone aspect ratios. Added `canvas_items` / `expand`.
- No touch input configuration. Added pointer emulation so the same handlers
  work on device and on desktop while testing.

## What was kept

The good bones: authoritative server, data-driven stats, generic-archetype
units, the terrain/defense/capture model, and the copyright guardrails in
`CLAUDE.md` — which are the most valuable thing in the original scaffold and
are unchanged apart from the rename.

## Known gaps

Deliberately not addressed, and tracked in `docs/ROADMAP.md`:

- **Authentication.** `token` is accepted without verification, so a client
  can currently claim any `playerId`. This must be fixed before the server is
  exposed publicly (`TODO(auth)` in `server/src/net/server.ts`).
- No matchmaking beyond sharing a join code.
- Transports (`cargo`/`carry_capacity`) are modelled in data and state but
  load/unload actions are not implemented.
- Faction Field Directives are in the data tables but not yet wired into the
  engine.
- No rendering, tilemap, input handling or UI at all.
