extends Node
## Headless boot check for the client.
##
## The server has `npm test`; this is the equivalent for the Godot side. It
## does not need a display, a server, or a human: it boots the project,
## proves the autoloads came up and the data tables parsed, and exercises the
## pure client-side logic (MatchState, MovementPreview) against a synthetic
## view of the shipped map.
##
##   cd client && godot --headless res://tests/boot_check.tscn
##
## Exits non-zero if anything fails, so it works in CI.

var _failures := 0


func _ready() -> void:
	_check_autoloads()
	_check_data_tables()
	_check_match_state()
	_check_movement_preview()
	_check_path_through_friendly()
	_check_attack_needs_ammo()

	if _failures == 0:
		print("\nboot_check: all checks passed")
	else:
		printerr("\nboot_check: %d check(s) FAILED" % _failures)
	get_tree().quit(0 if _failures == 0 else 1)


func _check(label: String, condition: bool, detail: String = "") -> void:
	if condition:
		print("ok   %s" % label)
	else:
		_failures += 1
		printerr("FAIL %s%s" % [label, "" if detail.is_empty() else " (%s)" % detail])


func _check_autoloads() -> void:
	_check("GameData autoload is up", GameData != null)
	_check("PlayerIdentity autoload is up", PlayerIdentity != null)
	_check("Net autoload is up", Net != null)
	_check("this install has a stable player id", not PlayerIdentity.player_id.is_empty())
	_check("Net starts with no match attached", Net.current_match_id.is_empty())


func _check_data_tables() -> void:
	_check("units.json loaded", GameData.units.size() >= 10,
		"got %d unit types" % GameData.units.size())
	# Shape rather than count: a table that grows should not fail a test,
	# but a unit missing a field the board reads should.
	var malformed: Array = []
	for unit_type in GameData.units:
		for field in ["display_name", "cost", "move", "move_type", "vision",
				"fire_mode", "min_range", "max_range", "built_at"]:
			if not (GameData.units[unit_type] as Dictionary).has(field):
				malformed.append("%s is missing %s" % [unit_type, field])
	_check("every unit carries the fields the client reads",
		malformed.is_empty(), str(malformed))
	_check("terrain.json loaded", GameData.terrain.size() == 13,
		"got %d terrain types" % GameData.terrain.size())
	_check("factions.json loaded", GameData.factions.size() == 5,
		"got %d factions" % GameData.factions.size())

	# The same numbers the server's engine tests assert on, read through the
	# client's own accessors - this is what catches a broken data sync.
	_check("infantry costs 100", int(GameData.unit_stats("infantry").get("cost", 0)) == 100)
	_check("treads cannot cross mountains", GameData.move_cost("mountain", "treads") == -1)
	_check("foot crosses mountains for 2", GameData.move_cost("mountain", "foot") == 2)
	_check("anti-tank infantry hurts heavy tanks",
		GameData.base_damage("anti_tank_infantry", "heavy_tank") > 40)
	_check("fighter jets cannot hit ground units",
		GameData.base_damage("fighter_jet", "light_tank") == 0)
	_check("display_hp never zeroes a living unit",
		GameData.display_hp(1) == 1 and GameData.display_hp(100) == 10 and GameData.display_hp(0) == 0)

	var map_data := GameData.load_map("crossing")
	_check("the shipped map loads", int(map_data.get("width", 0)) == 15 and int(map_data.get("height", 0)) == 10)


func _check_match_state() -> void:
	var state := MatchState.from_view(Fixtures.match_view(true))
	_check("a view is adopted", state.match_id == "fixture" and state.map_width == 15)
	_check("it is our turn", state.is_my_turn())
	_check("own funds are readable", state.my_funds() == 5000)
	_check("terrain is indexed correctly", state.terrain_at(0, 0) == "hq",
		"got %s" % state.terrain_at(0, 0))
	_check("units are found by position", String(state.unit_at(6, 4).get("id", "")) == "a1")
	_check("units are found by owner", state.units_of(1).size() == 4 and state.units_of(2).size() == 2,
		"got %d own, %d enemy" % [state.units_of(1).size(), state.units_of(2).size()])
	_check("out-of-bounds reads are safe", state.terrain_at(-1, 0) == "" and state.unit_at(99, 99).is_empty())


## A view with only the units this test cares about.
func _view_with(units: Array) -> Dictionary:
	var view := Fixtures.match_view(true)
	view["units"] = units
	return view


func _unit(id: String, type: String, slot: int, x: int, y: int, extra: Dictionary = {}) -> Dictionary:
	var unit := {
		"id": id, "unitType": type, "ownerSlot": slot, "x": x, "y": y, "hp": 100,
		"fuel": 99, "ammo": 9, "hasMoved": false, "hasActed": false,
		"captureProgress": 0, "cargo": [],
	}
	unit.merge(extra, true)
	return unit


