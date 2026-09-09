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
    if (!parsed || typeof parsed.t !== "string") return null;
    // An `action` reaches the rules engine, which is documented as never
    // throwing on bad input - a promise it can only keep if the shape was
    // checked before it got there.
    if (parsed.t === "action" && !isWellFormedAction(parsed.action)) return null;
    return parsed as ClientMessage;
  } catch {
    return null;
  }
}

function isVec2(value: unknown): boolean {
  const point = value as { x?: unknown; y?: unknown } | null;
  return (
    typeof point === "object" && point !== null &&
    Number.isInteger(point.x) && Number.isInteger(point.y)
  );
}

/**
 * Structural validation only - whether a move is *legal* is the engine's
 * business, and it re-checks everything. This just guarantees the fields the
 * engine reads exist and have the right type.
 */
export function isWellFormedAction(value: unknown): boolean {
  const action = value as Record<string, unknown> | null;
  if (typeof action !== "object" || action === null) return false;

  switch (action.type) {
    case "move":
      return (
        typeof action.unitId === "string" &&
        Array.isArray(action.path) &&
        // A path long enough to matter is already illegal on move points; the
        // cap is here so validation itself cannot be made expensive.
        action.path.length <= 256 &&
        action.path.every(isVec2)
      );
    case "attack":
      return typeof action.unitId === "string" && typeof action.targetUnitId === "string";
    case "capture":
    case "wait":
      return typeof action.unitId === "string";
    case "build":
      return typeof action.unitType === "string" && isVec2(action.at);
    case "endTurn":
      return true;
    default:
      return false;
  }
}
