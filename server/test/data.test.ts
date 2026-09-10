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
