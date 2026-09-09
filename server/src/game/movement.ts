/**
 * Movement range and path validation.
 *
 * The client runs an equivalent preview of this (client/scripts/rules/
 * movement_preview.gd) purely to draw the blue overlay. This module is the
 * only version that decides anything: a client path is re-walked step by
 * step here and rejected if it does not add up.
 */

import { moveCost, tileAt, unitStats } from "./data";
import { visibleTiles } from "./vision";
import type { GameMap, MatchState, Unit, Vec2 } from "./types";

export interface ReachableTile {
  x: number;
  y: number;
  cost: number;
}

function key(x: number, y: number): string {
  return `${x},${y}`;
}

function unitAt(state: MatchState, x: number, y: number): Unit | undefined {
  return Object.values(state.units).find((u) => u.x === x && u.y === y);
}

const NEIGHBOURS: Vec2[] = [
  { x: 0, y: -1 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
];

/**
 * Dijkstra over per-terrain move costs, bounded by the lower of the unit's
 * movement points and its remaining fuel. Enemy units block movement (and
 * are not passable); friendly units may be passed through but not stopped on.
 */
export function reachableTiles(state: MatchState, unit: Unit): ReachableTile[] {
  const stats = unitStats(unit.unitType);
  if (!stats) return [];

  const budget = Math.min(stats.move, unit.fuel);
  const best = new Map<string, number>([[key(unit.x, unit.y), 0]]);
  const frontier: ReachableTile[] = [{ x: unit.x, y: unit.y, cost: 0 }];
  const out: ReachableTile[] = [];

  while (frontier.length > 0) {
    frontier.sort((a, b) => a.cost - b.cost);
    const current = frontier.shift()!;
    if (current.cost > (best.get(key(current.x, current.y)) ?? Infinity)) continue;

    const occupant = unitAt(state, current.x, current.y);
    const stoppable = !occupant || occupant.id === unit.id;
    if (stoppable) out.push(current);

    for (const step of NEIGHBOURS) {
      const nx = current.x + step.x;
      const ny = current.y + step.y;
      const tile = tileAt(state.map, nx, ny);
      if (!tile) continue;

      const blocker = unitAt(state, nx, ny);
      if (blocker && blocker.ownerSlot !== unit.ownerSlot) continue;

      const cost = moveCost(tile.terrain, stats.move_type);
      if (cost === null) continue;

      const total = current.cost + cost;
      if (total > budget) continue;
      if (total >= (best.get(key(nx, ny)) ?? Infinity)) continue;

      best.set(key(nx, ny), total);
      frontier.push({ x: nx, y: ny, cost: total });
    }
  }

  return out;
}

export interface PathCheck {
  ok: boolean;
  reason?: string;
  cost: number;
  /**
   * The path actually walked, which may be shorter than the one submitted:
   * running into a unit the mover could not see stops them short rather than
   * refusing the order. Refusing would be a free oracle - submit a move,
   * read the rejection, learn what is standing in the fog without spending
   * anything. Stopping costs the turn, which is what makes it honest.
   */
  path: Vec2[];
  /** True when the move was cut short by something unseen. */
  ambushed: boolean;
}

/**
 * Re-walks a client-supplied path. Never trust the client's own cost: this
 * checks adjacency, terrain passability, enemy blocking, the destination
 * being free, and the total against move points AND fuel.
 */
export function validatePath(state: MatchState, unit: Unit, path: Vec2[]): PathCheck {
  const stats = unitStats(unit.unitType);
  if (!stats) return { ok: false, reason: "unknown_unit_type", cost: 0, path: [], ambushed: false };
  if (path.length === 0) return { ok: true, cost: 0, path: [], ambushed: false };

  const budget = Math.min(stats.move, unit.fuel);
  const visible = visibleTiles(state, unit.ownerSlot);
  const canSee = (x: number, y: number) => visible.has(y * state.map.width + x);

  const walked: Vec2[] = [];
  const costs: number[] = [];
  let cost = 0;
  let prev: Vec2 = { x: unit.x, y: unit.y };
  let ambushed = false;

  for (const step of path) {
    const dx = Math.abs(step.x - prev.x);
    const dy = Math.abs(step.y - prev.y);
    if (dx + dy !== 1) return { ok: false, reason: "path_not_contiguous", cost, path: [], ambushed: false };

    const tile = tileAt(state.map, step.x, step.y);
    if (!tile) return { ok: false, reason: "path_off_map", cost, path: [], ambushed: false };

    const stepCost = moveCost(tile.terrain, stats.move_type);
    if (stepCost === null) {
      return { ok: false, reason: "impassable_terrain", cost, path: [], ambushed: false };
    }

    const blocker = unitAt(state, step.x, step.y);
    if (blocker && blocker.ownerSlot !== unit.ownerSlot && blocker.id !== unit.id) {
      // Something the player could already see: an illegal order, refused.
      if (canSee(step.x, step.y)) {
        return { ok: false, reason: "path_blocked_by_enemy", cost, path: [], ambushed: false };
      }
      // Something they could not: they walk into it and stop.
      ambushed = true;
      break;
    }

    cost += stepCost;
    if (cost > budget) {
      return { ok: false, reason: "insufficient_movement", cost, path: [], ambushed: false };
    }
    walked.push(step);
    costs.push(stepCost);
    prev = step;
  }

  // Back off to somewhere the unit can actually stand. After an ambush the
  // tile it stopped on may be occupied by a friend it was passing through.
  while (walked.length > 0) {
    const last = walked[walked.length - 1];
    const occupant = unitAt(state, last.x, last.y);
    if (!occupant || occupant.id === unit.id) break;
    if (!ambushed) return { ok: false, reason: "destination_occupied", cost, path: [], ambushed: false };
    walked.pop();
    cost -= costs.pop() ?? 0;
  }

  return { ok: true, cost, path: walked, ambushed };
}

/** Manhattan distance - the metric used for attack range. */
export function manhattan(a: Vec2, b: Vec2): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

/** Chebyshev distance - the metric used for vision radius. */
export function chebyshev(a: Vec2, b: Vec2): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

export function inBounds(map: GameMap, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < map.width && y < map.height;
}
