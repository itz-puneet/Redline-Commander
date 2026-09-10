/**
 * Checks on the shared data tables themselves.
 *
 * These exist because the lookups that read them fail *quietly*. In
 * particular:
 *
 *   baseDamage(a, d) => DAMAGE_MATRIX[a]?.[d] ?? 0
 *
 * and canEngage() treats a base damage of 0 as "this unit cannot attack
 * that one". So a unit added to units.json but missed in the matrix can
 * neither attack nor be attacked, anywhere, with nothing logged - it simply
 * stands on the board and does nothing. That is a data mistake the engine
 * cannot distinguish from a deliberate immunity, so it has to be caught
 * here instead.
 *
 * Verified by mutation: deleting any single defender entry from the matrix,
 * or adding a unit to units.json without a matrix row, turns these red.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { DAMAGE_MATRIX, MAP_INDEX, TERRAIN, UNITS, loadMap } from "../src/game/data";

const unitTypes = Object.keys(UNITS);
const attackers = unitTypes.filter((type) => UNITS[type].fire_mode !== null);
const passive = unitTypes.filter((type) => UNITS[type].fire_mode === null);

test("every unit that can shoot has a row in the damage matrix", () => {
  const missing = attackers.filter((type) => !DAMAGE_MATRIX[type]);
  assert.deepEqual(missing, [], `no damage row for: ${missing.join(", ")}`);
});

test("a unit that cannot shoot has no row, so the table cannot lie", () => {
  const spurious = passive.filter((type) => DAMAGE_MATRIX[type]);
  assert.deepEqual(
    spurious,
    [],
    `these have damage rows but no fire_mode, so the numbers are never read: ${spurious.join(", ")}`,
  );
});

test("every row covers every unit type as a defender", () => {
  const holes: string[] = [];
  for (const attacker of Object.keys(DAMAGE_MATRIX)) {
    for (const defender of unitTypes) {
      if (typeof DAMAGE_MATRIX[attacker][defender] !== "number") {
        holes.push(`${attacker} -> ${defender}`);
      }
    }
  }
  assert.deepEqual(holes, [], `missing damage entries: ${holes.join(", ")}`);
});

test("the matrix names no unit that does not exist", () => {
  const unknown: string[] = [];
  for (const [attacker, row] of Object.entries(DAMAGE_MATRIX)) {
    if (!UNITS[attacker]) unknown.push(attacker);
    for (const defender of Object.keys(row)) {
      if (!UNITS[defender]) unknown.push(`${attacker} -> ${defender}`);
    }
  }
  assert.deepEqual(unknown, [], `matrix refers to unknown units: ${unknown.join(", ")}`);
});

test("damage values are percentages in a sane range", () => {
  const odd: string[] = [];
  for (const [attacker, row] of Object.entries(DAMAGE_MATRIX)) {
    for (const [defender, value] of Object.entries(row)) {
      if (!Number.isInteger(value) || value < 0 || value > 150) {
        odd.push(`${attacker} -> ${defender} = ${value}`);
      }
    }
  }
  assert.deepEqual(odd, [], `out of range: ${odd.join(", ")}`);
});

test("every unit can be attacked by something", () => {
  // A unit nothing can damage wins by default. This is the same hole read
  // from the other side: a new unit added as a defender column of all
  // zeroes would pass the completeness checks above.
  const invulnerable = unitTypes.filter((defender) =>
    Object.values(DAMAGE_MATRIX).every((row) => (row[defender] ?? 0) <= 0),
  );
  assert.deepEqual(invulnerable, [], `nothing can damage: ${invulnerable.join(", ")}`);
});

test("every unit can be built somewhere that exists", () => {
  const broken: string[] = [];
  for (const [type, stats] of Object.entries(UNITS)) {
    if (!stats.built_at.length) broken.push(`${type}: built nowhere`);
    for (const terrain of stats.built_at) {
      if (!TERRAIN[terrain]) broken.push(`${type}: built at unknown terrain '${terrain}'`);
      else if (!TERRAIN[terrain].capturable) broken.push(`${type}: built at unownable '${terrain}'`);
    }
  }
  assert.deepEqual(broken, [], broken.join("; "));
});

test("indirect units cannot fire at range 1, direct units can", () => {
  // The distinction the whole combat model rests on: indirect fire cannot
  // be counterattacked because it never stands adjacent.
  const wrong: string[] = [];
  for (const [type, stats] of Object.entries(UNITS)) {
    if (stats.fire_mode === "indirect" && stats.min_range <= 1) {
      wrong.push(`${type} is indirect but reaches range 1`);
    }
    if (stats.fire_mode === "direct" && stats.max_range !== 1) {
      wrong.push(`${type} is direct but reaches range ${stats.max_range}`);
    }
    if (stats.fire_mode !== null && stats.max_range < stats.min_range) {
      wrong.push(`${type} has max_range below min_range`);
    }
  }
  assert.deepEqual(wrong, [], wrong.join("; "));
});

/* ------------------------------------------------------------------ */
/* Maps                                                                */
/* ------------------------------------------------------------------ */

