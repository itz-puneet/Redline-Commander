extends Node
## Checks the HUD: the damage forecast, the info panel, the top bar and the
## turn banner.
##
## The forecast checks matter most. server/test/engine.test.ts pins two exact
## duels ("reference duel on open road" / "into forest cover"); these assert
## the client's predicted range brackets them. Two implementations of one
## formula in two languages cannot drift without one of those suites failing.
##
##   cd client && godot --headless res://tests/hud_check.tscn

const MATCH_SCENE := preload("res://scenes/match.tscn")

var _failures := 0
var _phases := 0
var _match: Node = null
var _controller: Node = null
var _hud: Node = null
var _info: Node = null
var _top_bar: Node = null
var _banner: Node = null


func _ready() -> void:
	_check_forecast_matches_the_server()
	_check_forecast_edges()
	await _build_scene()
	if _controller == null:
		return
	await _check_info_panel()
	await _check_top_bar()
	await _check_banner()

	_check("every phase ran to completion", _phases == 3, "%d of 3" % _phases)

	if _match != null:
		_match.queue_free()
		await get_tree().process_frame

	if _failures == 0:
		print("\nhud_check: all checks passed")
	else:
		printerr("\nhud_check: %d check(s) FAILED" % _failures)
	get_tree().quit(0 if _failures == 0 else 1)


func _check(label: String, condition: bool, detail: String = "") -> void:
	if condition:
		print("ok   %s" % label)
	else:
		_failures += 1
		printerr("FAIL %s%s" % [label, "" if detail.is_empty() else " (%s)" % detail])


## --- the forecast ------------------------------------------------------

## Rebuilds the server's reference duels: a full-health Crimson light tank
## against a 90 HP Azure anti-tank infantry.
func _duel_state(defender_tile: Vector2i, attacker_tile: Vector2i) -> MatchState:
	var view := Fixtures.match_view(true)
	view["units"] = [
		{"id": "atk", "unitType": "light_tank", "ownerSlot": 1,
			"x": attacker_tile.x, "y": attacker_tile.y, "hp": 100, "fuel": 70, "ammo": 9,
			"hasMoved": false, "hasActed": false, "captureProgress": 0, "cargo": []},
		{"id": "def", "unitType": "anti_tank_infantry", "ownerSlot": 2,
			"x": defender_tile.x, "y": defender_tile.y, "hp": 90, "fuel": 70, "ammo": 3,
			"hasMoved": false, "hasActed": false, "captureProgress": 0, "cargo": []},
	]
	return MatchState.from_view(view)


func _check_forecast_matches_the_server() -> void:
	# Reference duel 1: open road, no cover. The server asserts damage lands
	# in 70..79 and the counter is floor(70 * (90 - damage) / 100).
	var road := _duel_state(Vector2i(7, 4), Vector2i(6, 4))
	_check("the reference tile really is cover-free",
		int(GameData.terrain_stats(road.terrain_at(7, 4)).get("defense", -1)) == 0,
		"got %s" % road.terrain_at(7, 4))

	var open := CombatForecast.predict(road, road.units["atk"], road.units["def"])
	_check("a forecast is produced for a legal attack", not open.is_empty())
	_check("open-ground damage brackets the server's 70..79",
		int(open["damage_min"]) == 70 and int(open["damage_max"]) == 79,
		"got %d..%d" % [open["damage_min"], open["damage_max"]])
	# Counter is floor(70 * hp_after / 100): 14 after a 70, 7 after a 79.
	_check("return fire brackets the server's 7..14",
		int(open["counter_min"]) == 7 and int(open["counter_max"]) == 14,
		"got %d..%d" % [open["counter_min"], open["counter_max"]])
	_check("a 90 HP target survives this", not bool(open["lethal"]))

	# Reference duel 2: forest, 30% defense scaled by 90 HP -> 0.73.
	var forest := _duel_state(Vector2i(13, 3), Vector2i(12, 3))
	_check("the reference cover tile really is forest", forest.terrain_at(13, 3) == "forest")

	var covered := CombatForecast.predict(forest, forest.units["atk"], forest.units["def"])
	_check("forest damage brackets the server's floor(70*0.73)..floor(79*0.73)",
		int(covered["damage_min"]) == floori(70 * 0.73)
		and int(covered["damage_max"]) == floori(79 * 0.73),
		"got %d..%d" % [covered["damage_min"], covered["damage_max"]])
	_check("cover reduces the damage",
		int(covered["damage_max"]) < int(open["damage_min"]),
		"%d vs %d" % [covered["damage_max"], open["damage_min"]])
	_check("and a unit in cover hits back harder, being healthier",
		int(covered["counter_min"]) > int(open["counter_min"]),
		"%d vs %d" % [covered["counter_min"], open["counter_min"]])


