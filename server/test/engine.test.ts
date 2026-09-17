/**
 * Rules-engine tests.
 *
 * These run with no server, no sockets and no map editor - which is the
 * point of keeping game/ pure. If a rule needs a socket to test, it is in
 * the wrong module.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { addPlayer, applyAction, createMatch, seatFor } from "../src/game/engine";
import { reachableTiles, unitAt, validatePath } from "../src/game/movement";
import { baseDamage, displayHp } from "../src/game/combat";
import { buildPlayerView, filterEventsFor } from "../src/game/view";
import { visibleTiles } from "../src/game/vision";
import { UNITS, TERRAIN, DAMAGE_MATRIX, FACTIONS, loadMap } from "../src/game/data";
import type { GameEvent, MatchState, Unit, Vec2 } from "../src/game/types";

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

/** Artillery out of range of its own eyes, with a scout lending it sight. */
function spottedArtillery(): { state: MatchState; targetId: string } {
  const base = startedMatch();
  const target = unitsOf(base, 2)[0];
  const state = structuredClone(base);

  state.units["arty"] = {
    id: "arty", unitType: "artillery", ownerSlot: 1,
    x: target.x, y: target.y - 2, hp: 100, fuel: 50, ammo: 9,
    hasMoved: true, hasActed: false, captureProgress: 0, cargo: [], carriedBy: null,
  };
  // Artillery has vision 1 and range 2-3, so it cannot see what it shoots.
  state.units["eyes"] = {
    id: "eyes", unitType: "infantry", ownerSlot: 1,
    x: target.x, y: target.y - 1, hp: 100, fuel: 99, ammo: null,
    hasMoved: false, hasActed: false, captureProgress: 0, cargo: [], carriedBy: null,
  };
  return { state, targetId: target.id };
}

test("artillery may not move and fire in the same turn", () => {
  const { state, targetId } = spottedArtillery();

  const blocked = applyAction(state, 1, { type: "attack", unitId: "arty", targetUnitId: targetId });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.ok === false && blocked.reason, "indirect_cannot_move_and_fire");

  state.units["arty"].hasMoved = false;
  const allowed = applyAction(state, 1, { type: "attack", unitId: "arty", targetUnitId: targetId });
  assert.ok(allowed.ok, allowed.ok === false ? allowed.reason : "");
});

test("artillery cannot shell what nobody can see", () => {
  const { state, targetId } = spottedArtillery();
  state.units["arty"].hasMoved = false;

  // With the spotter, the shot lands.
  const spotted = applyAction(state, 1, { type: "attack", unitId: "arty", targetUnitId: targetId });
  assert.ok(spotted.ok, spotted.ok === false ? spotted.reason : "");

  // Without it, the target is out of sight - and the refusal says only that,
  // so it cannot be used to check whether a remembered unit is still there.
  const blind = structuredClone(state);
  delete blind.units["eyes"];
  const unseen = applyAction(blind, 1, { type: "attack", unitId: "arty", targetUnitId: targetId });
  assert.equal(unseen.ok, false);
  assert.equal(unseen.ok === false && unseen.reason, "no_such_target");

  // A target that genuinely does not exist is refused identically.
  const ghost = applyAction(blind, 1, { type: "attack", unitId: "arty", targetUnitId: "no-such" });
  assert.equal(ghost.ok === false && ghost.reason, "no_such_target");
});

/* ------------------------- fog of war ----------------------------- */

test("a player's view never contains enemy units they cannot see", () => {
  const state = startedMatch();

  // The starting positions are on opposite corners, so nothing enemy shows.
  const view = buildPlayerView(state, 1);
  assert.equal(view.units.filter((u) => u.ownerSlot === 2).length, 0);
  assert.equal(view.units.filter((u) => u.ownerSlot === 1).length, 3);

  // Now with enemies both in and out of sight, so the filter is actually
  // exercised rather than trivially satisfied by there being none.
  const contact = structuredClone(state);
  const mine = Object.values(contact.units).find((u) => u.ownerSlot === 1)!;
  const [near, far] = Object.values(contact.units).filter((u) => u.ownerSlot === 2);
  near.x = mine.x + 1;
  near.y = mine.y;
  far.x = contact.map.width - 1;
  far.y = contact.map.height - 1;

  const visible = visibleTiles(contact, 1);
  const contactView = buildPlayerView(contact, 1);
  const enemies = contactView.units.filter((u) => u.ownerSlot === 2);

  assert.equal(enemies.length, 1, "the adjacent enemy, and only that one");
  assert.equal(enemies[0].id, near.id);
  for (const unit of enemies) {
    assert.ok(
      visible.has(unit.y! * contact.map.width + unit.x!),
      `enemy unit ${unit.id} leaked into slot 1's view`,
    );
  }
  assert.equal(contactView.units.some((u) => u.id === far.id), false,
    "the distant one is not in the payload at all");
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

/* ------------------------------------------------------------------ */
/* Reference figures for the client's damage forecast                  */
/* ------------------------------------------------------------------ */

/**
 * These pin down two exact combat outcomes. The Godot client computes a
 * forecast with its own implementation of the same formula, and its tests
 * assert that its predicted range brackets these numbers - so the two
 * implementations cannot drift apart without a test going red on one side
 * or the other.
 */
function stagedDuel(defenderAt: { x: number; y: number }, attackerAt: { x: number; y: number }) {
  const state = structuredClone(startedMatch());
  state.units = {
    atk: {
      id: "atk", unitType: "light_tank", ownerSlot: 1,
      x: attackerAt.x, y: attackerAt.y, hp: 100, fuel: 70, ammo: 9,
      hasMoved: false, hasActed: false, captureProgress: 0, cargo: [], carriedBy: null,
    },
    def: {
      id: "def", unitType: "anti_tank_infantry", ownerSlot: 2,
      x: defenderAt.x, y: defenderAt.y, hp: 90, fuel: 70, ammo: 3,
      hasMoved: false, hasActed: false, captureProgress: 0, cargo: [], carriedBy: null,
    },
  };
  return state;
}

test("reference duel on open road, for the client's forecast", () => {
  const state = stagedDuel({ x: 7, y: 4 }, { x: 6, y: 4 });
  assert.equal(TERRAIN[state.map.tiles[4 * state.map.width + 7].terrain].defense, 0,
    "the defender must be standing on cover-free ground");

  const result = applyAction(state, 1, { type: "attack", unitId: "atk", targetUnitId: "def" });
  assert.ok(result.ok);
  const hit = result.events.find((e) => e.type === "unitAttacked");
  assert.ok(hit && hit.type === "unitAttacked");

  // Base 70, attacker at full health, no terrain mitigation: 70 + luck(0-9).
  assert.ok(hit.damage >= 70 && hit.damage <= 79, `damage was ${hit.damage}`);
  // The counter scales with what the defender has left.
  assert.equal(hit.counterDamage, Math.floor(70 * ((90 - hit.damage) / 100)),
    `counter was ${hit.counterDamage} after ${hit.damage}`);
});

test("reference duel into forest cover, for the client's forecast", () => {
  const state = stagedDuel({ x: 13, y: 3 }, { x: 12, y: 3 });
  assert.equal(state.map.tiles[3 * state.map.width + 13].terrain, "forest");

  const result = applyAction(state, 1, { type: "attack", unitId: "atk", targetUnitId: "def" });
  assert.ok(result.ok);
  const hit = result.events.find((e) => e.type === "unitAttacked");
  assert.ok(hit && hit.type === "unitAttacked");

  // Forest is 30% defense, scaled by the defender's 90 HP: mitigation 0.73.
  const low = Math.floor(70 * 0.73);
  const high = Math.floor(79 * 0.73);
  assert.ok(hit.damage >= low && hit.damage <= high,
    `damage ${hit.damage} outside ${low}..${high}`);
});

test("reference duel with Overdrive up, for the client's forecast", () => {
  // The open-road duel again, with slot 1's directive running. Pinned on
  // both sides: hud_check asserts the client's forecast brackets exactly
  // this, so neither implementation can pick up the directive term without
  // the other, which is the failure the player would actually notice -
  // reading a forecast, spending the turn, being dealt something else.
  const state = stagedDuel({ x: 7, y: 4 }, { x: 6, y: 4 });
  state.players[0].activeDirective = "overdrive";
  state.players[0].directiveTurnsLeft = 1;

  const result = applyAction(state, 1, { type: "attack", unitId: "atk", targetUnitId: "def" });
  assert.ok(result.ok);
  const hit = result.events.find((e) => e.type === "unitAttacked");
  assert.ok(hit && hit.type === "unitAttacked");

  // Base 70 x 1.20 = 84, plus luck(0-9), no terrain mitigation.
  assert.ok(hit.damage >= 84 && hit.damage <= 93, `damage was ${hit.damage}`);
});

/* ------------------------------------------------------------------ */
/* Storage under concurrency                                           */
/* ------------------------------------------------------------------ */

/**
 * Two saves for one match can be in flight at once - a player rejoining
 * while another disconnects. They used to share a temp filename, so the
 * slower rename found it already gone and threw ENOENT, which as an
 * unhandled rejection took the whole server down.
 */
test("concurrent saves of one match do not collide", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const nodePath = await import("node:path");
  const { FileMatchStore } = await import("../src/match/MatchStore");

  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "redline-store-"));
  const store = new FileMatchStore(dir);
  const state = startedMatch();

  const writes = [];
  for (let i = 0; i < 25; i++) {
    const version = structuredClone(state);
    version.version = i;
    writes.push(store.save(version));
  }
  await Promise.all(writes);

  const loaded = await store.load(state.matchId);
  assert.ok(loaded, "the match must still be readable after concurrent writes");
  assert.equal(typeof loaded.version, "number");

  // No temp files left behind, and the match is not listed twice.
  const listed = await store.listActive();
  assert.deepEqual(listed, [state.matchId], `listed ${JSON.stringify(listed)}`);
});