## A route may run straight through a friendly unit even though it cannot
## stop on one. Conflating "reachable" with "can stand here" left the tiles
## in between out of the cost field, so no route could be reconstructed - and
## the empty path that fell out was a legal no-op the server accepted,
## silently costing the unit its move.
func _check_path_through_friendly() -> void:
	var state := MatchState.from_view(_view_with([
		_unit("mover", "light_tank", 1, 5, 4),
		_unit("friend", "infantry", 1, 6, 4),
	]))
	var mover: Dictionary = state.units["mover"]

	var stoppable := MovementPreview.reachable_tiles(state, mover)
	_check("a tile with a friendly unit on it is not a place to stop",
		not stoppable.has(Vector2i(6, 4)))
	_check("but the tile past it is reachable", stoppable.has(Vector2i(7, 4)))

	var field := MovementPreview.cost_field(state, mover)
	_check("and the friendly tile is still in the cost field",
		field.has(Vector2i(6, 4)), "a route cannot be traced through a hole")

	var route := MovementPreview.path_to(state, mover, Vector2i(7, 4))
	_check("a route through the friendly unit is found", not route.is_empty(),
		"an empty path would burn the unit's move for nothing")
	_check("and it ends where asked", route.size() > 0 and route[-1] == Vector2i(7, 4))
	_check("passing over the friendly tile on the way",
		route.has(Vector2i(6, 4)), "got %s" % [route])


## The server checks ammo before allowing an attack; an overlay that does not
## offers targets the server then refuses.
func _check_attack_needs_ammo() -> void:
	var state := MatchState.from_view(_view_with([
		_unit("gun", "light_tank", 1, 6, 4),
		_unit("target", "infantry", 2, 7, 4),
	]))
	_check("a loaded unit is offered its target",
		MovementPreview.attackable_tiles(state, state.units["gun"]).has(Vector2i(7, 4)))

	var dry := MatchState.from_view(_view_with([
		_unit("gun", "light_tank", 1, 6, 4, {"ammo": 0}),
		_unit("target", "infantry", 2, 7, 4),
	]))
	_check("an empty magazine is offered nothing",
		MovementPreview.attackable_tiles(dry, dry.units["gun"]).is_empty())


func _check_movement_preview() -> void:
	var state := MatchState.from_view(Fixtures.match_view(true))
	var tank: Dictionary = state.units["a1"]

	var reachable := MovementPreview.reachable_tiles(state, tank)
	_check("the tank can reach somewhere", reachable.size() > 1,
		"%d tiles" % reachable.size())

	var budget := int(GameData.unit_stats("light_tank").get("move", 0))
	var over_budget := 0
	var into_mountains := 0
	for tile in reachable.keys():
		if int(reachable[tile]) > budget:
			over_budget += 1
		if state.terrain_at(tile.x, tile.y) == "mountain":
			into_mountains += 1
	_check("no tile exceeds the movement budget", over_budget == 0)
	_check("treads are kept out of mountains", into_mountains == 0)
	_check("the tile an enemy stands on is not a stopping point",
		not reachable.has(Vector2i(7, 4)))

	# Pick a reachable tile a few steps away and rebuild the path to it.
	var destination := Vector2i(6, 4)
	for tile in reachable.keys():
		if int(reachable[tile]) >= 2:
			destination = tile
			break
	var path := MovementPreview.path_to(state, tank, destination)
	_check("a path is reconstructed to a reachable tile", path.size() > 0)
	_check("the path ends at the destination", path.size() > 0 and path[-1] == destination)
	_check("the path is contiguous", _is_contiguous(Vector2i(6, 4), path))
	_check("an unreachable tile yields no path",
		MovementPreview.path_to(state, tank, Vector2i(14, 9)).is_empty())

	var targets := MovementPreview.attackable_tiles(state, tank)
	_check("the adjacent enemy is attackable", targets.has(Vector2i(7, 4)))

	# An indirect unit that has already moved may not fire - the same rule the
	# server enforces, so the overlay must not offer it.
	var artillery := {
		"id": "u3", "unitType": "artillery", "ownerSlot": 1, "x": 5, "y": 4,
		"hp": 100, "fuel": 50, "ammo": 9, "hasMoved": true, "hasActed": false,
	}
	_check("artillery that moved shows no targets",
		MovementPreview.attackable_tiles(state, artillery).is_empty())
	artillery["hasMoved"] = false
	_check("artillery that held position can fire at range 2",
		MovementPreview.attackable_tiles(state, artillery).has(Vector2i(7, 4)))


func _is_contiguous(origin: Vector2i, path: Array[Vector2i]) -> bool:
	var previous := origin
	for step in path:
		if absi(step.x - previous.x) + absi(step.y - previous.y) != 1:
			return false
		previous = step
	return true