/**
 * loadMap already rejects a map with the wrong dimensions or an unknown
 * terrain glyph. What it cannot tell is whether the map is *playable* - and
 * a map that loads cleanly but cannot be won is a much quieter failure.
 *
 * The naval map was written with the two coasts unconnected on foot. Since
 * transport load/unload is not implemented, no unit could ever have reached
 * the enemy HQ, so the only way to win would have been to destroy every
 * enemy unit. Nothing would have reported that; the map would simply have
 * played wrong.
 */
for (const entry of MAP_INDEX) {
  const { map, startUnits } = loadMap(entry.id);
  const at = (x: number, y: number) => map.tiles[y * map.width + x];

  test(`${entry.id}: the index agrees with the map file`, () => {
    assert.equal(map.width * map.height, map.tiles.length);
    assert.equal(entry.size, `${map.width}x${map.height}`);
    assert.equal(entry.display_name, map.displayName);
  });

  test(`${entry.id}: every declared player has an HQ, and no one else does`, () => {
    const hqSlots = map.tiles
      .filter((tile) => TERRAIN[tile.terrain].is_hq)
      .map((tile) => tile.ownerSlot)
      .sort();
    const expected = Array.from({ length: entry.max_players }, (_, i) => i + 1);
    assert.deepEqual(hqSlots, expected);
  });

  test(`${entry.id}: every HQ can be reached on foot from every other`, () => {
    const hqs: { x: number; y: number }[] = [];
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        if (TERRAIN[at(x, y).terrain].is_hq) hqs.push({ x, y });
      }
    }
    assert.ok(hqs.length > 0, "no HQ on the map");

    const seen = new Set<string>([`${hqs[0].x},${hqs[0].y}`]);
    const queue = [hqs[0]];
    while (queue.length) {
      const { x, y } = queue.pop()!;
      for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
        if (nx < 0 || ny < 0 || nx >= map.width || ny >= map.height) continue;
        const key = `${nx},${ny}`;
        if (seen.has(key)) continue;
        if (TERRAIN[at(nx, ny).terrain].move_cost.foot === null) continue;
        seen.add(key);
        queue.push({ x: nx, y: ny });
      }
    }
    const unreachable = hqs.filter((hq) => !seen.has(`${hq.x},${hq.y}`));
    assert.deepEqual(
      unreachable,
      [],
      "an HQ no foot unit can walk to cannot be captured, and until transport " +
        "load/unload exists that makes the map unwinnable by capture",
    );
  });

  test(`${entry.id}: start units stand somewhere they could have moved to`, () => {
    const problems: string[] = [];
    const occupied = new Set<string>();
    for (const unit of startUnits) {
      const { x, y } = unit.at;
      if (x < 0 || y < 0 || x >= map.width || y >= map.height) {
        problems.push(`${unit.unitType} starts off the map at ${x},${y}`);
        continue;
      }
      const stats = UNITS[unit.unitType];
      if (!stats) {
        problems.push(`unknown start unit type '${unit.unitType}'`);
        continue;
      }
      if (unit.slot < 1 || unit.slot > entry.max_players) {
        problems.push(`${unit.unitType} belongs to slot ${unit.slot}`);
      }
      if (TERRAIN[at(x, y).terrain].move_cost[stats.move_type] === null) {
        problems.push(`${unit.unitType} starts on ${at(x, y).terrain} at ${x},${y}`);
      }
      const key = `${x},${y}`;
      if (occupied.has(key)) problems.push(`two units start on ${key}`);
      occupied.add(key);
    }
    assert.deepEqual(problems, [], problems.join("; "));
  });

}

test("every unit type is buildable on at least one map", () => {
  // The transport ship was in the game for months while no map had a port,
  // so it could be seen in the data and never fielded. Adding six more sea
  // and air units makes that failure six times easier to repeat, and
  // nothing else would report it.
  const buildable = new Set<string>();
  for (const entry of MAP_INDEX) {
    for (const tile of loadMap(entry.id).map.tiles) {
      for (const [type, stats] of Object.entries(UNITS)) {
        if (stats.built_at.includes(tile.terrain)) buildable.add(type);
      }
    }
  }
  const unbuildable = Object.keys(UNITS).filter((type) => !buildable.has(type));
  assert.deepEqual(
    unbuildable,
    [],
    `no map has a building that produces: ${unbuildable.join(", ")}`,
  );
});

/* ------------------------------------------------------------------ */
/* Water, shore and naval obstacles                                    */
/* ------------------------------------------------------------------ */

/**
 * Water depth is not decoration - it is what tells a player where a ship
 * can go and where the shoreline is. These assert the rules the maps are
 * authored against, so a hand-edited map that scatters deep water against
 * a beach or drops a reef on a shore fails here rather than shipping.
 *
 * The reef rules matter twice over: a reef is impassable to naval units, so
 * a misplaced one silently walls off part of the sea.
 */

