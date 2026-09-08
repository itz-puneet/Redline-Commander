/**
 * Rules-engine tests.
 *
 * These run with no server, no sockets and no map editor - which is the
 * point of keeping game/ pure. If a rule needs a socket to test, it is in
 * the wrong module.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { addPlayer, applyAction, createMatch } from "../src/game/engine";
import { reachableTiles, validatePath } from "../src/game/movement";
import { baseDamage, displayHp } from "../src/game/combat";
import { buildPlayerView } from "../src/game/view";
import { visibleTiles } from "../src/game/vision";
import { UNITS, TERRAIN, DAMAGE_MATRIX, loadMap } from "../src/game/data";
import type { MatchState, Unit } from "../src/game/types";

function startedMatch(): MatchState {
  let state = createMatch({ matchId: "test", mapId: "crossing", rngSeed: 12345 });
  const p1 = addPlayer(state, "player-one", "crimson_alliance");
  assert.ok(p1.ok);
  const p2 = addPlayer(p1.state, "player-two", "azure_federation");
  assert.ok(p2.ok);
  return p2.state;
}

function unitsOf(state: MatchState, slot: number): Unit[] {
  return Object.values(state.units).filter((u) => u.ownerSlot === slot);
}

/* ------------------------------ data ------------------------------ */

test("every unit's move_type has an entry in every terrain's move_cost table", () => {
  for (const [unitId, unit] of Object.entries(UNITS)) {
    for (const [terrainId, terrain] of Object.entries(TERRAIN)) {
      assert.ok(
        unit.move_type in terrain.move_cost,
        `terrain ${terrainId} has no cost for move_type ${unit.move_type} (unit ${unitId})`,
      );
    }
  }
});

test("every armed unit has a damage row covering every unit type", () => {
  for (const [unitId, unit] of Object.entries(UNITS)) {
    if (unit.fire_mode === null) {
      assert.ok(!(unitId in DAMAGE_MATRIX), `unarmed ${unitId} should have no damage row`);
      continue;
    }
    const row = DAMAGE_MATRIX[unitId];
    assert.ok(row, `armed unit ${unitId} has no damage row`);
    for (const defender of Object.keys(UNITS)) {
      assert.equal(typeof row[defender], "number", `${unitId} -> ${defender} missing`);
    }
  }
});

test("every unit's built_at names a real production building", () => {
  for (const [unitId, unit] of Object.entries(UNITS)) {
    for (const terrainId of unit.built_at) {
      assert.ok(TERRAIN[terrainId]?.builds, `${unitId} built_at ${terrainId}, which does not build`);
    }
  }
});

test("the shipped map loads and gives each slot an HQ", () => {
  const { map } = loadMap("crossing");
  assert.equal(map.tiles.length, map.width * map.height);
  for (const slot of [1, 2]) {
    const hq = map.tiles.filter((t) => TERRAIN[t.terrain].is_hq && t.ownerSlot === slot);
    assert.equal(hq.length, 1, `slot ${slot} should start with exactly one HQ`);
  }
});

/* ---------------------------- lifecycle --------------------------- */

test("a match stays in lobby until both seats are filled", () => {
  const state = createMatch({ matchId: "m", mapId: "crossing", rngSeed: 1 });
  assert.equal(state.phase, "lobby");
  const first = addPlayer(state, "solo", "crimson_alliance");
  assert.ok(first.ok);
  assert.equal(first.state.phase, "lobby");
  assert.equal(first.state.currentSlot, 0, "no one may act while a seat is empty");

  const second = addPlayer(first.state, "other", "verdant_union");
  assert.ok(second.ok);
  assert.equal(second.state.phase, "active");
  assert.equal(second.state.currentSlot, 1);
});

test("acting out of turn is rejected", () => {
  const state = startedMatch();
  const enemyUnit = unitsOf(state, 2)[0];
  const result = applyAction(state, 2, { type: "wait", unitId: enemyUnit.id });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "not_your_turn");
});

test("roundNumber advances once per full pass, not once per player turn", () => {
  let state = startedMatch();
  assert.equal(state.roundNumber, 1);

  const afterP1 = applyAction(state, 1, { type: "endTurn" });
  assert.ok(afterP1.ok);
  assert.equal(afterP1.state.currentSlot, 2);
  assert.equal(afterP1.state.roundNumber, 1, "still round 1 - slot 2 has not played yet");

  const afterP2 = applyAction(afterP1.state, 2, { type: "endTurn" });
  assert.ok(afterP2.ok);
  assert.equal(afterP2.state.currentSlot, 1);
  assert.equal(afterP2.state.roundNumber, 2);
});

