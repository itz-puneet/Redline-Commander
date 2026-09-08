extends Node
## Checks production: costs, the menu, and what a tap on a factory does.
##
## The cost assertions matter most. The client shows a price and the server
## charges one, and the two are computed by different code in different
## languages - so these assert the same figures the server's engine tests
## assert, which is what catches a drift between them.
##
##   cd client && godot --headless res://tests/build_check.tscn

const MATCH_SCENE := preload("res://scenes/match.tscn")

## Slot 1's base on the shipped map.
const FACTORY := Vector2i(2, 0)
const AIRPORT := Vector2i(1, 3)

var _failures := 0
var _match: Node = null
var _controller: Node = null
var _menu: Node = null
var _sent: Array[Dictionary] = []
## Phases that ran to completion. A suite that stops early must not be able
## to report success - which it can if a phase containing an await is called
## without one, and _ready races past it to the summary.
var _phases := 0


func _ready() -> void:
	_check_costs()
	await _build_scene()
	if _controller == null:
		return
	await _check_menu_contents()
	await _check_tap_opens_menu()
	await _check_building()
	await _check_menu_closes()

	_check("every phase ran to completion", _phases == 4, "%d of 4" % _phases)

	if _match != null:
		_match.queue_free()
		await get_tree().process_frame

	if _failures == 0:
		print("\nbuild_check: all checks passed")
	else:
		printerr("\nbuild_check: %d check(s) FAILED" % _failures)
	get_tree().quit(0 if _failures == 0 else 1)


func _check(label: String, condition: bool, detail: String = "") -> void:
	if condition:
		print("ok   %s" % label)
	else:
		_failures += 1
		printerr("FAIL %s%s" % [label, "" if detail.is_empty() else " (%s)" % detail])


## --- costs -------------------------------------------------------------

func _check_costs() -> void:
	# Same figures as server/test/engine.test.ts asserts.
	_check("a plain faction pays list price",
		GameData.build_cost("light_tank", "crimson_alliance") == 700,
		"got %d" % GameData.build_cost("light_tank", "crimson_alliance"))
	_check("Azure's discount applies to artillery",
		GameData.build_cost("artillery", "azure_federation") == 480,
		"got %d" % GameData.build_cost("artillery", "azure_federation"))
	_check("Azure's discount applies to ships",
		GameData.build_cost("transport_ship", "azure_federation") == 400,
		"got %d" % GameData.build_cost("transport_ship", "azure_federation"))
	_check("Azure pays list price for what it has no discount on",
		GameData.build_cost("light_tank", "azure_federation") == 700)
	_check("Umbra's global surcharge applies to everything",
		GameData.build_cost("light_tank", "umbra_syndicate") == 770
		and GameData.build_cost("infantry", "umbra_syndicate") == 110,
		"got %d and %d" % [GameData.build_cost("light_tank", "umbra_syndicate"),
			GameData.build_cost("infantry", "umbra_syndicate")])
	_check("an unknown faction falls back to list price",
		GameData.build_cost("light_tank", "nobody") == 700)
	_check("an unknown unit costs nothing rather than erroring",
		GameData.build_cost("battlecruiser", "crimson_alliance") == 0)

	# Terrain decides what can be produced, from the same data.
	var factory := GameData.buildable_at("factory")
	_check("factories build ground units only",
		factory.has("infantry") and factory.has("heavy_tank")
		and not factory.has("fighter_jet") and not factory.has("transport_ship"),
		"got %s" % [factory])
	_check("airports build aircraft",
		GameData.buildable_at("airport") == ["helicopter", "fighter_jet"],
		"got %s" % [GameData.buildable_at("airport")])
	_check("ports build ships",
		GameData.buildable_at("port") == ["transport_ship"])
	_check("a city builds nothing", GameData.buildable_at("city").is_empty())


## --- the menu ----------------------------------------------------------

func _build_scene(view: Dictionary = {}) -> void:
	if _match != null:
		_match.queue_free()
		await get_tree().process_frame

	_match = MATCH_SCENE.instantiate()
	add_child(_match)
	_controller = _match.get_node_or_null("MatchController")
	_menu = _match.get_node_or_null("UI/BuildMenu")
	if _controller == null or _menu == null:
		printerr("build_check: the match scene failed to build - see the errors above")
		get_tree().quit(1)
		return
	_controller.set_animation_scale(0.0)

	var turns: TurnController = _match.get_node("TurnController")
	turns.action_sent.connect(func(action: Dictionary): _sent.append(action))

	_controller.load_view(view if not view.is_empty() else Fixtures.match_view())
	_sent.clear()
	await get_tree().process_frame