/**
 * Two concurrent cache misses for one match used to each build their own
 * state object, and whichever committed last discarded the other's turn -
 * possible on the first requests after a restart, when the cache is cold.
 */
test("concurrent first reads of a match share one state object", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const nodePath = await import("node:path");
  const { FileMatchStore } = await import("../src/match/MatchStore");
  const { MatchService } = await import("../src/match/MatchService");

  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "redline-dedup-"));
  const store = new FileMatchStore(dir);

  // Seed a started match, then use a cold service, as after a restart.
  const seeded = startedMatch();
  await store.save(seeded);

  let loads = 0;
  const countingStore = {
    load: (id: string) => { loads += 1; return store.load(id); },
    save: (state: typeof seeded) => store.save(state),
    delete: (id: string) => store.delete(id),
    listActive: () => store.listActive(),
  };
  const service = new MatchService(countingStore);

  // Two requests arriving together, both missing the cache.
  const [a, b] = await Promise.all([
    service.rejoin("player-one", seeded.matchId),
    service.rejoin("player-two", seeded.matchId),
  ]);
  assert.ok(a.ok && b.ok);
  assert.equal(loads, 1, "a concurrent miss must not load the match twice");

  // Both views describe the same match at the same version.
  assert.equal(a.deliveries[0].view.version, b.deliveries[0].view.version);
});

test("orphaned temp files are cleaned up rather than accumulating", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const nodePath = await import("node:path");
  const { FileMatchStore } = await import("../src/match/MatchStore");

  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "redline-orphan-"));
  const store = new FileMatchStore(dir);
  await store.save(startedMatch());

  // What a crash between write and rename leaves behind.
  fs.writeFileSync(nodePath.join(dir, "abandoned.deadbeef.tmp"), "{}");
  fs.writeFileSync(nodePath.join(dir, "another.cafebabe.tmp"), "{}");

  // A temp file young enough that a live write might still own it is spared.
  // Deleting one would turn its rename into ENOENT and lose that turn -
  // which matters because this runs at startup, when another process may be
  // part-way through a save.
  assert.equal(await store.cleanOrphanedTempFiles(), 0,
    "fresh temp files must not be swept");

  assert.equal(await store.cleanOrphanedTempFiles(0), 2, "older ones are");
  assert.equal(await store.cleanOrphanedTempFiles(0), 0, "cleaning is idempotent");

  const remaining = fs.readdirSync(dir);
  assert.equal(remaining.length, 1, `left ${JSON.stringify(remaining)}`);
  assert.ok(remaining[0].endsWith(".json"), "the real match must survive");
});

/* ------------------------------------------------------------------ */
/* Fog of war: what each player is told (review follow-up)             */
/* ------------------------------------------------------------------ */

/** Two units in contact mid-map, with the rest of the board dark. */
function contactState(): MatchState {
  const state = structuredClone(startedMatch());
  state.units = {
    mine: {
      id: "mine", unitType: "light_tank", ownerSlot: 1, x: 6, y: 4,
      hp: 100, fuel: 70, ammo: 9,
      hasMoved: false, hasActed: false, captureProgress: 0, cargo: [], carriedBy: null,
    },
    theirs: {
      id: "theirs", unitType: "anti_tank_infantry", ownerSlot: 2, x: 7, y: 4,
      hp: 20, fuel: 70, ammo: 3,
      hasMoved: false, hasActed: false, captureProgress: 0, cargo: [], carriedBy: null,
    },
  };
  return state;
}

test("the owner of a destroyed unit is still told it died", () => {
  const state = contactState();
  const result = applyAction(state, 1, {
    type: "attack", unitId: "mine", targetUnitId: "theirs",
  });
  assert.ok(result.ok);
  assert.ok(result.events.some((e) => e.type === "unitDestroyed"));

  // The victim's own unit is gone from the post-action state, so a filter
  // that resolved ids against it would tell them nothing at all.
  const victim = filterEventsFor(result.state, 2, result.events);
  assert.ok(victim.some((e) => e.type === "unitAttacked"),
    "the player who was attacked must hear about it");
  assert.ok(victim.some((e) => e.type === "unitDestroyed"),
    "and must hear that their unit died");
});

