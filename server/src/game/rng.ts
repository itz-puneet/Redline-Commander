/**
 * Deterministic, seeded RNG.
 *
 * Combat luck lives on the server only, and the seed + counter live inside
 * MatchState. That means a saved match replays identically, a reconnecting
 * client resyncs to exactly the state it left, and a modified client cannot
 * reroll a bad hit. Never call Math.random() in the rules engine.
 */

/** mulberry32 - small, fast, good enough for damage rolls. */
export function nextRandom(seed: number, counter: number): number {
  let t = (seed + counter * 0x6d2b79f5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Returns an integer in [min, max] inclusive, plus the counter to store back. */
export function rollInt(
  seed: number,
  counter: number,
  min: number,
  max: number,
): { value: number; counter: number } {
  const r = nextRandom(seed, counter);
  return { value: min + Math.floor(r * (max - min + 1)), counter: counter + 1 };
}