func _check_menu_contents() -> void:
	_check("the menu starts closed", not _menu.is_open())

	# The fixture player is Crimson with 5000 funds.
	_menu.open_for("factory", FACTORY, 5000, "crimson_alliance")
	_check("the menu lists everything the factory builds",
		_menu.option_count() == GameData.buildable_at("factory").size(),
		"%d options" % _menu.option_count())
	_check("all of it is affordable at 5000",
		_menu.affordable_count() == _menu.option_count(),
		"%d of %d" % [_menu.affordable_count(), _menu.option_count()])
	_check("options show name and price",
		_menu.option_labels()[0].contains("Infantry") and _menu.option_labels()[0].contains("100"),
		"got '%s'" % _menu.option_labels()[0])

	# Poor: only what can be paid for is pressable, but the rest stays
	# visible so the player can see what they are saving toward.
	_menu.open_for("factory", FACTORY, 350, "crimson_alliance")
	_check("a poor player still sees every option",
		_menu.option_count() == GameData.buildable_at("factory").size())
	_check("but can only press what they can afford",
		_menu.affordable_count() == 2,
		"%d affordable at 350" % _menu.affordable_count())

	# Reopening must not accumulate the previous tile's options.
	_menu.open_for("airport", AIRPORT, 5000, "crimson_alliance")
	_check("reopening replaces the options rather than appending",
		_menu.option_count() == 2, "%d options" % _menu.option_count())
	_check("and the menu knows which tile it is for", _menu.tile() == AIRPORT)

	# The panel sizes to its options: a factory with seven needs more room
	# than an airport with two, and a fixed height clips one or wastes the
	# other.
	var airport_height: float = -_menu.offset_top
	_menu.open_for("factory", FACTORY, 5000, "crimson_alliance")
	var factory_height: float = -_menu.offset_top
	_check("the menu is taller for a factory than an airport",
		factory_height > airport_height,
		"%f vs %f" % [factory_height, airport_height])
	_check("and tall enough to show every option without scrolling",
		factory_height >= _menu.CHROME_HEIGHT
			+ ceili(_menu.option_count() / 2.0) * _menu.ROW_HEIGHT,
		"%f for %d options" % [factory_height, _menu.option_count()])
	_menu.close()
	_phases += 1

func _check_tap_opens_menu() -> void:
	_controller.tap_tile(FACTORY)
	_check("tapping our own empty factory opens the menu", _controller.build_menu_is_open())
	_check("and nothing is submitted by opening it", _sent.is_empty())
	_menu.close()

	_check("our airport is buildable", _controller.can_build_at(AIRPORT))
	_check("a plain tile is not", not _controller.can_build_at(Vector2i(6, 5)))
	_check("a city is not - it produces income, not units",
		not _controller.can_build_at(Vector2i(1, 0)))
	_check("the enemy's factory is not ours to use",
		not _controller.can_build_at(Vector2i(12, 9)))

	# A factory with a unit parked on it cannot produce.
	var occupied := Fixtures.match_view()
	for unit in occupied["units"]:
		if String(unit["id"]) == "a4":
			unit["x"] = FACTORY.x
			unit["y"] = FACTORY.y
	await _build_scene(occupied)
	_check("an occupied factory cannot build", not _controller.can_build_at(FACTORY))
	_controller.tap_tile(FACTORY)
	_check("and tapping it selects the unit standing there instead",
		_controller.selected_unit_id() == "a4" and not _controller.build_menu_is_open())

	# Not on the opponent's turn.
	var theirs := Fixtures.match_view()
	theirs["currentSlot"] = 2
	await _build_scene(theirs)
	_check("nothing is buildable on the opponent's turn",
		not _controller.can_build_at(FACTORY))
	_controller.tap_tile(FACTORY)
	_check("and tapping a factory then does nothing", not _controller.build_menu_is_open())
	_phases += 1

func _check_building() -> void:
	await _build_scene()
	_controller.tap_tile(FACTORY)
	_check("menu open before choosing", _controller.build_menu_is_open())

	_menu.unit_chosen.emit("light_tank")
	var action: Dictionary = _sent[-1] if not _sent.is_empty() else {}
	_check("choosing a unit submits a build",
		String(action.get("type", "")) == "build", "got %s" % action.get("type", "nothing"))
	_check("naming the unit type", String(action.get("unitType", "")) == "light_tank")
	_check("and the tile it is built on",
		int(action.get("at", {}).get("x", -1)) == FACTORY.x
		and int(action.get("at", {}).get("y", -1)) == FACTORY.y,
		"got %s" % [action.get("at", {})])
	_phases += 1

func _check_menu_closes() -> void:
	await _build_scene()

	_controller.tap_tile(FACTORY)
	_check("open again", _controller.build_menu_is_open())
	_controller.tap_tile(Vector2i(6, 5))
	_check("a tap on the board dismisses the menu", not _controller.build_menu_is_open())
	_check("and that tap does nothing else", _controller.selected_unit_id().is_empty())

	_controller.tap_tile(FACTORY)
	_check("open once more", _controller.build_menu_is_open())

	# The turn passing while the menu is up must close it.
	var theirs := Fixtures.match_view()
	theirs["currentSlot"] = 2
	_controller.load_view(theirs)
	_check("the turn passing closes the menu", not _controller.build_menu_is_open())

	# A unit appearing on the tile must close it too.
	_controller.load_view(Fixtures.match_view())
	_controller.tap_tile(FACTORY)
	_check("open for the last time", _controller.build_menu_is_open())

	var built := Fixtures.match_view()
	built["units"].append({
		"id": "new1", "unitType": "light_tank", "ownerSlot": 1,
		"x": FACTORY.x, "y": FACTORY.y, "hp": 100, "fuel": 70, "ammo": 9,
		"hasMoved": true, "hasActed": true, "captureProgress": 0, "cargo": [],
	})
	_controller.load_view(built)
	_check("a unit appearing on the tile closes the menu",
		not _controller.build_menu_is_open())
	_phases += 1