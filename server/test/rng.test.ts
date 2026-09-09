/**
 * The seeded RNG.
 *
 * This file exists because the whole of it could be replaced with
 * `return { value: min, counter }` - luck always zero, the counter never
 * advancing - and every other test still passed. Reproducible matches,
 * resync-after-reconnect and "a modified client cannot reroll a bad hit" all
 * rest on this, and none of it was held to account.
 *
 * The pinned sequences below are regression anchors: changing the generator
 * changes them, which is the point. If you deliberately change the
 * algorithm, re-derive them and say so in the commit.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { nextRandom, rollInt } from "../src/game/rng";

/** Draws `count` values, threading the counter as the engine does. */
function sequence(seed: number, count: number, min = 0, max = 9): number[] {
  const out: number[] = [];
  let counter = 0;
  for (let i = 0; i < count; i++) {
    const roll = rollInt(seed, counter, min, max);
    out.push(roll.value);
    counter = roll.counter;
  }
  return out;
}

test("a seed produces one exact sequence", () => {
  assert.deepEqual(sequence(12345, 8), [2, 9, 3, 4, 8, 5, 3, 0]);
});

test("a different seed produces a different one", () => {
  assert.deepEqual(sequence(999, 8), [5, 9, 6, 3, 7, 4, 5, 0]);
  assert.notDeepEqual(sequence(999, 8), sequence(12345, 8));
});

test("the counter advances, so consecutive rolls differ", () => {
  const first = rollInt(12345, 0, 0, 9);
  assert.equal(first.counter, 1, "a roll that does not advance repeats forever");

  const second = rollInt(12345, first.counter, 0, 9);
  assert.equal(second.counter, 2);
  assert.notEqual(second.value, first.value, "the pinned sequence starts 2, 9");
});

test("replaying the same counter gives the same value", () => {
  // This is what makes a saved match replayable and a resync verifiable.
  assert.equal(rollInt(4242, 17, 0, 9).value, rollInt(4242, 17, 0, 9).value);
  assert.equal(nextRandom(1, 0), nextRandom(1, 0));
});

test("the whole range is reachable, and nothing outside it is", () => {
  const seen = new Set<number>();
  for (let counter = 0; counter < 2000; counter++) {
    const value = rollInt(7, counter, 0, 9).value;
    assert.ok(value >= 0 && value <= 9, `rolled ${value}`);
    seen.add(value);
  }
  assert.equal(seen.size, 10, `only saw ${[...seen].sort().join(",")}`);
});

test("the draw is not stuck at either end", () => {
  // A generator pinned to min (or max) would satisfy a range check while
  // making every combat identical - the exact mutation that went unnoticed.
  const draws = sequence(2024, 200);
  const atMin = draws.filter((v) => v === 0).length;
  assert.ok(atMin < draws.length / 2, `${atMin} of ${draws.length} draws were the minimum`);

  const distinct = new Set(draws);
  assert.ok(distinct.size >= 8, `only ${distinct.size} distinct values in 200 draws`);
});

test("bounds are honoured for a narrow range", () => {
  const seen = new Set<number>();
  for (let counter = 0; counter < 500; counter++) {
    const value = rollInt(11, counter, 3, 4).value;
    assert.ok(value === 3 || value === 4, `rolled ${value} outside 3..4`);
    seen.add(value);
  }
  assert.equal(seen.size, 2, "both ends of a two-value range must occur");
});

test("nextRandom stays in [0, 1)", () => {
  for (let counter = 0; counter < 500; counter++) {
    const value = nextRandom(31337, counter);
    assert.ok(value >= 0 && value < 1, `produced ${value}`);
  }
});