test("an attacker killed by the counterattack still hears what happened", () => {
  const state = contactState();
  state.units["mine"].hp = 5;
  state.units["theirs"].hp = 100;

  const result = applyAction(state, 1, {
    type: "attack", unitId: "mine", targetUnitId: "theirs",
  });
  assert.ok(result.ok);
  assert.equal(result.state.units["mine"], undefined,
    "the scenario must actually kill the attacker, or it tests nothing");
  assert.ok(result.events.some((e) => e.type === "unitDestroyed" && e.unitId === "mine"));

  const attacker = filterEventsFor(result.state, 1, result.events);
  assert.ok(attacker.some((e) => e.type === "unitAttacked"),
    "the player who submitted the action must get its result");
  assert.ok(
    attacker.some((e) => e.type === "unitDestroyed" && e.unitId === "mine"),
    "and must be told their own unit died - the id no longer resolves in the "
      + "post-action state, which is what used to drop this event",
  );
});

test("an enemy move is reported only as far as it was watched", () => {
  const state = structuredClone(startedMatch());
  state.units = {
    watcher: {
      id: "watcher", unitType: "infantry", ownerSlot: 1, x: 6, y: 4,
      hp: 100, fuel: 99, ammo: null,
      hasMoved: false, hasActed: false, captureProgress: 0, cargo: [], carriedBy: null,
    },
    runner: {
      id: "runner", unitType: "recon", ownerSlot: 2, x: 7, y: 4,
      hp: 100, fuel: 80, ammo: null,
      hasMoved: false, hasActed: false, captureProgress: 0, cargo: [], carriedBy: null,
    },
  };
  state.currentSlot = 2;

  // Away along the road, out of the watcher's two-tile sight.
  const result = applyAction(state, 2, {
    type: "move", unitId: "runner",
    path: [{ x: 8, y: 4 }, { x: 9, y: 4 }, { x: 10, y: 4 }, { x: 11, y: 4 }],
  });
  assert.ok(result.ok, result.ok === false ? result.reason : "");

  const seen = filterEventsFor(result.state, 1, result.events);
  const moved = seen.find((e) => e.type === "unitMoved");
  assert.ok(moved && moved.type === "unitMoved", "the start of the move was visible");
  assert.ok(moved.path.length < 4, `whole route leaked: ${JSON.stringify(moved.path)}`);
  assert.ok(moved.path.every((p) => p.x <= 8),
    `route beyond sight leaked: ${JSON.stringify(moved.path)}`);
});

test("the opponent's income is not broadcast", () => {
  const state = startedMatch();
  const result = applyAction(state, 1, { type: "endTurn" });
  assert.ok(result.ok);

  const own = filterEventsFor(result.state, 2, result.events)
    .find((e) => e.type === "turnStarted");
  assert.ok(own && own.type === "turnStarted");
  assert.equal(typeof own.income, "number", "a player sees their own income");

  const other = filterEventsFor(result.state, 1, result.events)
    .find((e) => e.type === "turnStarted");
  assert.ok(other && other.type === "turnStarted");
  assert.equal(other.income, null,
    "income reveals the building count, and funds follow from it exactly");
});

test("a build out of sight is not announced", () => {
  const state = structuredClone(startedMatch());
  state.players.find((p) => p.slot === 1)!.funds = 5000;
  const factory = state.map.tiles.findIndex((t) => t.terrain === "factory" && t.ownerSlot === 1);
  const at = { x: factory % state.map.width, y: Math.floor(factory / state.map.width) };

  const result = applyAction(state, 1, { type: "build", unitType: "recon", at });
  assert.ok(result.ok, result.ok === false ? result.reason : "");

  assert.ok(filterEventsFor(result.state, 1, result.events).some((e) => e.type === "unitBuilt"));
  assert.equal(
    filterEventsFor(result.state, 2, result.events).some((e) => e.type === "unitBuilt"), false,
    "the enemy's factory is across the map and in fog");
});

test("tile ownership is what a player has seen, not what is true", () => {
  const state = startedMatch();
  const view = buildPlayerView(state, 1);

  const theirHq = state.map.tiles.findIndex(
    (t) => TERRAIN[t.terrain].is_hq && t.ownerSlot === 2);
  const myHq = state.map.tiles.findIndex(
    (t) => TERRAIN[t.terrain].is_hq && t.ownerSlot === 1);

  assert.equal(view.map.tileOwners[myHq], 1, "a player knows their own base");
  assert.equal(view.map.tileOwners[theirHq], 0,
    "the enemy base is across the map and has never been seen");
  assert.equal(state.map.tiles[theirHq].ownerSlot, 2, "while the truth is unchanged");
});

test("walking into something unseen stops the unit instead of refusing the order", () => {
  const state = structuredClone(startedMatch());
  state.units = {
    // A light tank sees two tiles, so the infantry five away really is
    // hidden when the order is given.
    mover: {
      id: "mover", unitType: "light_tank", ownerSlot: 1, x: 4, y: 4,
      hp: 100, fuel: 70, ammo: 9,
      hasMoved: false, hasActed: false, captureProgress: 0, cargo: [], carriedBy: null,
    },
    hidden: {
      id: "hidden", unitType: "infantry", ownerSlot: 2, x: 9, y: 4,
      hp: 100, fuel: 99, ammo: null,
      hasMoved: false, hasActed: false, captureProgress: 0, cargo: [], carriedBy: null,
    },
  };

  const result = applyAction(state, 1, {
    type: "move", unitId: "mover",
    path: [{ x: 5, y: 4 }, { x: 6, y: 4 }, { x: 7, y: 4 }, { x: 8, y: 4 }, { x: 9, y: 4 }],
  });

  // Refusing would be a free oracle: submit a move, read the rejection, learn
  // what is in the fog without spending anything.
  assert.ok(result.ok, "the order is accepted, not refused");
  const mover = result.state.units["mover"];
  assert.equal(mover.x, 8, `stopped at ${mover.x},${mover.y} instead of short of the ambush`);
  assert.equal(mover.hasMoved, true, "and it cost the unit its move");

  const moved = result.events.find((e) => e.type === "unitMoved");
  assert.ok(moved && moved.type === "unitMoved");
  assert.deepEqual(moved.to, { x: 8, y: 4 }, "the event reports where it actually stopped");
});

test("a visible enemy still blocks a path outright", () => {
  const state = structuredClone(startedMatch());
  state.units = {
    mover: {
      id: "mover", unitType: "recon", ownerSlot: 1, x: 6, y: 4,
      hp: 100, fuel: 80, ammo: null,
      hasMoved: false, hasActed: false, captureProgress: 0, cargo: [], carriedBy: null,
    },
    blocker: {
      id: "blocker", unitType: "infantry", ownerSlot: 2, x: 7, y: 4,
      hp: 100, fuel: 99, ammo: null,
      hasMoved: false, hasActed: false, captureProgress: 0, cargo: [], carriedBy: null,
    },
  };

  const result = applyAction(state, 1, {
    type: "move", unitId: "mover", path: [{ x: 7, y: 4 }],
  });
  assert.equal(result.ok, false, "there is no information to protect here");
  assert.equal(result.ok === false && result.reason, "path_blocked_by_enemy");
});

