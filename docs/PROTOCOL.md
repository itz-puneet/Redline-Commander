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
| `hello` | `playerId`, `token`, `clientVersion` | Must be first, and must succeed. `playerId` is persistent per install, **not** the socket id; `token` is that install's secret. |
| `createMatch` | `mapId`, `faction` | Replies `matchCreated` with a join code. |
| `joinMatch` | `matchId`, `faction` | Fills the second seat and starts the match. |
| `rejoinMatch` | `matchId` | Resume an existing seat after a disconnect. |
| `action` | `matchId`, `action` | Exactly one action. See below. |
| `ping` | — | Replies `pong`. |

Anything other than `hello` before identity is established is refused with
`error: not_authenticated`.

Messages from one connection are handled strictly in order, so a client may
send `hello` and a follow-up in the same tick without the second overtaking
the first while authentication is in flight.

## Authentication

Trust on first use. The first connection to present a given `playerId`
registers it, and the server stores a salted hash of the accompanying
`token`; every later connection with that id must present the same token.

- `playerId` must match `[A-Za-z0-9_-]{8,64}` — it becomes part of a
  filename, so the character set is restricted rather than escaped.
- `token` must be 16–256 characters. The real client generates 32 random
  bytes (64 hex) on first launch.
- Three failed attempts on one connection closes it with code `4001`.
- A second connection authenticating as an id that is already online
  displaces the first, which is closed with code `4000`. Clients must not
  reconnect after either code: one will be refused again, and the other
  would have two devices fighting over the seat.

Failures are `error` frames with `invalid_player_id`, `invalid_token`, or
`auth_failed`. `auth_failed` is used for any wrong secret on a registered id,
and carries no detail — a rejection must not become a way to enumerate who
exists.

**This authenticates a device, not a person.** Losing the device or clearing
app data means losing the identity, and any match it was in; there is no
recovery, by design. The remaining hole is that whoever claims an
unregistered id first owns it — not a practical attack against 128 bits of
client-generated randomness, but the reason a large public deployment
eventually wants real accounts.

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
it step by step; the client's own idea of the cost is never trusted, and a
malformed action is rejected at the transport before it reaches the rules.

A move that walks into a unit the player cannot see **succeeds**, stopping
the unit short — the `unitMoved` event reports where it actually ended.
Refusing would let a client probe the fog for free. An attack requires that
one of your units can *see* the target; `no_such_target` covers both "not
there" and "cannot see it", so a rejection cannot be used to check whether a
remembered unit is still alive.

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
- Terrain is public; **tile ownership is what this player has seen**, not the
  live grid — a building changing hands in the dark would otherwise pinpoint
  the enemy infantry that took it.

Events are **redacted** per player, not merely filtered, because several
carry more than the view does:

- An enemy move is cut to the tiles actually watched, so a route that ducks
  into fog ends there.
- `turnStarted` carries `income` only for the player whose turn it is —
  income is their building count, and their hidden funds follow from it.
- Builds and captures out of sight are not announced.
- Only defeats and the end of the match are public.

## Rate limiting

The server meters messages per player, connections per address, and match
creation. Exceeding a limit returns `error: rate_limited`; the message is
dropped, not queued. Persistent flooding closes the connection with code
`4003`, and a client that sees it should back off rather than reconnect
immediately.

Frames larger than 64 KiB are refused by the transport and close the
connection with the standard code `1009`.

Before authentication the budget is smaller and belongs to the socket rather
than the address, and exceeding it **closes** the connection rather than
dropping the frame — a client sends `hello` once, so a dropped one would
leave it connected with no way to recover. A socket that has not
authenticated within 20 seconds is closed with code `4001`.

A second `hello` on an already-authenticated socket is refused with
`already_authenticated`; one connection carries one identity.

Ordinary play is nowhere near these limits — see `docs/DEPLOYMENT.md` for the
numbers and how to tune them.

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
already_authenticated      rate_limited               insecure_transport
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

- **Deploy behind TLS (`wss://`).** The device secret travels in the `hello`
  frame, so over plain `ws://` anyone on the path can read it and then be
  that player. This is the one remaining requirement before exposing the
  server beyond a trusted network.
- Tokens are never stored, logged, or returned — only a salted hash is kept,
  in `server/.state/credentials/`, which is gitignored.
- The server never trusts client-supplied costs, damage, visibility or
  legality. Any new action type must be validated the same way.
- Rate limiting is on by default; behind a proxy, add per-client limits
  there too, since every connection appears to come from loopback.
