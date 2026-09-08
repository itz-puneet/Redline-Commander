/**
 * Loads the canonical data tables from /shared/data.
 *
 * The Godot client reads byte-identical copies of these files from
 * res://data (kept in sync by tools/sync-shared-data.sh, verified by
 * `npm run verify:data`). There is exactly one place a unit's move cost or
 * a damage number is written down, and it is not in code.
 */

import fs from "fs";
import path from "path";
import type { GameMap, MoveType, TerrainStats, Tile, UnitStats, Vec2 } from "./types";

/**
 * Walks up from this module until it finds /shared/data, so the same code
 * works whether it is running from src/ under ts-node or from build/ after
 * tsc, and regardless of the process working directory.
 */
function findSharedDataDir(): string {
  if (process.env.REDLINE_DATA_DIR) return process.env.REDLINE_DATA_DIR;
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, "shared", "data");
    if (fs.existsSync(path.join(candidate, "units.json"))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    "could not locate shared/data - set REDLINE_DATA_DIR to the repo's shared/data directory",
  );
}

const SHARED_DATA_DIR = findSharedDataDir();

function readJson<T>(...segments: string[]): T {
  const file = path.join(SHARED_DATA_DIR, ...segments);
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

export const UNITS: Record<string, UnitStats> =
  readJson<{ units: Record<string, UnitStats> }>("units.json").units;

export const TERRAIN: Record<string, TerrainStats> =
  readJson<{ terrain: Record<string, TerrainStats> }>("terrain.json").terrain;

export const DAMAGE_MATRIX: Record<string, Record<string, number>> =
  readJson<{ matrix: Record<string, Record<string, number>> }>("damage_matrix.json").matrix;

export interface FactionData {
  display_name: string;
  summary: string;
  modifiers: {
    cost_pct?: Record<string, number>;
    terrain_defense_bonus_pct?: Record<string, number>;
    vision_bonus?: number;
    global_cost_pct?: number;
    global_attack_pct?: number;
  };
  directive: { id: string; display_name: string; charge_cost: number; effect: Record<string, number> };
}

export const FACTIONS: Record<string, FactionData> =
  readJson<{ factions: Record<string, FactionData> }>("factions.json").factions;

export function unitStats(unitType: string): UnitStats | undefined {
  return UNITS[unitType];
}

export function terrainStats(terrainId: string): TerrainStats | undefined {
  return TERRAIN[terrainId];
}

/* ------------------------------------------------------------------ */
/* Maps                                                                */
/* ------------------------------------------------------------------ */

interface MapFile {
  id: string;
  display_name: string;
  width: number;
  height: number;
  _legend: Record<string, string>;
  tiles: string[];
  tile_owners: string[];
  start_units: { slot: number; unit_type: string; x: number; y: number }[];
}

export interface LoadedMap {
  map: GameMap;
  startUnits: { slot: number; unitType: string; at: Vec2 }[];
}

export function loadMap(mapId: string): LoadedMap {
  const raw = readJson<MapFile>("maps", `${mapId}.json`);

  if (raw.tiles.length !== raw.height) {
    throw new Error(`map ${mapId}: expected ${raw.height} rows, got ${raw.tiles.length}`);
  }

  const tiles: Tile[] = [];
  for (let y = 0; y < raw.height; y++) {
    const row = raw.tiles[y];
    const owners = raw.tile_owners[y];
    if (row.length !== raw.width) {
      throw new Error(`map ${mapId}: row ${y} has width ${row.length}, expected ${raw.width}`);
    }
    for (let x = 0; x < raw.width; x++) {
      const terrain = raw._legend[row[x]];
      if (!terrain || !TERRAIN[terrain]) {
        throw new Error(`map ${mapId}: unknown terrain glyph '${row[x]}' at ${x},${y}`);
      }
      const ownerSlot = owners ? Number(owners[x]) || 0 : 0;
      if (ownerSlot !== 0 && !TERRAIN[terrain].capturable) {
        throw new Error(`map ${mapId}: tile ${x},${y} (${terrain}) is owned but not capturable`);
      }
      tiles.push({ terrain, ownerSlot });
    }
  }

  return {
    map: { id: raw.id, displayName: raw.display_name, width: raw.width, height: raw.height, tiles },
    startUnits: raw.start_units.map((u) => ({
      slot: u.slot,
      unitType: u.unit_type,
      at: { x: u.x, y: u.y },
    })),
  };
}

export function tileAt(map: GameMap, x: number, y: number): Tile | undefined {
  if (x < 0 || y < 0 || x >= map.width || y >= map.height) return undefined;
  return map.tiles[y * map.width + x];
}

export function moveCost(terrainId: string, moveType: MoveType): number | null {
  return TERRAIN[terrainId]?.move_cost[moveType] ?? null;
}
