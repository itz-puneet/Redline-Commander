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
  /**
   * The transport carrying this unit, or null when it is on the board.
   *
   * A carried unit keeps its x/y in step with its transport so that losing
   * the transport has a place to report the cargo dying, but it is NOT on
   * the board: it blocks no tile, sees nothing, and is never sent to an
   * opponent. Every place that asks "what is standing here" goes through
   * `unitAt`, which skips these.
   */
  carriedBy: string | null;
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
  /** Counts up toward the faction's `charge_cost`; spent to fire a directive. */
  directiveCharge: number;
  /**
   * The directive currently in effect for this player, or null. Only ever
   * this player's own faction's directive - there is one per faction, so the
   * id doubles as "is something running".
   */
  activeDirective: string | null;
  /** Turns of `activeDirective` left, counted down at this player's upkeep. */
  directiveTurnsLeft: number;
  /** Set when the player has lost (HQ captured or no units left). */
  defeated: boolean;
  connected: boolean;
  /**
   * What this player has actually seen of who owns what, indexed like
   * `map.tiles`. Sending the live ownership grid would undo the fog: a
   * building changing hands in the dark pinpoints the enemy infantry that
   * took it. Players see the last state they had eyes on, and find out it
   * changed when they look again.
   */
  knownTileOwners: number[];
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
  /**
   * Pass-and-play: one person holds every seat on one device.
   *
   * The only thing this changes is who is allowed to sit down - the same
   * playerId may take more than one seat. Everything downstream still works
   * per slot: the server builds one seat's fogged view at a time and sends
   * whichever seat is to move, so a hotseat client never receives a combined
   * picture of the board. The player is trusted not to peek at a screen they
   * are holding, exactly as they are across a table.
   */
  hotseat: boolean;
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

export interface LoadAction {
  type: "load";
  /** The unit stepping aboard. Must be adjacent to, or already on, the transport. */
  unitId: string;
  transportId: string;
}

export interface UnloadAction {
  type: "unload";
  transportId: string;
  unitId: string;
  /** Where to put it down. Must be adjacent to the transport and passable. */
  to: Vec2;
}

/** Spend a full charge on the faction's Field Directive. */
export interface DirectiveAction {
  type: "directive";
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
  | LoadAction
  | UnloadAction
  | DirectiveAction
  | EndTurnAction;

/* ------------------------------------------------------------------ */
/* Events: what actually happened, broadcast to clients for animation. */
/* ------------------------------------------------------------------ */

/**
 * Events carry the slot they concern. That is not redundant with the state:
 * filtering happens against the state *after* the action, where a destroyed
 * unit no longer exists to be looked up - so a filter that resolved ids
 * would silently drop every event about a unit that just died, including
 * from the player who owned it.
 */
export type GameEvent =
  | {
      type: "unitMoved"; unitId: string; ownerSlot: number;
      from: Vec2; to: Vec2; path: Vec2[]; fuelSpent: number;
    }
  | {
      type: "unitAttacked"; attackerId: string; defenderId: string;
      attackerSlot: number; defenderSlot: number;
      damage: number; counterDamage: number;
    }
  | { type: "unitDestroyed"; unitId: string; ownerSlot: number; at: Vec2 }
  | { type: "tileCaptured"; x: number; y: number; bySlot: number }
  | {
      type: "unitLoaded"; unitId: string; transportId: string;
      ownerSlot: number; at: Vec2;
    }
  | {
      type: "unitUnloaded"; unitId: string; transportId: string;
      ownerSlot: number; at: Vec2;
    }
  | { type: "captureProgressed"; unitId: string; ownerSlot: number; progress: number }
  | {
      type: "unitBuilt"; unitId: string; unitType: string; bySlot: number;
      at: Vec2; cost: number;
    }
  /** `income` is redacted to null for anyone but the player whose turn it is. */
  | { type: "turnStarted"; slot: number; roundNumber: number; income: number | null }
  | {
      type: "directiveActivated"; slot: number; directiveId: string;
      /** Turns it will be in effect for, including the rest of this one. */
      turns: number;
    }
  | { type: "directiveEnded"; slot: number; directiveId: string }
  | { type: "playerDefeated"; slot: number; reason: "hq_captured" | "no_units" }
  | { type: "matchFinished"; winnerSlot: number | null };

/** Every rules-engine entry point returns this. Never throws for illegal input. */
export type ActionResult =
  | { ok: true; state: MatchState; events: GameEvent[] }
  | { ok: false; reason: string };
