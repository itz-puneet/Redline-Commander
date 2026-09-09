/**
 * The rules engine.
 *
 * Pure and transport-free: `applyAction(state, slot, action)` returns either
 * a new state plus the events that happened, or a refusal with a reason.
 * It never throws on bad input, never touches a socket, and never calls
 * Math.random(). Everything the game is actually *about* lives here, which
 * is what makes it testable (see server/test/engine.test.ts) and what keeps
 * the networking layer replaceable.
 */

import { FACTIONS, loadMap, terrainStats, tileAt, unitStats } from "./data";
import { canEngage, displayHp, resolveCombat } from "./combat";
import { validatePath } from "./movement";
import { isVisibleTo, visibleTiles } from "./vision";
import type {
  Action,
  ActionResult,
  GameEvent,
  MatchState,
  Player,
  Unit,
  Vec2,
} from "./types";

const CAPTURE_THRESHOLD = 20;
const FUEL_DRAIN_PER_TURN: Record<string, number> = { air: 5, sea: 1 };
const REPAIR_HP_PER_TURN = 20;

let unitCounter = 0;
function nextUnitId(): string {
  unitCounter += 1;
  return `u${unitCounter}_${Date.now().toString(36)}`;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function fail(reason: string): ActionResult {
  return { ok: false, reason };
}

function unitAt(state: MatchState, x: number, y: number): Unit | undefined {
  return Object.values(state.units).find((u) => u.x === x && u.y === y);
}

/* ------------------------------------------------------------------ */
/* Match creation                                                      */
/* ------------------------------------------------------------------ */

export interface CreateMatchOptions {
  matchId: string;
  mapId: string;
  /**
   * Required, not optional. The engine has no business sourcing randomness -
   * it is supposed to be a pure function of its inputs, and a seed it picked
   * itself with Math.random() would be predictable: luck is recoverable from
   * the damage the server reports, so a weak seed leaks future rolls.
   * MatchService supplies a cryptographically random one.
   */
  rngSeed: number;
}

export function createMatch(options: CreateMatchOptions): MatchState {
  const { map, startUnits } = loadMap(options.mapId);

  const state: MatchState = {
    matchId: options.matchId,
    phase: "lobby",
    map,
    players: [],
    units: {},
    currentSlot: 0,
    roundNumber: 0,
    rngSeed: options.rngSeed,
    rngCounter: 0,
    winnerSlot: null,
    version: 0,
  };

  for (const spawn of startUnits) {
    const unit = spawnUnit(state, spawn.unitType, spawn.slot, spawn.at);
    if (unit) state.units[unit.id] = unit;
  }

  return state;
}

function spawnUnit(
  state: MatchState,
  unitType: string,
  ownerSlot: number,
  at: Vec2,
): Unit | null {
  const stats = unitStats(unitType);
  if (!stats) return null;
  return {
    id: nextUnitId(),
    unitType,
    ownerSlot,
    x: at.x,
    y: at.y,
    hp: 100,
    fuel: stats.max_fuel,
    ammo: stats.max_ammo,
    hasMoved: false,
    hasActed: false,
    captureProgress: 0,
    cargo: [],
  };
}

export function addPlayer(
  state: MatchState,
  playerId: string,
  faction: string,
): ActionResult {
  if (state.phase !== "lobby") return fail("match_already_started");
  if (state.players.some((p) => p.playerId === playerId)) return fail("already_joined");
  if (state.players.length >= 2) return fail("match_full");
  if (!FACTIONS[faction]) return fail("unknown_faction");

  const next = clone(state);
  const slot = next.players.length + 1;
  const player: Player = {
    playerId,
    slot,
    faction,
    funds: 0,
    directiveCharge: 0,
    defeated: false,
    connected: true,
    // Nothing is known until it is seen; refreshKnownTiles fills in the
    // player's own base as soon as the match starts.
    knownTileOwners: new Array(next.map.tiles.length).fill(0),
  };
  next.players.push(player);
  next.version += 1;

  // The match starts only when every slot is filled, not when the first
  // player walks in.
  if (next.players.length === 2) {
    next.phase = "active";
    next.currentSlot = 1;
    next.roundNumber = 1;
    const events = beginTurn(next, 1);
    refreshKnownTiles(next);
    return { ok: true, state: next, events };
  }

  refreshKnownTiles(next);
  return { ok: true, state: next, events: [] };
}

/* ------------------------------------------------------------------ */
/* Action dispatch                                                     */
/* ------------------------------------------------------------------ */

export function applyAction(state: MatchState, slot: number, action: Action): ActionResult {
  if (state.phase === "finished") return fail("match_finished");
  if (state.phase !== "active") return fail("match_not_started");
  if (slot !== state.currentSlot) return fail("not_your_turn");

  const player = state.players.find((p) => p.slot === slot);
  if (!player) return fail("not_a_player");
  if (player.defeated) return fail("player_defeated");

  const result = dispatch(state, slot, action);

  // Anything that moved a unit, took a building or ended a turn may have
  // changed what each player can see. Recording it here, in one place, is
  // what keeps the per-player ownership view honest.
  if (result.ok) refreshKnownTiles(result.state);
  return result;
}

function dispatch(state: MatchState, slot: number, action: Action): ActionResult {
  switch (action.type) {
    case "move":
      return doMove(state, slot, action.unitId, action.path);
    case "attack":
      return doAttack(state, slot, action.unitId, action.targetUnitId);
    case "capture":
      return doCapture(state, slot, action.unitId);
    case "build":
      return doBuild(state, slot, action.unitType, action.at);
    case "wait":
      return doWait(state, slot, action.unitId);
    case "endTurn":
      return doEndTurn(state, slot);
    default:
      return fail("unknown_action");
  }
}

/**
 * Updates each player's memory of tile ownership for everything they can
 * currently see. Mutates in place - only ever called on an already-cloned
 * state, like the other end-of-action helpers here.
 */
function refreshKnownTiles(state: MatchState): void {
  for (const player of state.players) {
    if (!Array.isArray(player.knownTileOwners)
        || player.knownTileOwners.length !== state.map.tiles.length) {
      player.knownTileOwners = new Array(state.map.tiles.length).fill(0);
    }
    for (const index of visibleTiles(state, player.slot)) {
      player.knownTileOwners[index] = state.map.tiles[index].ownerSlot;
    }
  }
}

function ownedActiveUnit(
  state: MatchState,
  slot: number,
  unitId: string,
): Unit | { error: string } {
  const unit = state.units[unitId];
  if (!unit) return { error: "no_such_unit" };
  if (unit.ownerSlot !== slot) return { error: "not_your_unit" };
  if (unit.hasActed) return { error: "unit_already_acted" };
  return unit;
}

/* ------------------------------------------------------------------ */
/* Individual actions                                                  */
/* ------------------------------------------------------------------ */

function doMove(state: MatchState, slot: number, unitId: string, path: Vec2[]): ActionResult {
  const found = ownedActiveUnit(state, slot, unitId);
  if ("error" in found) return fail(found.error);
  if (found.hasMoved) return fail("unit_already_moved");

  const check = validatePath(state, found, path);
  if (!check.ok) return fail(check.reason ?? "illegal_path");

  const next = clone(state);
  const unit = next.units[unitId];
  const from: Vec2 = { x: unit.x, y: unit.y };
  // The walked path, not the submitted one - an ambush stops the unit short.
  const walked = check.path;
  const to: Vec2 = walked.length > 0 ? walked[walked.length - 1] : from;

  unit.x = to.x;
  unit.y = to.y;
  unit.fuel = Math.max(0, unit.fuel - check.cost);
  unit.hasMoved = true;
  // Moving off a tile abandons any capture in progress on it.
  if (check.cost > 0) unit.captureProgress = 0;
  next.version += 1;

  return {
    ok: true,
    state: next,
    events: [{
      type: "unitMoved", unitId, ownerSlot: unit.ownerSlot,
      from, to, path: walked, fuelSpent: check.cost,
    }],
  };
}

function doAttack(
  state: MatchState,
  slot: number,
  unitId: string,
  targetUnitId: string,
): ActionResult {
  const found = ownedActiveUnit(state, slot, unitId);
  if ("error" in found) return fail(found.error);

  const target = state.units[targetUnitId];
  // One reason for "not there" and "cannot see it", so a rejection cannot be
  // used to check whether a remembered unit is still alive, or to shell a
  // tile the player has no eyes on. Artillery outranges its own vision and
  // needs a spotter, which is the point of having scouts.
  if (!target || !isVisibleTo(state, slot, target.x, target.y)) return fail("no_such_target");
  if (target.ownerSlot === slot) return fail("cannot_attack_own_unit");

  const stats = unitStats(found.unitType);
  if (!stats) return fail("unknown_unit_type");
  // Indirect-fire units may not move and shoot in the same turn.
  if (stats.fire_mode === "indirect" && found.hasMoved) return fail("indirect_cannot_move_and_fire");
  if (!canEngage(state, found, target)) return fail("target_out_of_range_or_immune");

  const next = clone(state);
  const attacker = next.units[unitId];
  const defender = next.units[targetUnitId];
  const outcome = resolveCombat(next, attacker, defender);
  next.rngCounter = outcome.rngCounter;

  const events: GameEvent[] = [];
  defender.hp -= outcome.damage;
  if (attacker.ammo !== null) attacker.ammo = Math.max(0, attacker.ammo - 1);

  if (defender.hp <= 0) {
    events.push({
      type: "unitAttacked",
      attackerId: unitId,
      defenderId: targetUnitId,
      attackerSlot: attacker.ownerSlot,
      defenderSlot: defender.ownerSlot,
      damage: outcome.damage,
      counterDamage: 0,
    });
    events.push({
      type: "unitDestroyed", unitId: targetUnitId, ownerSlot: defender.ownerSlot,
      at: { x: defender.x, y: defender.y },
    });
    delete next.units[targetUnitId];
  } else {
    attacker.hp -= outcome.counterDamage;
    if (outcome.counterDamage > 0 && defender.ammo !== null) {
      defender.ammo = Math.max(0, defender.ammo - 1);
    }
    events.push({
      type: "unitAttacked",
      attackerId: unitId,
      defenderId: targetUnitId,
      attackerSlot: attacker.ownerSlot,
      defenderSlot: defender.ownerSlot,
      damage: outcome.damage,
      counterDamage: outcome.counterDamage,
    });
    if (attacker.hp <= 0) {
      events.push({
        type: "unitDestroyed", unitId, ownerSlot: attacker.ownerSlot,
        at: { x: attacker.x, y: attacker.y },
      });
      delete next.units[unitId];
    }
  }

  if (next.units[unitId]) {
    next.units[unitId].hasMoved = true;
    next.units[unitId].hasActed = true;
  }
  next.version += 1;

  events.push(...checkDefeats(next));
  return { ok: true, state: next, events };
}

function doCapture(state: MatchState, slot: number, unitId: string): ActionResult {
  const found = ownedActiveUnit(state, slot, unitId);
  if ("error" in found) return fail(found.error);

  const stats = unitStats(found.unitType);
  if (!stats?.can_capture) return fail("unit_cannot_capture");

  const tile = tileAt(state.map, found.x, found.y);
  const terrain = tile ? terrainStats(tile.terrain) : undefined;
  if (!tile || !terrain) return fail("no_such_tile");
  if (!terrain.capturable) return fail("tile_not_capturable");
  if (tile.ownerSlot === slot) return fail("tile_already_yours");

  const next = clone(state);
  const unit = next.units[unitId];
  const nextTile = tileAt(next.map, unit.x, unit.y)!;

  // Capture speed scales with the unit's health, so a damaged infantry is
  // slower to take a building.
  unit.captureProgress += displayHp(unit.hp);
  unit.hasMoved = true;
  unit.hasActed = true;

  const events: GameEvent[] = [];
  if (unit.captureProgress >= CAPTURE_THRESHOLD) {
    unit.captureProgress = 0;
    nextTile.ownerSlot = slot;
    events.push({ type: "tileCaptured", x: unit.x, y: unit.y, bySlot: slot });
  } else {
    events.push({
      type: "captureProgressed", unitId, ownerSlot: unit.ownerSlot,
      progress: unit.captureProgress,
    });
  }
  next.version += 1;

  events.push(...checkDefeats(next));
  return { ok: true, state: next, events };
}

function buildCost(state: MatchState, slot: number, unitType: string): number {
  const stats = unitStats(unitType);
  if (!stats) return Infinity;
  const faction = FACTIONS[state.players.find((p) => p.slot === slot)?.faction ?? ""];
  const perUnit = faction?.modifiers.cost_pct?.[unitType] ?? 0;
  const global = faction?.modifiers.global_cost_pct ?? 0;
  return Math.round(stats.cost * (1 + (perUnit + global) / 100));
}

function doBuild(state: MatchState, slot: number, unitType: string, at: Vec2): ActionResult {
  const stats = unitStats(unitType);
  if (!stats) return fail("unknown_unit_type");

  const tile = tileAt(state.map, at.x, at.y);
  const terrain = tile ? terrainStats(tile.terrain) : undefined;
  if (!tile || !terrain) return fail("no_such_tile");
  if (!terrain.builds) return fail("tile_does_not_build");
  if (tile.ownerSlot !== slot) return fail("tile_not_yours");
  if (!stats.built_at.includes(tile.terrain)) return fail("wrong_production_building");
  if (unitAt(state, at.x, at.y)) return fail("tile_occupied");

  const player = state.players.find((p) => p.slot === slot)!;
  const cost = buildCost(state, slot, unitType);
  if (player.funds < cost) return fail("insufficient_funds");

  const next = clone(state);
  const unit = spawnUnit(next, unitType, slot, at)!;
  // A freshly built unit cannot act until the following turn.
  unit.hasMoved = true;
  unit.hasActed = true;
  next.units[unit.id] = unit;
  next.players.find((p) => p.slot === slot)!.funds -= cost;
  next.version += 1;

  return {
    ok: true,
    state: next,
    events: [{ type: "unitBuilt", unitId: unit.id, unitType, bySlot: slot, at, cost }],
  };
}

function doWait(state: MatchState, slot: number, unitId: string): ActionResult {
  const found = ownedActiveUnit(state, slot, unitId);
  if ("error" in found) return fail(found.error);

  const next = clone(state);
  next.units[unitId].hasMoved = true;
  next.units[unitId].hasActed = true;
  next.version += 1;
  return { ok: true, state: next, events: [] };
}

/* ------------------------------------------------------------------ */
/* Turn flow                                                           */
/* ------------------------------------------------------------------ */

function doEndTurn(state: MatchState, slot: number): ActionResult {
  const next = clone(state);
  const order = next.players.filter((p) => !p.defeated).map((p) => p.slot).sort((a, b) => a - b);
  if (order.length === 0) return fail("no_active_players");

  const currentIndex = order.indexOf(slot);
  const nextIndex = (currentIndex + 1) % order.length;
  // A full pass through the turn order is one round.
  if (nextIndex <= currentIndex) next.roundNumber += 1;
  next.currentSlot = order[nextIndex];
  next.version += 1;

  const events = beginTurn(next, next.currentSlot);
  events.push(...checkDefeats(next));
  return { ok: true, state: next, events };
}

/**
 * Start-of-turn upkeep for `slot`: income, repair and resupply on owned
 * buildings, fuel drain for air and sea units, and clearing the acted flags.
 * Mutates `state` in place - only ever called on an already-cloned state.
 */
function beginTurn(state: MatchState, slot: number): GameEvent[] {
  const player = state.players.find((p) => p.slot === slot);
  if (!player) return [];

  let income = 0;
  for (const tile of state.map.tiles) {
    if (tile.ownerSlot === slot) income += terrainStats(tile.terrain)?.income ?? 0;
  }
  player.funds += income;

  const events: GameEvent[] = [];

  for (const unit of Object.values(state.units)) {
    if (unit.ownerSlot !== slot) continue;
    unit.hasMoved = false;
    unit.hasActed = false;

    const stats = unitStats(unit.unitType);
    if (!stats) continue;

    const tile = tileAt(state.map, unit.x, unit.y);
    const terrain = tile ? terrainStats(tile.terrain) : undefined;
    const onFriendlyRepairTile =
      !!tile && tile.ownerSlot === slot && !!terrain?.repairs.includes(stats.move_type);

    if (onFriendlyRepairTile) {
      unit.hp = Math.min(100, unit.hp + REPAIR_HP_PER_TURN);
      unit.fuel = stats.max_fuel;
      unit.ammo = stats.max_ammo;
    } else {
      const drain = FUEL_DRAIN_PER_TURN[stats.move_type] ?? 0;
      unit.fuel = Math.max(0, unit.fuel - drain);
      // Air and sea units that run dry are lost.
      if (drain > 0 && unit.fuel === 0) {
        events.push({
          type: "unitDestroyed", unitId: unit.id, ownerSlot: unit.ownerSlot,
          at: { x: unit.x, y: unit.y },
        });
        delete state.units[unit.id];
      }
    }
  }

  events.unshift({ type: "turnStarted", slot, roundNumber: state.roundNumber, income });
  return events;
}

/* ------------------------------------------------------------------ */
/* Win conditions                                                      */
/* ------------------------------------------------------------------ */

/** Mutates `state` in place - only ever called on an already-cloned state. */
function checkDefeats(state: MatchState): GameEvent[] {
  const events: GameEvent[] = [];

  for (const player of state.players) {
    if (player.defeated) continue;

    const hqTile = state.map.tiles.find(
      (t) => terrainStats(t.terrain)?.is_hq && t.ownerSlot === player.slot,
    );
    if (!hqTile) {
      player.defeated = true;
      events.push({ type: "playerDefeated", slot: player.slot, reason: "hq_captured" });
      continue;
    }

    const hasUnits = Object.values(state.units).some((u) => u.ownerSlot === player.slot);
    const hasProduction = state.map.tiles.some(
      (t) => t.ownerSlot === player.slot && terrainStats(t.terrain)?.builds,
    );
    // Losing every unit is only fatal if you also cannot build another.
    if (!hasUnits && !hasProduction) {
      player.defeated = true;
      events.push({ type: "playerDefeated", slot: player.slot, reason: "no_units" });
    }
  }

  const alive = state.players.filter((p) => !p.defeated);
  if (state.phase === "active" && state.players.length >= 2 && alive.length <= 1) {
    state.phase = "finished";
    state.winnerSlot = alive[0]?.slot ?? null;
    events.push({ type: "matchFinished", winnerSlot: state.winnerSlot });
  }

  return events;
}