/**
 * Every operation on a match is a read-modify-write, and two can start in
 * the same tick from different sockets - a player's action and the other
 * player's socket closing, say. Serializing only the disk write left both
 * computing from the same snapshot, and the later commit erased a turn that
 * had already been acknowledged and animated.
 */
test("concurrent operations on one match do not lose a turn", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const nodePath = await import("node:path");
  const { FileMatchStore } = await import("../src/match/MatchStore");
  const { MatchService } = await import("../src/match/MatchService");

  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "redline-race-"));
  const service = new MatchService(new FileMatchStore(dir));

  const created = await service.create("player-one", "crossing", "crimson_alliance");
  assert.ok(created.ok);
  const matchId = created.matchId!;
  assert.ok((await service.join("player-two", matchId, "azure_federation")).ok);

  const before = created.deliveries[0].view;
  const mine = before.units.filter((u) => u.ownerSlot === 1);
  assert.ok(mine.length > 0);

  // An action and a presence change, started together.
  const [acted] = await Promise.all([
    service.act("player-one", matchId, { type: "endTurn" }),
    service.setConnected("player-two", matchId, false),
  ]);
  assert.ok(acted.ok, acted.reason);

  // Both landed: the turn passed AND the disconnect was recorded. Before, one
  // overwrote the other.
  const resumed = await service.rejoin("player-one", matchId);
  assert.ok(resumed.ok);
  const view = resumed.deliveries.find((d) => d.playerId === "player-one")!.view;
  assert.equal(view.currentSlot, 2, "the turn that was acknowledged must stand");
  assert.equal(view.players.find((p) => p.slot === 2)!.connected, false,
    "and so must the disconnect");
});

test("a presence change reports who has not been told", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const nodePath = await import("node:path");
  const { FileMatchStore } = await import("../src/match/MatchStore");
  const { MatchService } = await import("../src/match/MatchService");

  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "redline-presence-"));
  const service = new MatchService(new FileMatchStore(dir));
  const created = await service.create("host", "crossing", "crimson_alliance");
  const matchId = created.matchId!;
  await service.join("guest", matchId, "azure_federation");

  const change = await service.setConnected("guest", matchId, false);
  assert.ok(change, "a real change is reported");
  assert.equal(change.connected, false);
  assert.deepEqual(change.notify, ["host"], "the opponent, not the player who left");

  assert.equal(await service.setConnected("guest", matchId, false), null,
    "setting it to what it already was announces nothing");
});

/* ------------------------------------------------------------------ */
/* Reef as a naval obstacle                                            */
/* ------------------------------------------------------------------ */

function navalMatch(): MatchState {
  let state = createMatch({ matchId: "naval", mapId: "straits", rngSeed: 4242 });
  const p1 = addPlayer(state, "player-one", "crimson_alliance");
  assert.ok(p1.ok);
  const p2 = addPlayer(p1.state, "player-two", "azure_federation");
  assert.ok(p2.ok);
  return p2.state;
}

/** Drops a ship onto a specific tile so naval rules can be exercised
 *  directly - the map's own start units are all land units. */
function placeBoat(state: MatchState, x: number, y: number): Unit {
  const boat: Unit = {
    id: "boat-1", unitType: "patrol_boat", ownerSlot: 1, x, y,
    hp: 100, fuel: UNITS.patrol_boat.max_fuel, ammo: UNITS.patrol_boat.max_ammo,
    hasMoved: false, hasActed: false, captureProgress: 0, cargo: [], carriedBy: null,
  };
  state.units[boat.id] = boat;
  return boat;
}

test("a reef is not reachable by a ship, and does not strand it either", () => {
  const state = navalMatch();
  const terrainAt = (x: number, y: number) => state.map.tiles[y * state.map.width + x].terrain;

  // Find a reef with open water beside it, rather than hardcoding a
  // coordinate the map could later move.
  let reef: { x: number; y: number } | null = null;
  for (let y = 0; y < state.map.height && !reef; y++) {
    for (let x = 0; x < state.map.width && !reef; x++) {
      if (terrainAt(x, y) === "reef" && x > 0 && terrainAt(x - 1, y) === "deep_water") {
        reef = { x, y };
      }
    }
  }
  assert.ok(reef, "the straits map should have a reef with water west of it");

  const boat = placeBoat(state, reef.x - 1, reef.y);
  const reachable = reachableTiles(state, boat);

  assert.ok(
    !reachable.some((t) => t.x === reef!.x && t.y === reef!.y),
    "a reef must never appear in a ship's reachable tiles",
  );
  // The ship is beside an obstacle, not walled in: it must still have
  // somewhere to go, or this test would pass on a boat that simply cannot
  // move at all.
  assert.ok(reachable.length > 1, "the ship should still be able to move around the reef");
});

test("a path through a reef is rejected, one around it is accepted", () => {
  const state = navalMatch();
  const terrainAt = (x: number, y: number) => state.map.tiles[y * state.map.width + x].terrain;

  let reef: { x: number; y: number } | null = null;
  for (let y = 0; y < state.map.height && !reef; y++) {
    for (let x = 0; x < state.map.width && !reef; x++) {
      if (terrainAt(x, y) === "reef" && x > 0 && terrainAt(x - 1, y) === "deep_water") {
        reef = { x, y };
      }
    }
  }
  assert.ok(reef);

  const boat = placeBoat(state, reef.x - 1, reef.y);
  const through = validatePath(state, boat, [{ x: reef.x, y: reef.y }]);
  assert.equal(through.ok, false, "sailing onto a reef must be refused");

  // And prove the refusal is about the reef, not about the ship: the same
  // one-tile step to a navigable neighbour is accepted.
  const open = [
    { x: reef.x - 1, y: reef.y - 1 },
    { x: reef.x - 1, y: reef.y + 1 },
    { x: reef.x - 2, y: reef.y },
  ].find((p) =>
    p.x >= 0 && p.y >= 0 && p.x < state.map.width && p.y < state.map.height &&
    TERRAIN[terrainAt(p.x, p.y)].move_cost.sea !== null);
  assert.ok(open, "the reef should have navigable water beside it to steer into");
  assert.equal(validatePath(state, boat, [open]).ok, true,
    "a step into open water beside the reef must be allowed");
});

/* ------------------------------------------------------------------ */
/* Transports                                                          */
/* ------------------------------------------------------------------ */

/*
 * Verified against five mutations, one per guard these rest on:
 *   - unitAt dropping its `carriedBy` test: cargo occupies its transport's
 *     tile again, and the load test stops finding the transport there
 *   - vision.ts counting carried units: the recon sees out of the hold
 *   - view.ts sending cargo to anyone but its owner: the manifest leaks
 *   - destroyUnit not recursing into cargo: the hold outlives the hull
 *   - doMove not dragging cargo coordinates: the hold is left behind
 * The sixth - filterEventsFor treating unitLoaded/unitUnloaded as public -
 * has to be mutated as a always-push condition rather than by renaming the
 * case labels, which does not compile and so silently runs no tests at all.
 */