/* ---------------------------- movement ---------------------------- */

test("a client-supplied path is re-walked and rejected if it teleports", () => {
  const state = startedMatch();
  const unit = unitsOf(state, 1).find((u) => u.unitType === "light_tank")!;
  const check = validatePath(state, unit, [{ x: unit.x + 5, y: unit.y }]);
  assert.equal(check.ok, false);
  assert.equal(check.reason, "path_not_contiguous");
});

test("movement is bounded by move points and cannot exceed them", () => {
  const state = startedMatch();
  const infantry = unitsOf(state, 1).find((u) => u.unitType === "infantry")!;
  const reachable = reachableTiles(state, infantry);
  const budget = UNITS[infantry.unitType].move;
  for (const tile of reachable) {
    assert.ok(tile.cost <= budget, `tile ${tile.x},${tile.y} costs ${tile.cost} > ${budget}`);
  }
  assert.ok(reachable.length > 1, "an infantry on plains should be able to go somewhere");
});

test("treaded units cannot enter mountains", () => {
  const state = startedMatch();
  const tank = unitsOf(state, 1).find((u) => u.unitType === "light_tank")!;
  const mountains = reachableTiles(state, tank).filter((t) => {
    const tile = state.map.tiles[t.y * state.map.width + t.x];
    return tile.terrain === "mountain";
  });
  assert.equal(mountains.length, 0);
});

test("a unit that has moved may not move again in the same turn", () => {
  const state = startedMatch();
  const infantry = unitsOf(state, 1).find((u) => u.unitType === "infantry")!;
  const step = reachableTiles(state, infantry).find((t) => t.cost === 1)!;
  const moved = applyAction(state, 1, {
    type: "move",
    unitId: infantry.id,
    path: [{ x: step.x, y: step.y }],
  });
  assert.ok(moved.ok);

  const again = applyAction(moved.state, 1, {
    type: "move",
    unitId: infantry.id,
    path: [{ x: infantry.x, y: infantry.y }],
  });
  assert.equal(again.ok, false);
  assert.equal(again.ok === false && again.reason, "unit_already_moved");
});

/* ----------------------------- combat ----------------------------- */

test("infantry barely scratches a heavy tank; anti-tank infantry does not", () => {
  assert.ok(baseDamage("infantry", "heavy_tank") < 10);
  assert.ok(baseDamage("anti_tank_infantry", "heavy_tank") > 40);
});

test("fighter jets cannot engage ground targets at all", () => {
  assert.equal(baseDamage("fighter_jet", "light_tank"), 0);
  assert.ok(baseDamage("fighter_jet", "helicopter") > 0);
});

test("combat is deterministic for a given seed and counter", () => {
  const state = startedMatch();
  const attacker = unitsOf(state, 1).find((u) => u.unitType === "light_tank")!;
  const defender = unitsOf(state, 2).find((u) => u.unitType === "infantry")!;

  // Place them adjacent so the attack is legal, then run it twice from the
  // same starting state: the luck roll must land identically.
  const staged = structuredClone(state);
  staged.units[defender.id].x = attacker.x + 1;
  staged.units[defender.id].y = attacker.y;

  const first = applyAction(staged, 1, { type: "attack", unitId: attacker.id, targetUnitId: defender.id });
  const second = applyAction(staged, 1, { type: "attack", unitId: attacker.id, targetUnitId: defender.id });
  assert.ok(first.ok && second.ok);
  assert.deepEqual(first.events, second.events);
});

test("displayHp never shows a living unit as dead", () => {
  assert.equal(displayHp(100), 10);
  assert.equal(displayHp(1), 1);
  assert.equal(displayHp(9), 1);
  assert.equal(displayHp(0), 0);
});

test("artillery may not move and fire in the same turn", () => {
  let state = startedMatch();
  // Hand-place an artillery next to an enemy so the rule is what is under test.
  const target = unitsOf(state, 2)[0];
  state = structuredClone(state);
  state.units["arty"] = {
    id: "arty", unitType: "artillery", ownerSlot: 1,
    x: target.x, y: target.y - 2, hp: 100, fuel: 50, ammo: 9,
    hasMoved: true, hasActed: false, captureProgress: 0, cargo: [],
  };

  const blocked = applyAction(state, 1, { type: "attack", unitId: "arty", targetUnitId: target.id });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.ok === false && blocked.reason, "indirect_cannot_move_and_fire");

  state.units["arty"].hasMoved = false;
  const allowed = applyAction(state, 1, { type: "attack", unitId: "arty", targetUnitId: target.id });
  assert.ok(allowed.ok, allowed.ok === false ? allowed.reason : "");
});

