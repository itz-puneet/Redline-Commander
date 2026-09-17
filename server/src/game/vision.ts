/**
 * Fog of war.
 *
 * This exists because "broadcast the whole state to everybody" and "the game
 * has fog of war" cannot both be true. A modified client that receives the
 * full state sees through the fog no matter what its UI draws, so the server
 * must build a separate, filtered payload per player.
 */

import { FACTIONS, directiveEffect, tileAt, unitStats } from "./data";
import { chebyshev } from "./movement";
import type { MatchState, Unit } from "./types";

function visionRadius(state: MatchState, unit: Unit): number {
  const stats = unitStats(unit.unitType);
  if (!stats) return 0;

  const faction = FACTIONS[
    state.players.find((p) => p.slot === unit.ownerSlot)?.faction ?? "crimson_alliance"
  ];
  const bonus = faction?.modifiers.vision_bonus ?? 0;

  // Blackout is an *enemy* directive that blinds this unit, so it is read
  // off the other players, not this one.
  let jamming = 0;
  for (const other of state.players) {
    if (other.slot === unit.ownerSlot) continue;
    jamming = Math.max(
      jamming, directiveEffect(other.faction, other.activeDirective, "enemy_vision_penalty"));
  }

  // Standing on a capturable building acts as a lookout post.
  const tile = tileAt(state.map, unit.x, unit.y);
  const buildingBonus = tile && tile.ownerSlot === unit.ownerSlot ? 1 : 0;

  // Never below 1: a blinded unit still sees the tile it is standing on.
  return Math.max(1, stats.vision + bonus + buildingBonus - jamming);
}

/** Tile indices (y * width + x) currently visible to `slot`. */
export function visibleTiles(state: MatchState, slot: number): Set<number> {
  const visible = new Set<number>();
  const { width, height } = state.map;

  // Uplink lifts the fog for its owner. Done here rather than by special-
  // casing the view, so everything downstream - the payload, event
  // redaction, what artillery is allowed to shoot at - agrees about what
  // this player can see, and goes back to agreeing when it lapses.
  const viewer = state.players.find((p) => p.slot === slot);
  if (viewer && directiveEffect(viewer.faction, viewer.activeDirective, "reveal_map_turns") > 0) {
    for (let i = 0; i < state.map.tiles.length; i++) visible.add(i);
    return visible;
  }

  for (const unit of Object.values(state.units)) {
    if (unit.ownerSlot !== slot) continue;
    // Cargo sees nothing from inside the hold, and must not extend the
    // transport's own vision by sitting on its coordinates.
    if (unit.carriedBy !== null) continue;
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