/**
 * A transport afloat with an infantry on the beach beside it.
 *
 * The tiles are searched for rather than hardcoded: `straits` is real map
 * data and a later edit to it should not quietly turn these into tests of
 * an empty ocean.
 */
function beachhead(): { state: MatchState; shore: Vec2; sea: Vec2 } {
  const state = navalMatch();
  const at = (x: number, y: number) => state.map.tiles[y * state.map.width + x].terrain;
  const seaCost = (t: string) => TERRAIN[t].move_cost.sea ?? null;
  const footCost = (t: string) => TERRAIN[t].move_cost.foot ?? null;

  for (let y = 1; y < state.map.height - 1; y++) {
    for (let x = 1; x < state.map.width - 1; x++) {
      if (seaCost(at(x, y)) === null) continue;
      // Not a port: a friendly repair tile tops the ship up every upkeep,
      // which would quietly defuse the running-dry test below.
      if (TERRAIN[at(x, y)].capturable) continue;
      for (const step of [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }]) {
        const sx = x + step.x;
        const sy = y + step.y;
        if (footCost(at(sx, sy)) === null) continue;
        if (TERRAIN[at(sx, sy)].capturable) continue;
        if (Object.values(state.units).some((u) => u.x === sx && u.y === sy)) continue;
        if (Object.values(state.units).some((u) => u.x === x && u.y === y)) continue;

        state.units["ship"] = {
          id: "ship", unitType: "transport_ship", ownerSlot: 1, x, y,
          hp: 100, fuel: UNITS.transport_ship.max_fuel, ammo: null,
          hasMoved: false, hasActed: false, captureProgress: 0, cargo: [], carriedBy: null,
        };
        state.units["grunt"] = {
          id: "grunt", unitType: "infantry", ownerSlot: 1, x: sx, y: sy,
          hp: 100, fuel: UNITS.infantry.max_fuel, ammo: null,
          hasMoved: false, hasActed: false, captureProgress: 0, cargo: [], carriedBy: null,
        };
        return { state, shore: { x: sx, y: sy }, sea: { x, y } };
      }
    }
  }
  throw new Error("straits has no open water beside passable land");
}

test("a transport loads an adjacent passenger and carries it off the board", () => {
  const { state, shore } = beachhead();

  const loaded = applyAction(state, 1, { type: "load", unitId: "grunt", transportId: "ship" });
  assert.ok(loaded.ok, loaded.ok === false ? loaded.reason : "");
  if (!loaded.ok) return;

  const ship = loaded.state.units["ship"];
  const grunt = loaded.state.units["grunt"];
  assert.deepEqual(ship.cargo, ["grunt"]);
  assert.equal(grunt.carriedBy, "ship");
  // It rides along rather than staying on the beach.
  assert.equal(grunt.x, ship.x);
  assert.equal(grunt.y, ship.y);
  // And the beach it left is free for anything else to walk onto.
  assert.equal(unitAt(loaded.state, shore.x, shore.y), undefined);
  // The transport's own tile still reports the *transport*, never its
  // cargo. Listed cargo-first on purpose: unitAt returns the first match it
  // finds, so an insertion-order-dependent assertion here would pass by
  // luck rather than because loaded units are excluded.
  const cargoFirst = structuredClone(loaded.state);
  cargoFirst.units = { grunt: cargoFirst.units["grunt"], ship: cargoFirst.units["ship"] };
  assert.equal(unitAt(cargoFirst, ship.x, ship.y)?.id, "ship");
  assert.equal(
    loaded.events.filter((e) => e.type === "unitLoaded").length, 1,
    "loading reports itself",
  );
});

test("cargo is not a lookout: a loaded unit adds no vision", () => {
  const { state } = beachhead();
  // A recon sees 5 tiles to the transport's 1, so if cargo were counted the
  // difference would be impossible to miss - and impossible to explain away
  // as some other unit's circle already covering the same ground.
  state.units["grunt"].unitType = "recon";

  const loaded = applyAction(state, 1, { type: "load", unitId: "grunt", transportId: "ship" });
  assert.ok(loaded.ok);
  if (!loaded.ok) return;

  const carried = visibleTiles(loaded.state, 1);

  // The same unit, same tile, same everything - just standing on the deck
  // rather than inside the hold.
  const onDeck = structuredClone(loaded.state);
  onDeck.units["grunt"].carriedBy = null;

  assert.ok(
    visibleTiles(onDeck, 1).size > carried.size,
    "a recon out of the hold must see further than one inside it",
  );
});

test("a transport refuses cargo it has no room or no bay for", () => {
  const { state } = beachhead();
  const sea = state.units["ship"];

  // A ship is not foot/wheels/treads, so it cannot be carried at all.
  state.units["tug"] = {
    id: "tug", unitType: "patrol_boat", ownerSlot: 1, x: sea.x, y: sea.y + 1,
    hp: 100, fuel: 40, ammo: 6,
    hasMoved: false, hasActed: false, captureProgress: 0, cargo: [], carriedBy: null,
  };
  const wrongType = applyAction(state, 1, { type: "load", unitId: "tug", transportId: "ship" });
  assert.equal(wrongType.ok, false);
  assert.equal(wrongType.ok === false && wrongType.reason, "wrong_cargo_type");

  // And capacity is 2, so a third passenger is refused.
  state.units["ship"].cargo = ["a", "b"];
  const full = applyAction(state, 1, { type: "load", unitId: "grunt", transportId: "ship" });
  assert.equal(full.ok, false);
  assert.equal(full.ok === false && full.reason, "transport_full");
});

test("you must be alongside to board", () => {
  const { state, sea } = beachhead();
  state.units["grunt"].x = sea.x;
  state.units["grunt"].y = sea.y + 3;

  const far = applyAction(state, 1, { type: "load", unitId: "grunt", transportId: "ship" });
  assert.equal(far.ok, false);
  assert.equal(far.ok === false && far.reason, "transport_not_adjacent");
});

test("a transport puts its cargo ashore, but only somewhere it can stand", () => {
  const { state, shore, sea } = beachhead();
  const loaded = applyAction(state, 1, { type: "load", unitId: "grunt", transportId: "ship" });
  assert.ok(loaded.ok);
  if (!loaded.ok) return;

  // Fresh turn for the ship; the passenger spent its own boarding.
  const afloat = structuredClone(loaded.state);
  afloat.units["ship"].hasMoved = false;
  afloat.units["ship"].hasActed = false;

  // Back onto open water the infantry cannot walk on.
  const intoTheSea = applyAction(afloat, 1, {
    type: "unload", transportId: "ship", unitId: "grunt", to: { x: sea.x, y: sea.y },
  });
  assert.equal(intoTheSea.ok, false);

  const ashore = applyAction(afloat, 1, {
    type: "unload", transportId: "ship", unitId: "grunt", to: shore,
  });
  assert.ok(ashore.ok, ashore.ok === false ? ashore.reason : "");
  if (!ashore.ok) return;

  const grunt = ashore.state.units["grunt"];
  assert.equal(grunt.carriedBy, null);
  assert.deepEqual({ x: grunt.x, y: grunt.y }, shore);
  assert.deepEqual(ashore.state.units["ship"].cargo, []);
  // It landed this turn, so it does not also get to act.
  assert.equal(grunt.hasActed, true);
});