/* ------------------------- fog of war ----------------------------- */

test("a player's view never contains enemy units they cannot see", () => {
  const state = startedMatch();
  const visible = visibleTiles(state, 1);
  const view = buildPlayerView(state, 1);

  for (const unit of view.units) {
    if (unit.ownerSlot === 1) continue;
    assert.ok(
      visible.has(unit.y! * state.map.width + unit.x!),
      `enemy unit ${unit.id} leaked into slot 1's view`,
    );
  }
  // The starting positions are on opposite corners of the map.
  assert.equal(view.units.filter((u) => u.ownerSlot === 2).length, 0);
  assert.equal(view.units.filter((u) => u.ownerSlot === 1).length, 3);
});

test("enemy units in view are stripped of unobservable fields", () => {
  const state = startedMatch();
  const spotted = structuredClone(state);
  const mine = unitsOf(spotted, 1)[0];
  const theirs = unitsOf(spotted, 2)[0];
  spotted.units[theirs.id].x = mine.x + 1;
  spotted.units[theirs.id].y = mine.y;

  const enemyInView = buildPlayerView(spotted, 1).units.find((u) => u.ownerSlot === 2);
  assert.ok(enemyInView, "an adjacent enemy should be visible");
  assert.equal(enemyInView.fuel, undefined);
  assert.equal(enemyInView.ammo, undefined);
  assert.ok(typeof enemyInView.hp === "number");
});

test("a player's funds are hidden from their opponent", () => {
  const state = startedMatch();
  const view = buildPlayerView(state, 1);
  // Slot 1 has already collected its first turn's building income.
  assert.equal(typeof view.players.find((p) => p.slot === 1)!.funds, "number");
  assert.equal(view.players.find((p) => p.slot === 2)!.funds, null);
});

test("the turn that starts a match pays its owner's building income", () => {
  const state = startedMatch();
  const owned = state.map.tiles.filter((t) => t.ownerSlot === 1).length;
  assert.ok(owned > 0);
  assert.equal(state.players.find((p) => p.slot === 1)!.funds, owned * 1000);
  assert.equal(state.players.find((p) => p.slot === 2)!.funds, 0, "slot 2 has not had a turn yet");
});

/* --------------------------- production --------------------------- */

test("building requires funds, an owned production tile and a matching unit class", () => {
  let state = startedMatch();
  const factoryIndex = state.map.tiles.findIndex(
    (t) => t.terrain === "factory" && t.ownerSlot === 1,
  );
  assert.ok(factoryIndex >= 0, "slot 1 should own a factory at start");
  const at = { x: factoryIndex % state.map.width, y: Math.floor(factoryIndex / state.map.width) };

  const broke = structuredClone(state);
  broke.players.find((p) => p.slot === 1)!.funds = 0;
  const tooPoor = applyAction(broke, 1, { type: "build", unitType: "light_tank", at });
  assert.equal(tooPoor.ok, false);
  assert.equal(tooPoor.ok === false && tooPoor.reason, "insufficient_funds");

  state = structuredClone(state);
  state.players.find((p) => p.slot === 1)!.funds = 5000;

  const wrongBuilding = applyAction(state, 1, { type: "build", unitType: "fighter_jet", at });
  assert.equal(wrongBuilding.ok, false);
  assert.equal(wrongBuilding.ok === false && wrongBuilding.reason, "wrong_production_building");

  const built = applyAction(state, 1, { type: "build", unitType: "light_tank", at });
  assert.ok(built.ok);
  assert.equal(built.state.players.find((p) => p.slot === 1)!.funds, 4300);
  const fresh = Object.values(built.state.units).find((u) => u.id !== undefined && u.x === at.x && u.y === at.y)!;
  assert.equal(fresh.hasActed, true, "a unit built this turn may not act until the next one");
});

