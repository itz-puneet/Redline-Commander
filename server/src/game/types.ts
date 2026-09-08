/**
 * Core game types for Redline Commander.
 *
 * These are PLAIN serializable objects on purpose. The rules engine
 * (game/*) has no knowledge of sockets, rooms, or persistence: it takes a
 * MatchState plus an Action and returns a new MatchState plus events. That
 * makes every rule unit-testable without standing up a server, and makes
 * saving a match to disk a plain JSON.stringify.
 */

export type MoveType = "foot" | "wheels" | "treads" | "air" | "sea";
export type FireMode = "direct" | "indirect" | null;

export interface Vec2 {
  x: number;
  y: number;
}

export interface UnitStats {
  display_name: string;
  cost: number;
  move: number;
  move_type: MoveType;
  vision: number;
  max_fuel: number;
  max_ammo: number | null;
  fire_mode: FireMode;
  min_range: number;
  max_range: number;
  can_capture: boolean;
  carry_capacity: number;
  carry_move_types: MoveType[];
  built_at: string[];
}

export interface TerrainStats {
  display_name: string;
  defense: number;
  move_cost: Record<MoveType, number | null>;
  capturable: boolean;
  income: number;
  repairs: MoveType[];
  builds: boolean;
  is_hq: boolean;
}

export interface Unit {
  id: string;
  unitType: string;
  ownerSlot: number;
  x: number;
  y: number;
  /** 1..100. Displayed to players as ceil(hp / 10) pips. */
  hp: number;
  fuel: number;
  /** null for unarmed units. */
  ammo: number | null;
  hasMoved: boolean;
  hasActed: boolean;
  /** Progress toward capturing the tile this unit stands on (0..20). */
  captureProgress: number;
  /** Unit ids currently loaded into this unit (transports). */
  cargo: string[];
}

export interface Tile {
  terrain: string;
  /** 0 = neutral, otherwise the owning player slot. */
  ownerSlot: number;
}

export interface GameMap {
  id: string;
  displayName: string;
  width: number;
  height: number;
  /** Row-major, length = width * height. */
  tiles: Tile[];
}

export interface Player {
  /** Stable across reconnects. Not the socket id. */
  playerId: string;
  slot: number;
  faction: string;
  funds: number;
  directiveCharge: number;
  /** Set when the player has lost (HQ captured or no units left). */
  defeated: boolean;
  connected: boolean;
}

export type MatchPhase = "lobby" | "active" | "finished";

export interface MatchState {
  matchId: string;
  phase: MatchPhase;
  map: GameMap;
  players: Player[];
  units: Record<string, Unit>;
  /** Slot whose turn it is. 0 while in lobby. */
  currentSlot: number;
  /** Increments once per full round, not once per player turn. */
  roundNumber: number;
  /** Seeded so combat rolls are reproducible on replay and resync. */
  rngSeed: number;
  rngCounter: number;
  winnerSlot: number | null;
  /** Monotonic; every applied action bumps it. Clients use it to detect gaps. */
  version: number;
}

/* ------------------------------------------------------------------ */
/* Actions: everything a client may ask the server to do.              */
/* ------------------------------------------------------------------ */

export interface MoveAction {
  type: "move";
  unitId: string;
  /** Full tile path excluding the origin. The server re-validates every step. */
  path: Vec2[];
}

export interface AttackAction {
  type: "attack";
  unitId: string;
  targetUnitId: string;
}

export interface CaptureAction {
  type: "capture";
  unitId: string;
}

export interface BuildAction {
  type: "build";
  unitType: string;
  at: Vec2;
}

export interface WaitAction {
  type: "wait";
  unitId: string;
}

export interface EndTurnAction {
  type: "endTurn";
}

export type Action =
  | MoveAction
  | AttackAction
  | CaptureAction
  | BuildAction
  | WaitAction
  | EndTurnAction;

/* ------------------------------------------------------------------ */
/* Events: what actually happened, broadcast to clients for animation. */
/* ------------------------------------------------------------------ */

export type GameEvent =
  | { type: "unitMoved"; unitId: string; from: Vec2; to: Vec2; path: Vec2[]; fuelSpent: number }
  | { type: "unitAttacked"; attackerId: string; defenderId: string; damage: number; counterDamage: number }
  | { type: "unitDestroyed"; unitId: string; at: Vec2 }
  | { type: "tileCaptured"; x: number; y: number; bySlot: number }
  | { type: "captureProgressed"; unitId: string; progress: number }
  | { type: "unitBuilt"; unitId: string; unitType: string; at: Vec2; cost: number }
  | { type: "turnStarted"; slot: number; roundNumber: number; income: number }
  | { type: "playerDefeated"; slot: number; reason: "hq_captured" | "no_units" }
  | { type: "matchFinished"; winnerSlot: number | null };

/** Every rules-engine entry point returns this. Never throws for illegal input. */
export type ActionResult =
  | { ok: true; state: MatchState; events: GameEvent[] }
  | { ok: false; reason: string };