test("sinking a transport takes its hold down with it", () => {
  const { state } = beachhead();
  const loaded = applyAction(state, 1, { type: "load", unitId: "grunt", transportId: "ship" });
  assert.ok(loaded.ok);
  if (!loaded.ok) return;

  const sunk = structuredClone(loaded.state);
  // Sea units that run dry are lost at the start of their own turn.
  sunk.units["ship"].fuel = 1;
  sunk.currentSlot = 2;
  const nextTurn = applyAction(sunk, 2, { type: "endTurn" });
  assert.ok(nextTurn.ok);
  if (!nextTurn.ok) return;

  assert.equal(nextTurn.state.units["ship"], undefined, "the transport is gone");
  assert.equal(
    nextTurn.state.units["grunt"], undefined,
    "and so is the infantry that was inside it",
  );
  const destroyed = nextTurn.events.filter((e) => e.type === "unitDestroyed");
  assert.equal(destroyed.length, 2, "both losses are reported, not just the hull");
});

test("the opponent is never told what is in a hold", () => {
  const { state, sea } = beachhead();
  const loaded = applyAction(state, 1, { type: "load", unitId: "grunt", transportId: "ship" });
  assert.ok(loaded.ok);
  if (!loaded.ok) return;

  // Park an enemy scout right beside the transport so it is plainly visible.
  const watched = structuredClone(loaded.state);
  watched.units["spy"] = {
    id: "spy", unitType: "recon", ownerSlot: 2, x: sea.x, y: sea.y + 1,
    hp: 100, fuel: 60, ammo: 9,
    hasMoved: false, hasActed: false, captureProgress: 0, cargo: [], carriedBy: null,
  };

  const theirView = buildPlayerView(watched, 2);
  const ids = theirView.units.map((u) => u.id);
  assert.ok(ids.includes("ship"), "they can see the transport itself");
  assert.ok(
    !ids.includes("grunt"),
    "but the infantry inside it must not appear in their view at all",
  );
  // And the manifest is not smuggled out on the transport either.
  const seenShip = theirView.units.find((u) => u.id === "ship");
  assert.equal(seenShip?.cargo, undefined);
});

test("a landing in the dark is not announced to the enemy", () => {
  const { state, shore } = beachhead();
  const events: GameEvent[] = [{
    type: "unitUnloaded", unitId: "grunt", transportId: "ship",
    ownerSlot: 1, at: shore,
  }];

  const mine = filterEventsFor(state, 1, events);
  assert.equal(mine.length, 1, "the owner always hears about their own landing");

  // Slot 2 has no eyes on that beach in the opening position.
  const visible = visibleTiles(state, 2);
  assert.ok(
    !visible.has(shore.y * state.map.width + shore.x),
    "fixture assumption: the far shore starts unwatched",
  );
  const theirs = filterEventsFor(state, 2, events);
  assert.equal(theirs.length, 0, "an unwatched landing is silent");
});

test("a sailing transport takes its cargo's position with it", () => {
  const { state, shore } = beachhead();
  const loaded = applyAction(state, 1, { type: "load", unitId: "grunt", transportId: "ship" });
  assert.ok(loaded.ok);
  if (!loaded.ok) return;

  const afloat = structuredClone(loaded.state);
  afloat.units["ship"].hasMoved = false;
  afloat.units["ship"].hasActed = false;
  const ship = afloat.units["ship"];

  // One tile along, to whichever neighbouring water the ship can reach.
  const step = reachableTiles(afloat, ship).find(
    (t) => (t.x !== ship.x || t.y !== ship.y) && t.cost > 0,
  );
  assert.ok(step, "fixture assumption: the transport has somewhere to sail");
  if (!step) return;

  const sailed = applyAction(afloat, 1, {
    type: "move", unitId: "ship", path: [{ x: step.x, y: step.y }],
  });
  assert.ok(sailed.ok, sailed.ok === false ? sailed.reason : "");
  if (!sailed.ok) return;

  const carried = sailed.state.units["grunt"];
  assert.deepEqual(
    { x: carried.x, y: carried.y }, { x: step.x, y: step.y },
    "cargo left behind at the old tile would be a phantom, and would report "
      + "the hold dying in the wrong place when the transport is sunk",
  );
  assert.equal(unitAt(sailed.state, shore.x, shore.y), undefined);
});

/* ------------------------------------------------------------------ */
/* Field Directives                                                    */
/* ------------------------------------------------------------------ */

/*
 * Verified against seven mutations, one per moving part:
 *   - addDirectiveCharge made a no-op: nothing ever charges
 *   - the charge_cost gate dropped: a directive fires from empty
 *   - attackMultiplier ignoring attack_pct: Overdrive changes no damage
 *   - terrainDefenseFor ignoring defense_pct: Fortify changes no damage
 *   - canEngage's reach fixed at 0: Barrage does not extend artillery
 *   - visibleTiles' Uplink branch removed: the map stays dark
 *   - visionRadius dropping the jamming term: Blackout blinds nobody
 */

/** A started match whose slot-1 player flies `faction`, fully charged. */
function chargedMatch(faction: string): MatchState {
  let state = createMatch({ matchId: "directive", mapId: "crossing", rngSeed: 777 });
  const p1 = addPlayer(state, "player-one", faction);
  assert.ok(p1.ok);
  const p2 = addPlayer(p1.ok ? p1.state : state, "player-two", "crimson_alliance");
  assert.ok(p2.ok);
  if (!p2.ok) throw new Error("fixture");

  const ready = structuredClone(p2.state);
  ready.players[0].directiveCharge = FACTIONS[faction].directive.charge_cost;
  return ready;
}

test("a directive needs a full charge, and spends it", () => {
  const cold = chargedMatch("crimson_alliance");
  cold.players[0].directiveCharge = 0;
  const tooSoon = applyAction(cold, 1, { type: "directive" });
  assert.equal(tooSoon.ok, false);
  assert.equal(tooSoon.ok === false && tooSoon.reason, "directive_not_charged");

  const ready = chargedMatch("crimson_alliance");
  const fired = applyAction(ready, 1, { type: "directive" });
  assert.ok(fired.ok, fired.ok === false ? fired.reason : "");
  if (!fired.ok) return;

  assert.equal(fired.state.players[0].activeDirective, "overdrive");
  assert.equal(fired.state.players[0].directiveCharge, 0, "the charge is spent");
  assert.equal(fired.events.filter((e) => e.type === "directiveActivated").length, 1);

  // Not twice.
  const again = applyAction(fired.state, 1, { type: "directive" });
  assert.equal(again.ok, false);
  assert.equal(again.ok === false && again.reason, "directive_already_active");
});