const WATER = new Set(["shallow_water", "deep_water", "reef"]);

function neighbours4(x: number, y: number, width: number, height: number) {
  return ([[1, 0], [-1, 0], [0, 1], [0, -1]] as const)
    .map(([dx, dy]) => ({ x: x + dx, y: y + dy }))
    .filter((p) => p.x >= 0 && p.y >= 0 && p.x < width && p.y < height);
}

test("reef is impassable to naval units", () => {
  // The whole obstacle behaviour rests on this single data fact: movement
  // treats a null cost as impassable, so reachableTiles and validatePath
  // both refuse it without needing to know what a reef is.
  assert.equal(TERRAIN.reef.move_cost.sea, null);
  assert.notEqual(TERRAIN.shallow_water.move_cost.sea, null);
  assert.notEqual(TERRAIN.deep_water.move_cost.sea, null);
});

for (const entry of MAP_INDEX) {
  const { map } = loadMap(entry.id);
  const at = (x: number, y: number) => map.tiles[y * map.width + x];
  const waterTiles: { x: number; y: number; terrain: string }[] = [];
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      if (WATER.has(at(x, y).terrain)) waterTiles.push({ x, y, terrain: at(x, y).terrain });
    }
  }
  const touchesLand = (x: number, y: number) =>
    neighbours4(x, y, map.width, map.height).some((p) => !WATER.has(at(p.x, p.y).terrain));

  test(`${entry.id}: water touching land is shallow, water away from land is not`, () => {
    const deepOnShore = waterTiles
      .filter((t) => t.terrain === "deep_water" && touchesLand(t.x, t.y))
      .map((t) => `${t.x},${t.y}`);
    const shallowAdrift = waterTiles
      .filter((t) => t.terrain === "shallow_water" && !touchesLand(t.x, t.y))
      .map((t) => `${t.x},${t.y}`);
    assert.deepEqual(deepOnShore, [], `deep water against a shore at: ${deepOnShore.join(" ")}`);
    assert.deepEqual(
      shallowAdrift,
      [],
      `shallow water stranded in open sea at: ${shallowAdrift.join(" ")}`,
    );
  });

  test(`${entry.id}: reefs sit in open water, never against a shore`, () => {
    const onShore = waterTiles
      .filter((t) => t.terrain === "reef" && touchesLand(t.x, t.y))
      .map((t) => `${t.x},${t.y}`);
    assert.deepEqual(onShore, [], `reef against a shore at: ${onShore.join(" ")}`);
  });

  test(`${entry.id}: every port can reach every other port by sea`, () => {
    // With reef impassable, a badly placed one can cut the sea in two, or a
    // port can end up inland - either way a ship built there is stranded and
    // nothing else would report it. This is how the straits map was found
    // with all four of its ports landlocked.
    const navigable = (x: number, y: number) =>
      TERRAIN[at(x, y).terrain].move_cost.sea !== null;
    const ports: string[] = [];
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        if (at(x, y).terrain === "port") ports.push(`${x},${y}`);
      }
    }
    if (ports.length === 0) return; // a land map has nothing to check

    const start = ports[0].split(",").map(Number);
    const seen = new Set<string>([ports[0]]);
    const queue = [{ x: start[0], y: start[1] }];
    while (queue.length) {
      const cur = queue.pop()!;
      for (const p of neighbours4(cur.x, cur.y, map.width, map.height)) {
        const key = `${p.x},${p.y}`;
        if (seen.has(key) || !navigable(p.x, p.y)) continue;
        seen.add(key);
        queue.push(p);
      }
    }
    const stranded = ports.filter((p) => !seen.has(p));
    assert.deepEqual(stranded, [], `ports unreachable by sea from ${ports[0]}: ${stranded.join(" ")}`);
  });

  test(`${entry.id}: no road tile is left floating`, () => {
    // A road with nothing to join reads as a stray strip of tarmac in a
    // field, and it is the map that is wrong, not the art - no tile can be
    // drawn that makes a one-tile road look deliberate. Buildings count:
    // a road running up to a city has arrived somewhere. So does the map
    // edge, since a road leaving the board is not a dead end.
    //
    // Kept in step with TerrainTileSet.ROAD_CONNECTS in
    // client/scripts/board/terrain_tileset.gd, which chooses the tile from
    // exactly this relation. Found four such stubs in `crossing`.
    const joins = (x: number, y: number) =>
      x < 0 || y < 0 || x >= map.width || y >= map.height ||
      at(x, y).terrain === "road" || TERRAIN[at(x, y).terrain].capturable === true;
    const floating: string[] = [];
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        if (at(x, y).terrain !== "road") continue;
        if (!joins(x, y - 1) && !joins(x + 1, y) && !joins(x, y + 1) && !joins(x - 1, y)) {
          floating.push(`${x},${y}`);
        }
      }
    }
    assert.deepEqual(floating, [], `road tiles with nothing to connect to: ${floating.join(" ")}`);
  });
}
