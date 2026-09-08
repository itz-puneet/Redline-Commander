/**
 * Per-player view of the match.
 *
 * This is the ONLY shape that ever goes over the wire to a client. Enemy
 * units outside the player's vision are not redacted here - they are simply
 * absent from the payload, so there is nothing to leak.
 */

import { visibleTiles } from "./vision";
import type { MatchState, Unit } from "./types";

export interface PlayerView {
  matchId: string;
  phase: MatchState["phase"];
  version: number;
  /** The slot this view was built for. */
  youSlot: number;
  currentSlot: number;
  roundNumber: number;
  winnerSlot: number | null;
  map: {
    id: string;
    displayName: string;
    width: number;
    height: number;
    /** Terrain is public knowledge; ownership and units are not. */
    terrain: string[];
    tileOwners: number[];
  };
  players: {
    slot: number;
    faction: string;
    defeated: boolean;
    connected: boolean;
    /** Only populated for the viewing player - funds are hidden information. */
    funds: number | null;
    directiveCharge: number | null;
  }[];
  /** Own units in full; enemy units only where visible, and without hidden fields. */
  units: Partial<Unit>[];
  visibleTiles: number[];
}

/** Enemy units are reported without fuel/ammo/cargo - that is not observable. */
function redactEnemy(unit: Unit): Partial<Unit> {
  return {
    id: unit.id,
    unitType: unit.unitType,
    ownerSlot: unit.ownerSlot,
    x: unit.x,
    y: unit.y,
    hp: unit.hp,
    captureProgress: unit.captureProgress,
  };
}

export function buildPlayerView(state: MatchState, slot: number): PlayerView {
  const visible = visibleTiles(state, slot);
  const width = state.map.width;

  const units: Partial<Unit>[] = [];
  for (const unit of Object.values(state.units)) {
    if (unit.ownerSlot === slot) {
      units.push({ ...unit });
    } else if (visible.has(unit.y * width + unit.x)) {
      units.push(redactEnemy(unit));
    }
  }

  return {
    matchId: state.matchId,
    phase: state.phase,
    version: state.version,
    youSlot: slot,
    currentSlot: state.currentSlot,
    roundNumber: state.roundNumber,
    winnerSlot: state.winnerSlot,
    map: {
      id: state.map.id,
      displayName: state.map.displayName,
      width: state.map.width,
      height: state.map.height,
      terrain: state.map.tiles.map((t) => t.terrain),
      tileOwners: state.map.tiles.map((t) => t.ownerSlot),
    },
    players: state.players.map((p) => ({
      slot: p.slot,
      faction: p.faction,
      defeated: p.defeated,
      connected: p.connected,
      funds: p.slot === slot ? p.funds : null,
      directiveCharge: p.slot === slot ? p.directiveCharge : null,
    })),
    units,
    visibleTiles: [...visible].sort((a, b) => a - b),
  };
}

/**
 * Events are filtered too: a player should not learn that an enemy moved
 * somewhere they cannot see. An event is delivered if any tile it touches is
 * visible to the player, or it concerns one of their own units.
 */
export function filterEventsFor(
  state: MatchState,
  slot: number,
  events: import("./types").GameEvent[],
): import("./types").GameEvent[] {
  const visible = visibleTiles(state, slot);
  const width = state.map.width;
  const seen = (x: number, y: number) => visible.has(y * width + x);
  const ownUnit = (id?: string) => (id ? state.units[id]?.ownerSlot === slot : false);

  return events.filter((event) => {
    switch (event.type) {
      case "unitMoved":
        return ownUnit(event.unitId) || event.path.some((p) => seen(p.x, p.y)) || seen(event.from.x, event.from.y);
      case "unitAttacked":
        return ownUnit(event.attackerId) || ownUnit(event.defenderId);
      case "unitDestroyed":
        return seen(event.at.x, event.at.y);
      case "captureProgressed":
        return ownUnit(event.unitId);
      default:
        // Turn changes, captures, builds, defeats and match end are public.
        return true;
    }
  });
}
