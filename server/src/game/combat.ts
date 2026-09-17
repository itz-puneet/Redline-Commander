/**
 * Combat resolution.
 *
 * The exact formula, written down once so client-side damage previews and
 * the authoritative result cannot drift:
 *
 *   base       = damage_matrix[attackerType][defenderType]        (percent)
 *   attackMod  = 1 + (faction global_attack_pct + directive attack_pct)/100
 *   raw        = base * attackMod * (attackerHp / 100)
 *   terrainDef = terrain.defense + faction terrain bonus
 *                + directive defense_pct                          (percent)
 *   mitigation = 1 - (terrainDef / 100) * (defenderHp / 100)
 *   luck       = integer 0..9, from the match's seeded RNG (server only)
 *   damage     = floor((raw + luck) * mitigation)
 *
 * Terrain defense scales with the defender's remaining HP: a nearly dead
 * unit gets little benefit from cover. Luck is added before mitigation so
 * cover dampens lucky rolls too.
 *
 * The directive terms are zero unless that player has a Field Directive
 * running this turn (see doDirective in engine.ts). They are part of the
 * formula rather than a special case on top of it, because the client's
 * forecast mirrors this and the two must not disagree about a number the
 * player is shown before committing.
 *
 * A defender that survives a DIRECT attack counters, using the same formula
 * with roles swapped and its own post-damage HP, but with no luck roll.
 * Indirect-fire units neither counter nor are countered.
 */

import {
  DAMAGE_MATRIX, FACTIONS, directiveEffect, terrainStats, tileAt, unitStats,
} from "./data";
import { manhattan } from "./movement";
import { rollInt } from "./rng";
import type { MatchState, Unit } from "./types";

export function baseDamage(attackerType: string, defenderType: string): number {
  return DAMAGE_MATRIX[attackerType]?.[defenderType] ?? 0;
}

export function canEngage(state: MatchState, attacker: Unit, defender: Unit): boolean {
  const stats = unitStats(attacker.unitType);
  if (!stats || stats.fire_mode === null) return false;
  if (stats.max_ammo !== null && attacker.ammo !== null && attacker.ammo <= 0) return false;
  if (baseDamage(attacker.unitType, defender.unitType) <= 0) return false;

  // Barrage extends indirect fire only - it is an artillery order, and on a
  // direct-fire unit it would silently turn tanks into snipers.
  const reach = stats.fire_mode === "indirect"
    ? activeEffect(state, attacker.ownerSlot, "indirect_range_bonus")
    : 0;
  const range = manhattan(attacker, defender);
  return range >= stats.min_range && range <= stats.max_range + reach;
}

function factionOf(state: MatchState, slot: number): string {
  return state.players.find((p) => p.slot === slot)?.faction ?? "crimson_alliance";
}

/** A slot's contribution from its running directive, 0 when none is. */
export function activeEffect(state: MatchState, slot: number, key: string): number {
  const player = state.players.find((p) => p.slot === slot);
  if (!player) return 0;
  return directiveEffect(player.faction, player.activeDirective, key);
}

function terrainDefenseFor(state: MatchState, unit: Unit): number {
  const tile = tileAt(state.map, unit.x, unit.y);
  const terrain = tile ? terrainStats(tile.terrain) : undefined;
  if (!tile || !terrain) return 0;

  const faction = FACTIONS[factionOf(state, unit.ownerSlot)];
  const bonus = faction?.modifiers.terrain_defense_bonus_pct?.[tile.terrain] ?? 0;
  // Fortify adds flat defence wherever the unit is standing, so it helps in
  // the open - which is the point of it.
  return terrain.defense + bonus + activeEffect(state, unit.ownerSlot, "defense_pct");
}

function attackMultiplier(state: MatchState, unit: Unit): number {
  const faction = FACTIONS[factionOf(state, unit.ownerSlot)];
  const passive = faction?.modifiers.global_attack_pct ?? 0;
  return 1 + (passive + activeEffect(state, unit.ownerSlot, "attack_pct")) / 100;
}

function computeDamage(
  state: MatchState,
  attacker: Unit,
  defender: Unit,
  attackerHp: number,
  luck: number,
): number {
  const base = baseDamage(attacker.unitType, defender.unitType);
  if (base <= 0) return 0;

  const raw = base * attackMultiplier(state, attacker) * (attackerHp / 100);
  const mitigation = 1 - (terrainDefenseFor(state, defender) / 100) * (defender.hp / 100);
  return Math.max(0, Math.floor((raw + luck) * mitigation));
}

export interface CombatOutcome {
  damage: number;
  counterDamage: number;
  /** Store back into MatchState so the RNG stream stays reproducible. */
  rngCounter: number;
}

/**
 * Pure: reads `state` but mutates nothing. The caller applies the HP/ammo
 * changes, so the engine keeps a single place where state changes happen.
 */
export function resolveCombat(state: MatchState, attacker: Unit, defender: Unit): CombatOutcome {
  const roll = rollInt(state.rngSeed, state.rngCounter, 0, 9);
  const damage = computeDamage(state, attacker, defender, attacker.hp, roll.value);

  const defenderHpAfter = defender.hp - damage;
  let counterDamage = 0;

  const attackerStats = unitStats(attacker.unitType);
  const defenderStats = unitStats(defender.unitType);
  const bothDirect =
    attackerStats?.fire_mode === "direct" && defenderStats?.fire_mode === "direct";
  const defenderHasAmmo =
    defenderStats?.max_ammo === null || defender.ammo === null || defender.ammo > 0;

  if (
    defenderHpAfter > 0 &&
    bothDirect &&
    defenderHasAmmo &&
    canEngage(state, defender, attacker)
  ) {
    counterDamage = computeDamage(state, defender, attacker, defenderHpAfter, 0);
  }

  return { damage, counterDamage, rngCounter: roll.counter };
}

/** Health as the player sees it: 10 pips, never showing 0 for a live unit. */
export function displayHp(hp: number): number {
  return hp <= 0 ? 0 : Math.max(1, Math.ceil(hp / 10));
}
