/**
 * Fog of war.
 *
 * This exists because "broadcast the whole state to everybody" and "the game
 * has fog of war" cannot both be true. A modified client that receives the
 * full state sees through the fog no matter what its UI draws, so the server
 * must build a separate, filtered payload per player.
 */

import { FACTIONS, tileAt, unitStats } from "./data";
import { chebyshev } from "./movement";
import type { MatchState, Unit } from "./types";

function visionRadius(state: MatchState, unit: Unit): number {
  const stats = unitStats(unit.unitType);
  if (!stats) return 0;

  const faction = FACTIONS[
    state.players.find((p) => p.slot === unit.ownerSlot)?.faction ?? "crimson_alliance"
  ];
  const bonus = faction?.modifiers.vision_bonus ?? 0;

  // Standing on a capturable building acts as a lookout post.
  const tile = tileAt(state.map, unit.x, unit.y);
  const buildingBonus = tile && tile.ownerSlot === unit.ownerSlot ? 1 : 0;

  return Math.max(1, stats.vision + bonus + buildingBonus);
}

/** Tile indices (y * width + x) currently visible to `slot`. */
export function visibleTiles(state: MatchState, slot: number): Set<number> {
  const visible = new Set<number>();
  const { width, height } = state.map;

  for (const unit of Object.values(state.units)) {
    if (unit.ownerSlot !== slot) continue;
    const radius = visionRadius(state, unit);
    for (let y = Math.max(0, unit.y - radius); y <= Math.min(height - 1, unit.y + radius); y++) {
      for (let x = Math.max(0, unit.x - radius); x <= Math.min(width - 1, unit.x + radius); x++) {
        if (chebyshev({ x, y }, unit) <= radius) visible.add(y * width + x);
      }
    }
  }

  // Owned buildings always see their own tile.
  for (let i = 0; i < state.map.tiles.length; i++) {
    if (state.map.tiles[i].ownerSlot === slot) visible.add(i);
  }

  return visible;
}

export function isVisibleTo(state: MatchState, slot: number, x: number, y: number): boolean {
  return visibleTiles(state, slot).has(y * state.map.width + x);
}