test("fighting is what charges a directive, for both sides", () => {
  const state = chargedMatch("crimson_alliance");
  state.players[0].directiveCharge = 0;
  state.players[1].directiveCharge = 0;

  const { state: staged, targetId } = (() => {
    const s = structuredClone(state);
    const target = Object.values(s.units).find((u) => u.ownerSlot === 2)!;
    s.units["gun"] = {
      id: "gun", unitType: "medium_tank", ownerSlot: 1,
      x: target.x, y: target.y - 1, hp: 100, fuel: 50, ammo: 8,
      hasMoved: false, hasActed: false, captureProgress: 0, cargo: [], carriedBy: null,
    };
    return { state: s, targetId: target.id };
  })();

  const fought = applyAction(staged, 1, { type: "attack", unitId: "gun", targetUnitId: targetId });
  assert.ok(fought.ok, fought.ok === false ? fought.reason : "");
  if (!fought.ok) return;

  assert.ok(fought.state.players[0].directiveCharge > 0, "the attacker charges");
  assert.ok(
    fought.state.players[1].directiveCharge > 0,
    "and so does the player who took the hit - being in the fight is what builds it",
  );
});

test("a directive lapses at the start of its owner's next turn", () => {
  const fired = applyAction(chargedMatch("crimson_alliance"), 1, { type: "directive" });
  assert.ok(fired.ok);
  if (!fired.ok) return;

  // Slot 1 ends, slot 2 ends, slot 1 opens again.
  const toTwo = applyAction(fired.state, 1, { type: "endTurn" });
  assert.ok(toTwo.ok);
  if (!toTwo.ok) return;
  assert.equal(
    toTwo.state.players[0].activeDirective, "overdrive",
    "it survives the opponent's turn - one turn means one of yours",
  );

  const backToOne = applyAction(toTwo.state, 2, { type: "endTurn" });
  assert.ok(backToOne.ok);
  if (!backToOne.ok) return;
  assert.equal(backToOne.state.players[0].activeDirective, null);
  assert.equal(backToOne.events.filter((e) => e.type === "directiveEnded").length, 1);
});

/** The same duel fought twice, with and without slot 1's directive up. */
function duelDamage(faction: string, withDirective: boolean): number {
  const base = chargedMatch(faction);
  const target = Object.values(base.units).find((u) => u.ownerSlot === 2)!;
  const staged = structuredClone(base);
  staged.units["gun"] = {
    id: "gun", unitType: "medium_tank", ownerSlot: 1,
    x: target.x, y: target.y - 1, hp: 100, fuel: 50, ammo: 8,
    hasMoved: false, hasActed: false, captureProgress: 0, cargo: [], carriedBy: null,
  };

  let fighting = staged;
  if (withDirective) {
    const fired = applyAction(staged, 1, { type: "directive" });
    assert.ok(fired.ok);
    if (!fired.ok) throw new Error("fixture");
    fighting = fired.state;
  }

  const result = applyAction(fighting, 1, { type: "attack", unitId: "gun", targetUnitId: target.id });
  assert.ok(result.ok, result.ok === false ? result.reason : "");
  if (!result.ok) throw new Error("fixture");
  const hit = result.events.find((e) => e.type === "unitAttacked");
  return hit && hit.type === "unitAttacked" ? hit.damage : -1;
}

test("Overdrive makes the same shot hit harder", () => {
  assert.ok(
    duelDamage("crimson_alliance", true) > duelDamage("crimson_alliance", false),
    "attack_pct has to reach the damage formula, not just the player record",
  );
});

test("Fortify makes the same shot hit softer", () => {
  // Verdant Union in slot 1 is the *defender* here, so the counter-attack is
  // what Fortify should blunt - measured on slot 1's own unit taking damage.
  const base = chargedMatch("verdant_union");
  const mine = Object.values(base.units).find((u) => u.ownerSlot === 1)!;

  const staged = structuredClone(base);
  staged.units["enemy"] = {
    id: "enemy", unitType: "medium_tank", ownerSlot: 2,
    x: mine.x, y: mine.y + 1, hp: 100, fuel: 50, ammo: 8,
    hasMoved: false, hasActed: false, captureProgress: 0, cargo: [], carriedBy: null,
  };
  staged.currentSlot = 2;

  const plain = applyAction(staged, 2, { type: "attack", unitId: "enemy", targetUnitId: mine.id });
  assert.ok(plain.ok, plain.ok === false ? plain.reason : "");

  const guarded = structuredClone(staged);
  guarded.players[0].activeDirective = "fortify";
  guarded.players[0].directiveTurnsLeft = 1;
  const shielded = applyAction(
    guarded, 2, { type: "attack", unitId: "enemy", targetUnitId: mine.id });
  assert.ok(shielded.ok, shielded.ok === false ? shielded.reason : "");
  if (!plain.ok || !shielded.ok) return;

  const dmg = (r: typeof plain) => {
    const e = r.ok ? r.events.find((x) => x.type === "unitAttacked") : undefined;
    return e && e.type === "unitAttacked" ? e.damage : -1;
  };
  assert.ok(dmg(shielded) < dmg(plain), "defense_pct has to reach the mitigation term");
});

test("Barrage extends artillery, and nothing else", () => {
  const state = chargedMatch("azure_federation");
  const target = Object.values(state.units).find((u) => u.ownerSlot === 2)!;

  const staged = structuredClone(state);
  // Artillery reaches 3 normally; park it at 4 so only Barrage can connect.
  staged.units["arty"] = {
    id: "arty", unitType: "artillery", ownerSlot: 1,
    x: target.x, y: target.y - 4, hp: 100, fuel: 50, ammo: 9,
    hasMoved: false, hasActed: false, captureProgress: 0, cargo: [], carriedBy: null,
  };
  // A spotter, since artillery cannot see that far itself.
  staged.units["eyes"] = {
    id: "eyes", unitType: "infantry", ownerSlot: 1,
    x: target.x, y: target.y - 1, hp: 100, fuel: 99, ammo: null,
    hasMoved: false, hasActed: false, captureProgress: 0, cargo: [], carriedBy: null,
  };

  const short = applyAction(staged, 1, { type: "attack", unitId: "arty", targetUnitId: target.id });
  assert.equal(short.ok, false, "four tiles is out of reach unaided");

  const fired = applyAction(staged, 1, { type: "directive" });
  assert.ok(fired.ok);
  if (!fired.ok) return;
  const reaching = applyAction(
    fired.state, 1, { type: "attack", unitId: "arty", targetUnitId: target.id });
  assert.ok(reaching.ok, reaching.ok === false ? reaching.reason : "");

  // But a tank does not become a sniper.
  const tankState = structuredClone(fired.state);
  tankState.units["tank"] = {
    id: "tank", unitType: "medium_tank", ownerSlot: 1,
    x: target.x, y: target.y - 2, hp: 100, fuel: 50, ammo: 8,
    hasMoved: false, hasActed: false, captureProgress: 0, cargo: [], carriedBy: null,
  };
  const sniping = applyAction(
    tankState, 1, { type: "attack", unitId: "tank", targetUnitId: target.id });
  assert.equal(sniping.ok, false, "indirect_range_bonus must not touch direct fire");
});

