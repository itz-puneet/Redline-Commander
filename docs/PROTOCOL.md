# Wire Protocol v1

Plain WebSocket, JSON text frames, endpoint `ws://<host>:2567/play`.
Every message is a tagged union on `t`. The authoritative definitions are
`server/src/net/protocol.ts`; this document is the narrative version.

Bump `PROTOCOL_VERSION` on any breaking change. The client compares it
against the `welcome` message and reports a mismatch rather than failing in
confusing ways later.

## Client → server

| `t` | Fields | Notes |
|---|---|---|
| `hello` | `playerId`, `token`, `clientVersion` | Must be first. `playerId` is persistent per install, **not** the socket id. |
| `createMatch` | `mapId`, `faction` | Replies `matchCreated` with a join code. |
| `joinMatch` | `matchId`, `faction` | Fills the second seat and starts the match. |
| `rejoinMatch` | `matchId` | Resume an existing seat after a disconnect. |
| `action` | `matchId`, `action` | Exactly one action. See below. |
| `ping` | — | Replies `pong`. |

Anything other than `hello` before identity is established is refused with
`error: not_authenticated`.

## Actions

```jsonc
{ "type": "move",    "unitId": "u1", "path": [{"x":2,"y":1},{"x":3,"y":1}] }
{ "type": "attack",  "unitId": "u1", "targetUnitId": "u7" }
{ "type": "capture", "unitId": "u1" }
{ "type": "build",   "unitType": "light_tank", "at": {"x":2,"y":0} }
{ "type": "wait",    "unitId": "u1" }
{ "type": "endTurn" }
```

`path` excludes the origin tile and must be contiguous. The server re-walks
it step by step; the client's own idea of the cost is never trusted.

## Server → client

| `t` | Fields | Notes |
|---|---|---|
| `welcome` | `playerId`, `serverVersion`, `protocolVersion` | |
| `matchCreated` | `matchId`, `joinCode` | |
| `state` | `view` | Full snapshot. Sent on rejoin. |
| `update` | `events`, `view` | Animate `events`, then adopt `view`. |
| `actionRejected` | `reason`, `view` | Sent **only** to the offending client. |
| `opponentConnection` | `slot`, `connected` | Presence, not a forfeit. |
| `error` | `code`, `detail?` | |
| `pong` | — | |

`view` is always the truth. Events exist so the client can animate what
happened; if the two ever disagree, adopt the view.

## The view

Built per player by `server/src/game/view.ts`:

- **Own units** in full.
- **Enemy units** only where visible, and stripped of `fuel`, `ammo` and
  `cargo` — a player cannot observe those.
- **Own funds and directive charge** only; the opponent's read `null`.
- `visibleTiles` as a list of tile indices (`y * width + x`).
- Terrain is public; tile ownership is sent as-is.

Events are filtered too: a player is not told an enemy moved somewhere they
cannot see. Turn changes, captures, builds, defeats and match end are public.

## Rejection reasons

Stable string codes, safe to switch on and to show the player:

```
not_your_turn              unit_already_moved         unit_already_acted
no_such_unit               not_your_unit              no_such_target
cannot_attack_own_unit     target_out_of_range_or_immune
indirect_cannot_move_and_fire
path_not_contiguous        path_off_map               impassable_terrain
path_blocked_by_enemy      insufficient_movement      destination_occupied
unit_cannot_capture        tile_not_capturable        tile_already_yours
tile_does_not_build        tile_not_yours             wrong_production_building
tile_occupied              insufficient_funds
match_not_started          match_finished             player_defeated
no_such_match              not_in_this_match          match_full
```

## Reconnection

Disconnecting never forfeits. The match is persisted server-side; the client
reconnects with backoff, re-sends `hello` then `rejoinMatch`, and receives a
`state` snapshot. No catch-up log is needed — the view is rebuilt from
scratch, so a client that was offline for ten turns resyncs the same way as
one that missed a single frame.

A second connection claiming the same `playerId` displaces the first (close
code `4000`), so a seat is never held twice.

## Security notes

- `token` is **not yet verified**. Until it is, a client can claim any
  `playerId`. Do not expose the server publicly before implementing this —
  see the `TODO(auth)` in `server/src/net/server.ts`.
- Deploy behind TLS (`wss://`) in production.
- The server never trusts client-supplied costs, damage, visibility or
  legality. Any new action type must be validated the same way.