test("faction cost modifiers come from the shared data table", () => {
  let state = startedMatch();
  // Slot 2 is the Azure Federation: artillery is 20% cheaper for them.
  state = structuredClone(state);
  state.currentSlot = 2;
  state.players.find((p) => p.slot === 2)!.funds = 5000;

  const factoryIndex = state.map.tiles.findIndex((t) => t.terrain === "factory" && t.ownerSlot === 2);
  const at = { x: factoryIndex % state.map.width, y: Math.floor(factoryIndex / state.map.width) };
  const built = applyAction(state, 2, { type: "build", unitType: "artillery", at });
  assert.ok(built.ok, built.ok === false ? built.reason : "");
  assert.equal(built.state.players.find((p) => p.slot === 2)!.funds, 5000 - 480);
});

/* ---------------------------- capture ----------------------------- */

test("capturing takes two full-health turns and then flips the tile", () => {
  let state = startedMatch();
  const cityIndex = state.map.tiles.findIndex((t) => t.terrain === "city" && t.ownerSlot === 0);
  assert.ok(cityIndex >= 0);
  const at = { x: cityIndex % state.map.width, y: Math.floor(cityIndex / state.map.width) };

  state = structuredClone(state);
  const infantry = unitsOf(state, 1).find((u) => u.unitType === "infantry")!;
  state.units[infantry.id].x = at.x;
  state.units[infantry.id].y = at.y;

  const first = applyAction(state, 1, { type: "capture", unitId: infantry.id });
  assert.ok(first.ok);
  assert.equal(first.state.map.tiles[cityIndex].ownerSlot, 0, "not captured after one turn");
  assert.equal(first.state.units[infantry.id].captureProgress, 10);

  const ready = structuredClone(first.state);
  ready.units[infantry.id].hasActed = false;
  const second = applyAction(ready, 1, { type: "capture", unitId: infantry.id });
  assert.ok(second.ok);
  assert.equal(second.state.map.tiles[cityIndex].ownerSlot, 1);
  assert.ok(second.events.some((e) => e.type === "tileCaptured"));
});

test("capture progress is lost if the unit moves away", () => {
  let state = startedMatch();
  const cityIndex = state.map.tiles.findIndex((t) => t.terrain === "city" && t.ownerSlot === 0);
  const at = { x: cityIndex % state.map.width, y: Math.floor(cityIndex / state.map.width) };

  state = structuredClone(state);
  const infantry = unitsOf(state, 1).find((u) => u.unitType === "infantry")!;
  state.units[infantry.id].x = at.x;
  state.units[infantry.id].y = at.y;

  const captured = applyAction(state, 1, { type: "capture", unitId: infantry.id });
  assert.ok(captured.ok);

  const nextTurn = structuredClone(captured.state);
  nextTurn.units[infantry.id].hasActed = false;
  nextTurn.units[infantry.id].hasMoved = false;

  const step = reachableTiles(nextTurn, nextTurn.units[infantry.id]).find((t) => t.cost === 1)!;
  const moved = applyAction(nextTurn, 1, {
    type: "move",
    unitId: infantry.id,
    path: [{ x: step.x, y: step.y }],
  });
  assert.ok(moved.ok);
  assert.equal(moved.state.units[infantry.id].captureProgress, 0);
});

test("losing the HQ ends the match", () => {
  let state = startedMatch();
  const hqIndex = state.map.tiles.findIndex(
    (t) => TERRAIN[t.terrain].is_hq && t.ownerSlot === 2,
  );
  const at = { x: hqIndex % state.map.width, y: Math.floor(hqIndex / state.map.width) };

  state = structuredClone(state);
  const infantry = unitsOf(state, 1).find((u) => u.unitType === "infantry")!;
  state.units[infantry.id].x = at.x;
  state.units[infantry.id].y = at.y;
  state.units[infantry.id].captureProgress = 10;

  const taken = applyAction(state, 1, { type: "capture", unitId: infantry.id });
  assert.ok(taken.ok);
  assert.equal(taken.state.phase, "finished");
  assert.equal(taken.state.winnerSlot, 1);
  assert.ok(taken.events.some((e) => e.type === "playerDefeated"));
  assert.ok(taken.events.some((e) => e.type === "matchFinished"));
});

test("applyAction never mutates the state it was given", () => {
  const state = startedMatch();
  const before = JSON.stringify(state);
  const infantry = unitsOf(state, 1).find((u) => u.unitType === "infantry")!;
  const step = reachableTiles(state, infantry).find((t) => t.cost === 1)!;
  applyAction(state, 1, { type: "move", unitId: infantry.id, path: [{ x: step.x, y: step.y }] });
  assert.equal(JSON.stringify(state), before);
});