func _check_forecast_edges() -> void:
	var state := _duel_state(Vector2i(7, 4), Vector2i(6, 4))

	# Out of range: adjacent-only weapons cannot reach across the map.
	var far: Dictionary = state.units["def"].duplicate()
	far["x"] = 12
	_check("a target out of range yields no forecast",
		CombatForecast.predict(state, state.units["atk"], far).is_empty())

	# A matchup with no damage entry at all.
	var jet := {"id": "j", "unitType": "fighter_jet", "ownerSlot": 1, "x": 6, "y": 4,
		"hp": 100, "ammo": 9}
	_check("a fighter cannot engage ground at all",
		CombatForecast.predict(state, jet, state.units["def"]).is_empty())

	# Out of ammo.
	var dry: Dictionary = state.units["atk"].duplicate()
	dry["ammo"] = 0
	_check("an empty magazine yields no forecast",
		CombatForecast.predict(state, dry, state.units["def"]).is_empty())

	# A wounded attacker hits for less.
	var hurt: Dictionary = state.units["atk"].duplicate()
	hurt["hp"] = 50
	var weak := CombatForecast.predict(state, hurt, state.units["def"])
	var full := CombatForecast.predict(state, state.units["atk"], state.units["def"])
	_check("a wounded attacker forecasts less damage",
		int(weak["damage_max"]) < int(full["damage_min"]),
		"%d vs %d" % [weak["damage_max"], full["damage_min"]])

	# A finished-off target cannot return fire, and the kill is flagged.
	var doomed: Dictionary = state.units["def"].duplicate()
	doomed["hp"] = 20
	var kill := CombatForecast.predict(state, state.units["atk"], doomed)
	_check("a lethal attack is flagged as one", bool(kill["guaranteed_kill"]))
	_check("and a corpse does not shoot back", int(kill["counter_max"]) == 0)

	# Indirect fire is never countered, even in range.
	var artillery := {"id": "art", "unitType": "artillery", "ownerSlot": 1,
		"x": 5, "y": 4, "hp": 100, "ammo": 9}
	var shelled := CombatForecast.predict(state, artillery, state.units["def"])
	_check("artillery in range gets a forecast", not shelled.is_empty())
	_check("and takes no return fire", int(shelled["counter_max"]) == 0)


## --- the panels --------------------------------------------------------

func _build_scene(view: Dictionary = {}) -> void:
	if _match != null:
		_match.queue_free()
		await get_tree().process_frame

	_match = MATCH_SCENE.instantiate()
	add_child(_match)
	_controller = _match.get_node_or_null("MatchController")
	_hud = _match.get_node_or_null("UI/Hud")
	if _controller == null or _hud == null:
		printerr("hud_check: the match scene failed to build - see the errors above")
		get_tree().quit(1)
		return

	_info = _hud.get_node("UnitInfo")
	_top_bar = _hud.get_node("TopBar")
	_banner = _hud.get_node("TurnBanner")
	_controller.set_animation_scale(0.0)
	_controller.load_view(view if not view.is_empty() else Fixtures.match_view())
	await get_tree().process_frame


func _info_text(node_name: String) -> String:
	return (_info.get_node("Margin/Column/" + node_name) as Label).text


