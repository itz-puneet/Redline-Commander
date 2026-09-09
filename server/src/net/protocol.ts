/**
 * Wire protocol for Redline Commander. Plain JSON text frames over a plain
 * WebSocket - see docs/PROTOCOL.md for the narrative version.
 *
 * Deliberately hand-rolled rather than a state-sync framework: this is a
 * turn-based game that exchanges a handful of small messages per minute, the
 * server has to build a *different* payload per player anyway (fog of war),
 * and the Godot client has to be able to speak it with nothing but
 * WebSocketPeer and JSON. Every message is a tagged union on `t`.
 */

import type { Action, GameEvent } from "../game/types";
import type { PlayerView } from "../game/view";

/* ---------------------------- client -> server --------------------- */

export type ClientMessage =
  /** First message on every connection. The device's own id and secret,
   *  NOT the socket id, so a reconnect resumes the seat. The first
   *  connection to use an id registers it; later ones must present the same
   *  secret (see server/src/auth). */
  | { t: "hello"; playerId: string; token: string; clientVersion: string }
  | { t: "createMatch"; mapId: string; faction: string }
  | { t: "joinMatch"; matchId: string; faction: string }
  | { t: "rejoinMatch"; matchId: string }
  | { t: "action"; matchId: string; action: Action }
  | { t: "ping" };

/* ---------------------------- server -> client --------------------- */

export type ServerMessage =
  | { t: "welcome"; playerId: string; serverVersion: string; protocolVersion: number }
  | { t: "error"; code: string; detail?: string }
  /** Full authoritative snapshot, already filtered for the recipient. Sent on
   *  join, on rejoin, and whenever the client reports a version gap. */
  | { t: "state"; view: PlayerView }
  /** Incremental: what happened, plus the resulting view. Clients animate the
   *  events and then hard-adopt the view - the view is the truth. */
  | { t: "update"; events: GameEvent[]; view: PlayerView }
  | { t: "actionRejected"; reason: string; view: PlayerView }
  | { t: "matchCreated"; matchId: string; joinCode: string }
  | { t: "opponentConnection"; slot: number; connected: boolean }
  | { t: "pong" };

export const PROTOCOL_VERSION = 1;

export function encode(message: ServerMessage): string {
  return JSON.stringify(message);
}

export function decode(raw: string): ClientMessage | null {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.t === "string") return parsed as ClientMessage;
    return null;
  } catch {
    return null;
  }
}
