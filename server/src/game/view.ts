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
    /** Terrain is public knowledge. */
    terrain: string[];
    /** Ownership as far as this player has seen it - not the live grid. */
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
  const viewer = state.players.find((p) => p.slot === slot);

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
      // What this player has seen, not what is true right now. Sending the
      // live grid would undo the fog: a building changing hands in the dark
      // pinpoints the enemy infantry that took it. The fallback covers
      // matches saved before ownership was remembered per player.
      tileOwners: viewer?.knownTileOwners?.length === state.map.tiles.length
        ? [...viewer.knownTileOwners]
        : state.map.tiles.map((t) => t.ownerSlot),
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
 * Events are redacted per player, not merely filtered.
 *
 * Filtering alone is not enough, because several events carry information
 * the view itself withholds: a move's full path (including a destination in
 * fog), the opponent's income (from which their hidden funds follow exactly),
 * and what was built where. Each of those is cut down here rather than
 * dropped, so the player learns what they saw and nothing more.
 *
 * Ownership is read off the event rather than looked up in the state,
 * because this runs against the state *after* the action - where a unit that
 * just died no longer exists, and a lookup would silently drop every event
 * about it, including from the player who owned it.
 */
export function filterEventsFor(
  state: MatchState,
  slot: number,
  events: import("./types").GameEvent[],
): import("./types").GameEvent[] {
  const visible = visibleTiles(state, slot);
  const width = state.map.width;
  const seen = (x: number, y: number) => visible.has(y * width + x);
  const out: import("./types").GameEvent[] = [];

  for (const event of events) {
    switch (event.type) {
      case "unitMoved": {
        if (event.ownerSlot === slot) {
          out.push(event);
          break;
        }
        // Only the tiles actually watched. A route that ducks into fog ends,
        // for this player, where they lost sight of it.
        const watched = event.path.filter((p) => seen(p.x, p.y));
        if (watched.length === 0 && !seen(event.from.x, event.from.y)) break;
        out.push({
          ...event,
          path: watched,
          to: watched.length > 0 ? watched[watched.length - 1] : event.from,
        });
        break;
      }

      case "unitAttacked":
        // In a two-player match every fight involves the viewer; with teams
        // it would not, and a fight between two others is not their business.
        if (event.attackerSlot === slot || event.defenderSlot === slot) out.push(event);
        break;

      case "unitDestroyed":
        if (event.ownerSlot === slot || seen(event.at.x, event.at.y)) out.push(event);
        break;

      case "captureProgressed":
        if (event.ownerSlot === slot) out.push(event);
        break;

      case "tileCaptured":
        // A capture in fog would otherwise pinpoint an enemy infantry.
        if (event.bySlot === slot || seen(event.x, event.y)) out.push(event);
        break;

      case "unitBuilt":
        if (event.bySlot === slot || seen(event.at.x, event.at.y)) out.push(event);
        break;

      case "turnStarted":
        // Income is the opponent's building count, and their funds follow
        // from it exactly - which the view goes to the trouble of hiding.
        out.push(event.slot === slot ? event : { ...event, income: null });
        break;

      default:
        // Defeats and the end of the match are public by nature.
        out.push(event);
        break;
    }
  }

  return out;
}