func _check_info_panel() -> void:
	_check("the panel is hidden with nothing selected", not _info.visible)

	_controller.tap_tile(Vector2i(6, 4))
	_check("selecting a unit shows the panel", _info.visible)
	_check("naming it", _info_text("Title") == "Light Tank", "got '%s'" % _info_text("Title"))
	_check("with its health in pips", _info_text("Stats").contains("HP 10/10"),
		"got '%s'" % _info_text("Stats"))
	_check("its fuel, since it is ours", _info_text("Stats").contains("Fuel"))
	_check("and the terrain it stands on", _info_text("Terrain").contains("Road"),
		"got '%s'" % _info_text("Terrain"))
	_check("no forecast before a target is armed", _info_text("Forecast").is_empty())

	# Arming a target switches the panel to the forecast against it.
	_controller.tap_tile(Vector2i(7, 4))
	_check("arming a target names the target", _info_text("Title") == "Anti-Tank Infantry",
		"got '%s'" % _info_text("Title"))
	_check("and shows a damage forecast", _info_text("Forecast").contains("Damage"),
		"got '%s'" % _info_text("Forecast"))
	_check("mentioning return fire", _info_text("Forecast").contains("return fire"),
		"got '%s'" % _info_text("Forecast"))
	_check("an enemy's fuel is not shown - we cannot see it",
		not _info_text("Stats").contains("Fuel"), "got '%s'" % _info_text("Stats"))

	_controller.clear_selection()
	_check("deselecting hides the panel again", not _info.visible)

	# The panel overlays the board, so it must stay in a corner rather than
	# spanning the width and hiding whole rows of the map.
	_check("the panel leaves most of the board uncovered",
		_info.size.x <= get_viewport().get_visible_rect().size.x * 0.5,
		"%f wide of %f" % [_info.size.x, get_viewport().get_visible_rect().size.x])
	_phases += 1


func _check_top_bar() -> void:
	var row := "Margin/Row/"
	_check("the top bar says whose turn it is",
		(_top_bar.get_node(row + "Turn") as Label).text == "Your turn",
		"got '%s'" % (_top_bar.get_node(row + "Turn") as Label).text)
	_check("which round it is",
		(_top_bar.get_node(row + "Round") as Label).text == "Round 4")
	_check("and what we can spend",
		(_top_bar.get_node(row + "Funds") as Label).text == "5000 funds",
		"got '%s'" % (_top_bar.get_node(row + "Funds") as Label).text)

	var theirs := Fixtures.match_view()
	theirs["currentSlot"] = 2
	_controller.load_view(theirs)
	_check("and updates when the turn passes",
		(_top_bar.get_node(row + "Turn") as Label).text == "Opponent's turn")

	var won := Fixtures.match_view()
	won["phase"] = "finished"
	won["winnerSlot"] = 1
	_controller.load_view(won)
	_check("a win is reported", (_top_bar.get_node(row + "Turn") as Label).text == "Victory")

	var lost := Fixtures.match_view()
	lost["phase"] = "finished"
	lost["winnerSlot"] = 2
	_controller.load_view(lost)
	_check("and so is a loss", (_top_bar.get_node(row + "Turn") as Label).text == "Defeat")

	# Presence arrives on its own message, outside any view, because nothing
	# about the board changed. In a game where a turn can arrive hours later,
	# an absent opponent and a thinking one look identical without this.
	_controller.load_view(Fixtures.match_view())
	_check("an opponent present is not remarked on",
		not (_top_bar.get_node(row + "Turn") as Label).text.contains("offline"))

	Net.opponent_connection_changed.emit(2, false)
	await get_tree().process_frame
	_check("a dropped opponent is shown as offline",
		(_top_bar.get_node(row + "Turn") as Label).text.contains("offline"),
		"got '%s'" % (_top_bar.get_node(row + "Turn") as Label).text)

	Net.opponent_connection_changed.emit(2, true)
	await get_tree().process_frame
	_check("and cleared when they come back",
		not (_top_bar.get_node(row + "Turn") as Label).text.contains("offline"))
	_phases += 1


func _check_banner() -> void:
	await _build_scene()
	_check("no banner on the first view - nothing changed yet", not _banner.is_showing())

	var theirs := Fixtures.match_view()
	theirs["currentSlot"] = 2
	_controller.load_view(theirs)
	await get_tree().process_frame
	_check("the turn passing announces it", _banner.text == "Opponent's turn",
		"got '%s'" % _banner.text)

	# refresh() runs on every server message, not just interesting ones.
	_controller.load_view(theirs)
	_banner.text = "untouched"
	_controller.load_view(theirs)
	await get_tree().process_frame
	_check("an unchanged turn announces nothing", _banner.text == "untouched",
		"got '%s'" % _banner.text)

	var mine := Fixtures.match_view()
	mine["roundNumber"] = 5
	_controller.load_view(mine)
	await get_tree().process_frame
	_check("the turn coming back announces it", _banner.text == "Your turn",
		"got '%s'" % _banner.text)
	_phases += 1