test("Uplink lifts the fog, and only for its owner", () => {
  const state = chargedMatch("solaris_directorate");
  const before = visibleTiles(state, 1).size;
  assert.ok(before < state.map.tiles.length, "fixture assumption: the map starts fogged");

  const fired = applyAction(state, 1, { type: "directive" });
  assert.ok(fired.ok);
  if (!fired.ok) return;

  assert.equal(
    visibleTiles(fired.state, 1).size, fired.state.map.tiles.length,
    "the whole map is visible to the player who spent the charge",
  );
  assert.ok(
    visibleTiles(fired.state, 2).size < fired.state.map.tiles.length,
    "and the opponent's fog is untouched",
  );

  // The view has to agree with vision, or the reveal is cosmetic.
  const revealed = buildPlayerView(fired.state, 1);
  assert.equal(revealed.visibleTiles.length, fired.state.map.tiles.length);
});

test("Blackout blinds the enemy, not its owner", () => {
  const state = chargedMatch("umbra_syndicate");
  const theirsBefore = visibleTiles(state, 2).size;
  const minebefore = visibleTiles(state, 1).size;

  const fired = applyAction(state, 1, { type: "directive" });
  assert.ok(fired.ok);
  if (!fired.ok) return;

  assert.ok(
    visibleTiles(fired.state, 2).size < theirsBefore,
    "the opponent should see less ground with Blackout running",
  );
  assert.equal(
    visibleTiles(fired.state, 1).size, minebefore,
    "and the player who fired it sees exactly as much as before",
  );
});

/* ------------------------------------------------------------------ */
/* Hotseat                                                             */
/* ------------------------------------------------------------------ */

/*
 * Verified against three mutations:
 *   - addPlayer's hotseat exemption removed: the second seat is refused
 *   - seatFor returning seats[0]: slot 2 can never take its turn
 *   - deliveries() ignoring state.hotseat: two views per action, and the
 *     "one seat at a time" check fails
 */

function hotseatMatch(): MatchState {
  const state = createMatch({
    matchId: "hotseat", mapId: "crossing", rngSeed: 99, hotseat: true,
  });
  const first = addPlayer(state, "one-device", "crimson_alliance");
  assert.ok(first.ok);
  if (!first.ok) throw new Error("fixture");
  const second = addPlayer(first.state, "one-device", "azure_federation");
  assert.ok(second.ok, second.ok === false ? second.reason : "");
  if (!second.ok) throw new Error("fixture");
  return second.state;
}

test("one device can hold both seats, and only in a hotseat match", () => {
  const shared = hotseatMatch();
  assert.equal(shared.players.length, 2);
  assert.equal(shared.players[0].playerId, shared.players[1].playerId);
  assert.notEqual(shared.players[0].slot, shared.players[1].slot);
  assert.equal(shared.phase, "active", "a hotseat match starts full");

  // An ordinary match still refuses it - this is the check hotseat lifts,
  // and lifting it everywhere would let a networked player take both sides.
  const networked = createMatch({ matchId: "normal", mapId: "crossing", rngSeed: 99 });
  const once = addPlayer(networked, "same-person", "crimson_alliance");
  assert.ok(once.ok);
  if (!once.ok) return;
  const twice = addPlayer(once.state, "same-person", "azure_federation");
  assert.equal(twice.ok, false);
  assert.equal(twice.ok === false && twice.reason, "already_joined");
});

test("the live seat is whoever's turn it is", () => {
  const state = hotseatMatch();
  assert.equal(seatFor(state, "one-device")?.slot, state.currentSlot);

  const passed = applyAction(state, state.currentSlot, { type: "endTurn" });
  assert.ok(passed.ok);
  if (!passed.ok) return;

  assert.equal(
    seatFor(passed.state, "one-device")?.slot, passed.state.currentSlot,
    "after the handover the same connection acts as the other seat",
  );
  assert.notEqual(
    seatFor(passed.state, "one-device")?.slot, seatFor(state, "one-device")?.slot,
    "which must actually be a different seat, or nobody ever gets a turn",
  );
});

test("a hotseat player still only ever sees one seat's fog at a time", () => {
  const state = hotseatMatch();
  const one = buildPlayerView(state, 1);
  const two = buildPlayerView(state, 2);

  // The two seats are genuinely different pictures of the same board - the
  // point being that the client is handed one of them, never the union.
  assert.notDeepEqual(
    one.visibleTiles, two.visibleTiles,
    "fixture assumption: the two seats see different ground",
  );
  assert.equal(one.players.find((p) => p.slot === 2)?.funds, null,
    "seat 1's view still hides seat 2's funds, even sharing a device");
  assert.equal(two.players.find((p) => p.slot === 1)?.funds, null);

  // And every unit in a seat's view is either its own or one it can see.
  for (const view of [one, two]) {
    for (const unit of view.units) {
      if (unit.ownerSlot === view.youSlot) continue;
      const index = (unit.y ?? 0) * state.map.width + (unit.x ?? 0);
      assert.ok(
        view.visibleTiles.includes(index),
        `seat ${view.youSlot} was sent an enemy unit it cannot see`,
      );
    }
  }
});

test("a hotseat match delivers one seat's payload, not two to one socket", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const nodePath = await import("node:path");
  const { FileMatchStore } = await import("../src/match/MatchStore");
  const { MatchService } = await import("../src/match/MatchService");

  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "redline-hotseat-"));
  const service = new MatchService(new FileMatchStore(dir));

  const created = await service.create("one-device", "crossing", "crimson_alliance", {
    hotseat: true, secondFaction: "azure_federation",
  });
  assert.ok(created.ok, created.ok === false ? created.reason : "");
  if (!created.ok) return;

  // Both seats share a playerId, so a payload per seat would be two frames
  // racing to the same socket with the loser deciding what is on screen.
  assert.equal(created.deliveries.length, 1, "one payload per connection, not per seat");
  const opening = created.deliveries[0].view;
  assert.equal(opening.youSlot, 1);

  // Acting through the one connection, and the handover swapping which seat
  // the next payload belongs to: this is the whole feature.
  const passed = await service.act("one-device", created.matchId!, { type: "endTurn" });
  assert.ok(passed.ok, passed.ok === false ? passed.reason : "");
  if (!passed.ok) return;
  assert.equal(passed.deliveries.length, 1);
  assert.equal(
    passed.deliveries[0].view.youSlot, 2,
    "after ending seat 1's turn the device is handed seat 2's own view",
  );
  assert.equal(passed.deliveries[0].view.currentSlot, 2);

  // And seat 2 can actually act, which is what seatFor is for.
  const theirTurn = await service.act("one-device", created.matchId!, { type: "endTurn" });
  assert.ok(theirTurn.ok, theirTurn.ok === false ? theirTurn.reason : "");
  if (!theirTurn.ok) return;
  assert.equal(theirTurn.deliveries[0].view.youSlot, 1, "and the device comes back to seat 1");

  fs.rmSync(dir, { recursive: true, force: true });
});
