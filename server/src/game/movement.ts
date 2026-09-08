/**
 * Movement range and path validation.
 *
 * The client runs an equivalent preview of this (client/scripts/rules/
 * movement_preview.gd) purely to draw the blue overlay. This module is the
 * only version that decides anything: a client path is re-walked step by
 * step here and rejected if it does not add up.
 */

import { moveCost, tileAt, unitStats } from "./data";
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
}

/**
 * Re-walks a client-supplied path. Never trust the client's own cost: this
 * checks adjacency, terrain passability, enemy blocking, the destination
 * being free, and the total against move points AND fuel.
 */
export function validatePath(state: MatchState, unit: Unit, path: Vec2[]): PathCheck {
  const stats = unitStats(unit.unitType);
  if (!stats) return { ok: false, reason: "unknown_unit_type", cost: 0 };
  if (path.length === 0) return { ok: true, cost: 0 };

  const budget = Math.min(stats.move, unit.fuel);
  let cost = 0;
  let prev: Vec2 = { x: unit.x, y: unit.y };

  for (const step of path) {
    const dx = Math.abs(step.x - prev.x);
    const dy = Math.abs(step.y - prev.y);
    if (dx + dy !== 1) return { ok: false, reason: "path_not_contiguous", cost };

    const tile = tileAt(state.map, step.x, step.y);
    if (!tile) return { ok: false, reason: "path_off_map", cost };

    const stepCost = moveCost(tile.terrain, stats.move_type);
    if (stepCost === null) return { ok: false, reason: "impassable_terrain", cost };

    const blocker = unitAt(state, step.x, step.y);
    if (blocker && blocker.ownerSlot !== unit.ownerSlot && blocker.id !== unit.id) {
      return { ok: false, reason: "path_blocked_by_enemy", cost };
    }

    cost += stepCost;
    if (cost > budget) return { ok: false, reason: "insufficient_movement", cost };
    prev = step;
  }

  const destOccupant = unitAt(state, prev.x, prev.y);
  if (destOccupant && destOccupant.id !== unit.id) {
    return { ok: false, reason: "destination_occupied", cost };
  }

  return { ok: true, cost };
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
