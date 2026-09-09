extends PanelContainer
## Details for the unit in hand, and the forecast for an attack on it.
##
## Two jobs because they are the same question at different moments: "what am
## I working with" while choosing, and "what happens if I do this" once a
## target is armed. Splitting them into two panels would put the numbers you
## are comparing in two places.

@onready var _title: Label = $Margin/Column/Title
@onready var _stats: Label = $Margin/Column/Stats
@onready var _terrain: Label = $Margin/Column/Terrain
@onready var _forecast: Label = $Margin/Column/Forecast


func _ready() -> void:
	hide()


func show_unit(state: MatchState, unit: Dictionary) -> void:
	if state == null or unit.is_empty():
		hide()
		return

	var stats := GameData.unit_stats(String(unit.get("unitType", "")))
	var mine := int(unit.get("ownerSlot", 0)) == state.you_slot
	_title.text = String(stats.get("display_name", unit.get("unitType", "?")))
	_title.modulate = BoardTheme.slot_color(int(unit.get("ownerSlot", 0)))

	var parts: Array[String] = ["HP %d/10" % GameData.display_hp(int(unit.get("hp", 100)))]
	# Fuel and ammo are only sent for your own units - the server does not
	# tell you what an enemy is carrying, so do not draw an empty field.
	if mine and unit.get("fuel") != null:
		parts.append("Fuel %d" % int(unit["fuel"]))
	if mine and unit.get("ammo") != null:
		parts.append("Ammo %d" % int(unit["ammo"]))
	parts.append("Move %d" % int(stats.get("move", 0)))
	parts.append("Vision %d" % int(stats.get("vision", 0)))
	_stats.text = "   ".join(parts)

	var x := int(unit.get("x", 0))
	var y := int(unit.get("y", 0))
	var terrain := GameData.terrain_stats(state.terrain_at(x, y))
	_terrain.text = "%s   +%d%% defense" % [
		terrain.get("display_name", "?"), int(terrain.get("defense", 0))]

	_forecast.text = ""
	_forecast.hide()
	show()


## Adds the forecast line for an armed target. Shown as a range because the
## server rolls luck the client cannot see.
func show_forecast(state: MatchState, attacker: Dictionary, defender: Dictionary) -> void:
	show_unit(state, defender)

	var forecast := CombatForecast.predict(state, attacker, defender)
	if forecast.is_empty():
		_forecast.text = "Cannot attack this target"
		_forecast.modulate = Color("#9aa0ac")
		_forecast.show()
		return

	var damage := _range_text(int(forecast["damage_min"]), int(forecast["damage_max"]))
	var line := "Damage %s" % damage

	if bool(forecast["guaranteed_kill"]):
		line += "   destroys it"
	elif bool(forecast["lethal"]):
		line += "   may destroy it"

	var counter_max := int(forecast["counter_max"])
	if counter_max > 0:
		line += "   |   return fire %s" % _range_text(int(forecast["counter_min"]), counter_max)
	else:
		line += "   |   no return fire"

	_forecast.text = line
	_forecast.modulate = Color("#ffe08a")
	_forecast.show()


## Damage is shown in pips, matching how health reads everywhere else.
func _range_text(low: int, high: int) -> String:
	var low_pips := GameData.display_hp(low)
	var high_pips := GameData.display_hp(high)
	return str(low_pips) if low_pips == high_pips else "%d-%d" % [low_pips, high_pips]


func clear() -> void:
	hide()
