class_name CombatForecast
extends RefCounted
## Predicts the outcome of an attack, so the player can look before leaping.
##
## NOT authoritative - like MovementPreview, this exists to draw a number on
## screen. The server rolls the luck and decides what actually happens.
##
## Mirrors computeDamage()/resolveCombat() in server/src/game/combat.ts:
##
##   raw        = base[att][def] x attack modifier x (attackerHP / 100)
##   mitigation = 1 - (terrain defense / 100) x (defenderHP / 100)
##   damage     = floor((raw + luck) x mitigation),  luck 0..9
##
## Luck is why this reports a RANGE rather than a number: the client cannot
## know the roll, and pretending to would be a lie the server then contradicts.
## server/test/engine.test.ts pins two exact duels, and hud_check asserts this
## brackets them - neither implementation can drift without a test going red.

const LUCK_MIN := 0
const LUCK_MAX := 9


## Returns {} when the attack is not possible at all. Otherwise:
##   damage_min / damage_max      what the target would lose
##   counter_min / counter_max    what comes back, 0 if it cannot
##   lethal                       true when even the luckiest roll kills
##   guaranteed_kill              true when even the unluckiest roll kills
static func predict(state: MatchState, attacker: Dictionary, defender: Dictionary) -> Dictionary:
	if not can_engage(state, attacker, defender):
		return {}

	var damage_min := _damage(state, attacker, defender, int(attacker.get("hp", 100)), LUCK_MIN)
	var damage_max := _damage(state, attacker, defender, int(attacker.get("hp", 100)), LUCK_MAX)

	# The counter is whatever the defender can still manage afterwards, so the
	# best roll for the attacker is the worst one for the return fire.
	var counter_min := _counter(state, attacker, defender, damage_max)
	var counter_max := _counter(state, attacker, defender, damage_min)

	return {
		"damage_min": damage_min,
		"damage_max": damage_max,
		"counter_min": counter_min,
		"counter_max": counter_max,
		"lethal": damage_max >= int(defender.get("hp", 100)),
		"guaranteed_kill": damage_min >= int(defender.get("hp", 100)),
	}


static func can_engage(state: MatchState, attacker: Dictionary, defender: Dictionary) -> bool:
	var stats := GameData.unit_stats(String(attacker.get("unitType", "")))
	if stats.is_empty() or stats.get("fire_mode") == null:
		return false

	var ammo: Variant = attacker.get("ammo")
	if stats.get("max_ammo") != null and ammo != null and int(ammo) <= 0:
		return false
	if GameData.base_damage(String(attacker.get("unitType", "")),
			String(defender.get("unitType", ""))) <= 0:
		return false

	var range_to := absi(int(attacker.get("x", 0)) - int(defender.get("x", 0))) \
		+ absi(int(attacker.get("y", 0)) - int(defender.get("y", 0)))
	return range_to >= int(stats.get("min_range", 1)) and range_to <= int(stats.get("max_range", 1))


static func _damage(state: MatchState, attacker: Dictionary, defender: Dictionary,
		attacker_hp: int, luck: int) -> int:
	var base := GameData.base_damage(String(attacker.get("unitType", "")),
		String(defender.get("unitType", "")))
	if base <= 0:
		return 0

	var raw := float(base) * _attack_multiplier(state, attacker) * (attacker_hp / 100.0)
	var mitigation := 1.0 - (_terrain_defense(state, defender) / 100.0) \
		* (int(defender.get("hp", 100)) / 100.0)
	return maxi(0, floori((raw + luck) * mitigation))


## Return fire, under the server's conditions: only between two direct-fire
## units, only if the defender survives, and never with a luck roll.
static func _counter(state: MatchState, attacker: Dictionary, defender: Dictionary,
		damage: int) -> int:
	var hp_after := int(defender.get("hp", 100)) - damage
	if hp_after <= 0:
		return 0

	var attacker_stats := GameData.unit_stats(String(attacker.get("unitType", "")))
	var defender_stats := GameData.unit_stats(String(defender.get("unitType", "")))
	if String(attacker_stats.get("fire_mode", "")) != "direct" \
			or String(defender_stats.get("fire_mode", "")) != "direct":
		return 0

	var ammo: Variant = defender.get("ammo")
	if defender_stats.get("max_ammo") != null and ammo != null and int(ammo) <= 0:
		return 0
	if not can_engage(state, defender, attacker):
		return 0

	# The defender fires at its post-damage strength, at the attacker's
	# current health - which is what the server uses too.
	var wounded := defender.duplicate()
	wounded["hp"] = hp_after
	return _damage(state, wounded, attacker, hp_after, 0)


static func _faction_of(state: MatchState, slot: int) -> Dictionary:
	for player in state.players:
		if int(player.get("slot", 0)) == slot:
			return GameData.factions.get(String(player.get("faction", "")), {})
	return {}


static func _attack_multiplier(state: MatchState, unit: Dictionary) -> float:
	var modifiers: Dictionary = _faction_of(state, int(unit.get("ownerSlot", 0))).get("modifiers", {})
	return 1.0 + float(modifiers.get("global_attack_pct", 0)) / 100.0


static func _terrain_defense(state: MatchState, unit: Dictionary) -> float:
	var x := int(unit.get("x", 0))
	var y := int(unit.get("y", 0))
	var terrain_id := state.terrain_at(x, y)
	var terrain := GameData.terrain_stats(terrain_id)
	if terrain.is_empty():
		return 0.0

	var modifiers: Dictionary = _faction_of(state, int(unit.get("ownerSlot", 0))).get("modifiers", {})
	var bonus := float(modifiers.get("terrain_defense_bonus_pct", {}).get(terrain_id, 0))
	return float(terrain.get("defense", 0)) + bonus
