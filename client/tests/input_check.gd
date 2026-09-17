extends Node
## Checks the interaction rules: what a tap on a tile actually does.
##
## Drives MatchController.tap_tile() directly rather than synthesising touch
## events, so these assert on the rules and not on Godot's input plumbing.
## The screen-to-tile conversion that sits in front of them is covered
## separately by board_check's coordinate tests.
##
## Actions are captured off TurnController.action_sent, which fires before
## anything reaches the network - so no server is needed to assert that the
## right action, with the right shape, would be submitted.
##
##   cd client && godot --headless res://tests/input_check.tscn

const MATCH_SCENE := preload("res://scenes/match.tscn")

var _failures := 0
var _match: Node = null
var _controller: MatchController = null
var _turns: TurnController = null
var _sent: Array[Dictionary] = []


func _ready() -> void:
	_match = MATCH_SCENE.instantiate()
	add_child(_match)

	_controller = _match.get_node("MatchController")
	_turns = _match.get_node("TurnController")
	_turns.action_sent.connect(func(action: Dictionary): _sent.append(action))

	_reset()

	_check_selection()
	_check_snapshot_redraws()
	_check_move()
	_check_attack()
	_check_deselect_and_switch()
	_check_turn_gating()
	_check_capture_availability()
	_check_post_move_state()
	_check_stale_selection_dropped()
	_check_transport()

	if _failures == 0:
		print("\ninput_check: all checks passed")
	else:
		printerr("\ninput_check: %d check(s) FAILED" % _failures)
	get_tree().quit(0 if _failures == 0 else 1)


func _check(label: String, condition: bool, detail: String = "") -> void:
	if condition:
		print("ok   %s" % label)
	else:
		_failures += 1
		printerr("FAIL %s%s" % [label, "" if detail.is_empty() else " (%s)" % detail])


## Fresh fixture, no selection, nothing recorded.
func _reset(view: Dictionary = {}) -> void:
	_controller.clear_selection()
	_controller.load_view(view if not view.is_empty() else Fixtures.match_view())
	_sent.clear()


func _last() -> Dictionary:
	return _sent[-1] if not _sent.is_empty() else {}


## A rejoin is answered with a full snapshot rather than an update, and
## nothing used to redraw on one - so a player who dropped and came back sat
## looking at the board from before the disconnect until they acted.
func _check_snapshot_redraws() -> void:
	_reset()
	var board: Board = _match.get_node("Board")
	_check("the board starts where the fixture put the tank",
		board.unit_node("a1").position == board.world_at_tile(Vector2i(6, 4)),
		"at %s" % board.unit_node("a1").position)

	var moved := Fixtures.match_view()
	for unit in moved["units"]:
		if String(unit["id"]) == "a1":
			unit["x"] = 6
			unit["y"] = 6

	# Exactly what arrives after a reconnect: Net delivers a `state` frame.
	Net.state_received.emit(moved)
	_check("a snapshot redraws the board",
		board.unit_node("a1").position == board.world_at_tile(Vector2i(6, 6)),
		"still at %s" % board.unit_node("a1").position)


## --- selection ---------------------------------------------------------

func _check_selection() -> void:
	_reset()
	_controller.tap_tile(Vector2i(0, 0))
	_check("tapping empty ground selects nothing", _controller.selected_unit_id().is_empty())

	_controller.tap_tile(Vector2i(7, 4))
	_check("tapping an enemy selects nothing", _controller.selected_unit_id().is_empty())

	_controller.tap_tile(Vector2i(4, 5))
	_check("tapping a unit that already acted selects nothing",
		_controller.selected_unit_id().is_empty())

	_controller.tap_tile(Vector2i(6, 4))
	_check("tapping your own ready unit selects it", _controller.selected_unit_id() == "a1")
	_check("selecting shows a movement range", _controller.movement_range().size() > 1,
		"%d tiles" % _controller.movement_range().size())
	_check("selecting shows the adjacent enemy as a target",
		_controller.attack_targets().has(Vector2i(7, 4)))
	_check("selecting submits nothing on its own", _sent.is_empty())


## --- movement ----------------------------------------------------------

func _check_move() -> void:
	_reset()
	_controller.tap_tile(Vector2i(6, 4))

	_controller.tap_tile(Vector2i(0, 9))
	_check("tapping outside the range submits nothing", _sent.is_empty())
	_check("and drops the selection", _controller.selected_unit_id().is_empty())

	# A destination the preview can reach but no route reaches would submit an
	# empty path, which the server treats as a legal no-op - marking the unit
	# moved and costing it its turn for nothing.
	_reset()
	var refusals: Array[String] = []
	_controller.action_refused.connect(func(reason: String): refusals.append(reason))
	_controller.tap_tile(Vector2i(6, 4))
	_controller.tap_tile(Vector2i(6, 6))
	_check("a normal move is not mistaken for a routeless one",
		not refusals.has("no_route"), "refused with %s" % [refusals])

	var action := _last()
	_check("tapping a reachable tile submits a move", String(action.get("type", "")) == "move",
		"got %s" % action.get("type", "nothing"))
	_check("the move names the selected unit", String(action.get("unitId", "")) == "a1")

	var path: Array = action.get("path", [])
	_check("the move carries a path", path.size() > 0)
	_check("the path ends at the tapped tile",
		path.size() > 0 and int(path[-1]["x"]) == 6 and int(path[-1]["y"]) == 6,
		"ends at %s" % [path[-1] if path.size() > 0 else "nothing"])
	_check("the path starts adjacent to the unit",
		path.size() > 0 and absi(int(path[0]["x"]) - 6) + absi(int(path[0]["y"]) - 4) == 1)


## Attacking takes two taps: the first arms the target and shows the
## forecast, the second commits.
func _check_attack() -> void:
	_reset()
	_controller.tap_tile(Vector2i(6, 4))
	_controller.tap_tile(Vector2i(7, 4))

	_check("the first tap on an enemy arms it", _controller.armed_target_id() == "b1",
		"armed '%s'" % _controller.armed_target_id())
	_check("and commits nothing yet", _sent.is_empty())

	_controller.tap_tile(Vector2i(7, 4))
	var action := _last()
	_check("a second tap on the armed enemy attacks",
		String(action.get("type", "")) == "attack", "got %s" % action.get("type", "nothing"))
	_check("the attack names attacker and target",
		String(action.get("unitId", "")) == "a1" and String(action.get("targetUnitId", "")) == "b1")

	# Tapping away must disarm, so a stray tap cannot leave a live trigger.
	_reset()
	_controller.tap_tile(Vector2i(6, 4))
	_controller.tap_tile(Vector2i(7, 4))
	_check("armed before tapping away", _controller.armed_target_id() == "b1")
	_controller.tap_tile(Vector2i(6, 5))
	_check("tapping elsewhere disarms", _controller.armed_target_id().is_empty())
	_check("and that tap was not an attack",
		_sent.is_empty() or String(_last().get("type", "")) != "attack")


## --- selection management ----------------------------------------------

func _check_deselect_and_switch() -> void:
	_reset()
	_controller.tap_tile(Vector2i(6, 4))
	_controller.tap_tile(Vector2i(6, 4))
	_check("tapping the selected unit deselects it", _controller.selected_unit_id().is_empty())
	_check("deselecting clears the overlays", _controller.movement_range().is_empty()
		and _controller.attack_targets().is_empty())
	_check("deselecting submits nothing", _sent.is_empty())

	_reset()
	_controller.tap_tile(Vector2i(6, 4))
	_controller.tap_tile(Vector2i(3, 2))
	_check("tapping another of your ready units switches to it",
		_controller.selected_unit_id() == "a4", "selected %s" % _controller.selected_unit_id())
	_check("switching submits nothing", _sent.is_empty())


func _check_turn_gating() -> void:
	var view := Fixtures.match_view()
	view["currentSlot"] = 2
	_reset(view)

	_controller.tap_tile(Vector2i(6, 4))
	_check("nothing is selectable on the opponent's turn",
		_controller.selected_unit_id().is_empty())
	_check("and nothing is submitted", _sent.is_empty())

	var finished := Fixtures.match_view()
	finished["phase"] = "finished"
	finished["winnerSlot"] = 2
	_reset(finished)
	_controller.tap_tile(Vector2i(6, 4))
	_check("nothing is selectable once the match is over",
		_controller.selected_unit_id().is_empty())


func _check_capture_availability() -> void:
	_reset()
	_controller.tap_tile(Vector2i(6, 4))
	_check("a tank on a road cannot capture", not _controller.can_capture_here())

	_controller.tap_tile(Vector2i(5, 3))
	_check("an infantry on a neutral city can capture",
		_controller.selected_unit_id() == "a2" and _controller.can_capture_here())


## After a move the unit stays selected so it can still shoot, but has no
## movement left to offer - mirroring the server's hasMoved/hasActed split.
func _check_post_move_state() -> void:
	var view := Fixtures.match_view()
	for unit in view["units"]:
		if String(unit["id"]) == "a1":
			unit["hasMoved"] = true
	_reset(view)

	_controller.tap_tile(Vector2i(6, 4))
	_check("a moved unit can still be selected", _controller.selected_unit_id() == "a1")
	_check("a moved unit offers no movement range", _controller.movement_range().is_empty())
	_check("a moved unit still offers its targets",
		_controller.attack_targets().has(Vector2i(7, 4)))

	_controller.tap_tile(Vector2i(6, 6))
	_check("a moved unit cannot move again", _sent.is_empty())


## A selection has to survive contact with a new server view, or be dropped.
func _check_stale_selection_dropped() -> void:
	_reset()
	_controller.tap_tile(Vector2i(6, 4))
	_check("selected before the update", _controller.selected_unit_id() == "a1")

	# The unit is gone - destroyed by a counterattack, say.
	var view := Fixtures.match_view()
	var survivors: Array = []
	for unit in view["units"]:
		if String(unit["id"]) != "a1":
			survivors.append(unit)
	view["units"] = survivors
	_controller.load_view(view)
	_check("a selection is dropped when the unit no longer exists",
		_controller.selected_unit_id().is_empty())
	_check("and its overlays go with it", _controller.movement_range().is_empty())

	# The unit is still there but has now acted.
	_reset()
	_controller.tap_tile(Vector2i(6, 4))
	var spent := Fixtures.match_view()
	for unit in spent["units"]:
		if String(unit["id"]) == "a1":
			unit["hasActed"] = true
	_controller.load_view(spent)
	_check("a selection is dropped once the unit has acted",
		_controller.selected_unit_id().is_empty())


## --- transports --------------------------------------------------------
##
## Verified against three mutations:
##   - MatchState.is_carried always false: the carried infantry reappears on
##     the board and "a boarded unit leaves the board" fails
##   - TransportRules.can_load dropping its adjacency test: boarding from
##     three tiles away is offered, and the "alongside" check fails
##   - the unload branch in tap_tile removed: the landing tap falls through
##     to ordinary movement and no unload action is ever sent

## A transport afloat with an infantry on the beach beside it, on `straits`.
## The tiles are searched for rather than hardcoded so a later edit to the
## map cannot turn this into a test of an empty ocean.
func _beachhead_view() -> Dictionary:
	var view := Fixtures.match_view(true, "straits")
	var map: Dictionary = view["map"]
	var width := int(map["width"])
	var height := int(map["height"])
	var terrain: Array = map["terrain"]

	for y in range(1, height - 1):
		for x in range(1, width - 1):
			if GameData.move_cost(String(terrain[y * width + x]), "sea") < 0:
				continue
			for step in [Vector2i(1, 0), Vector2i(-1, 0), Vector2i(0, 1), Vector2i(0, -1)]:
				var sx: int = x + step.x
				var sy: int = y + step.y
				if GameData.move_cost(String(terrain[sy * width + sx]), "foot") < 0:
					continue
				view["units"] = [
					{
						"id": "ship", "unitType": "transport_ship", "ownerSlot": 1,
						"x": x, "y": y, "hp": 100, "fuel": 99, "ammo": null,
						"hasMoved": false, "hasActed": false, "captureProgress": 0,
						"cargo": [], "carriedBy": null,
					},
					{
						"id": "grunt", "unitType": "infantry", "ownerSlot": 1,
						"x": sx, "y": sy, "hp": 100, "fuel": 99, "ammo": null,
						"hasMoved": false, "hasActed": false, "captureProgress": 0,
						"cargo": [], "carriedBy": null,
					},
				]
				view["_ship"] = Vector2i(x, y)
				view["_shore"] = Vector2i(sx, sy)
				return view
	return {}


func _check_transport() -> void:
	var view := _beachhead_view()
	if view.is_empty():
		_check("straits has open water beside passable land", false)
		return

	var ship: Vector2i = view["_ship"]
	var shore: Vector2i = view["_shore"]
	_reset(view)

	# Boarding: select the infantry, tap the transport alongside.
	_controller.tap_tile(shore)
	_check("the infantry on the beach selects", _controller.selected_unit_id() == "grunt")
	_controller.tap_tile(ship)
	_check("tapping the transport alongside boards it",
		_last().get("type", "") == "load", "sent %s" % _last())
	_check("and names both the passenger and the hull",
		_last().get("unitId", "") == "grunt" and _last().get("transportId", "") == "ship")

	# Once loaded, the passenger is off the board entirely.
	var loaded := _beachhead_view()
	for unit in loaded["units"]:
		if String(unit["id"]) == "grunt":
			unit["carriedBy"] = "ship"
			unit["x"] = ship.x
			unit["y"] = ship.y
		else:
			unit["cargo"] = ["grunt"]
	_reset(loaded)

	var board: Board = _match.get_node("Board")
	_check("a boarded unit leaves the board",
		board.unit_node("grunt") == null, "still drawn")
	_check("and its transport's tile still answers with the transport",
		String(_controller.state().unit_at(ship.x, ship.y).get("id", "")) == "ship")
	_check("the beach it left is empty",
		_controller.state().unit_at(shore.x, shore.y).is_empty())

	# Landing: select the transport, press Unload, tap the beach.
	_controller.tap_tile(ship)
	_check("the loaded transport selects", _controller.selected_unit_id() == "ship")
	_check("and offers to put its hold ashore", _controller.can_unload_here())
	_check("which is one passenger", _controller.selected_cargo().size() == 1)

	_sent.clear()
	_controller._on_unload_pressed()
	_check("arming a landing highlights the beach",
		_controller.landing_tiles().has(shore),
		"%d tiles offered" % _controller.landing_tiles().size())
	_check("and sends nothing on its own", _sent.is_empty())

	_controller.tap_tile(shore)
	_check("tapping the beach lands the passenger there",
		_last().get("type", "") == "unload", "sent %s" % _last())
	_check("naming the hull, the passenger and the tile",
		_last().get("transportId", "") == "ship"
		and _last().get("unitId", "") == "grunt"
		and _last().get("to", {}) == {"x": shore.x, "y": shore.y})

	# An empty transport has nothing to offer.
	_reset(view)
	_controller.tap_tile(ship)
	_check("an empty transport offers no landing", not _controller.can_unload_here())

	# You cannot board from across the bay. Without this the adjacency rule
	# in TransportRules.can_load is never exercised, and can be deleted with
	# every other check here still green.
	var distant := _beachhead_view()
	var far := _land_tile_away_from(distant, ship, 2)
	if far == Vector2i(-1, -1):
		_check("straits has open ground away from the water", false)
		return
	for unit in distant["units"]:
		if String(unit["id"]) == "grunt":
			unit["x"] = far.x
			unit["y"] = far.y
	_reset(distant)

	_controller.tap_tile(far)
	_check("the infantry inland selects", _controller.selected_unit_id() == "grunt")
	_controller.tap_tile(ship)
	_check("but tapping a transport it is not alongside boards nothing",
		_last().get("type", "") != "load", "sent %s" % _last())


## A foot-passable, unoccupied tile at least `gap` tiles from `origin`.
func _land_tile_away_from(view: Dictionary, origin: Vector2i, gap: int) -> Vector2i:
	var map: Dictionary = view["map"]
	var width := int(map["width"])
	var terrain: Array = map["terrain"]
	for y in range(int(map["height"])):
		for x in range(width):
			if absi(x - origin.x) + absi(y - origin.y) < gap:
				continue
			if GameData.move_cost(String(terrain[y * width + x]), "foot") < 0:
				continue
			var taken := false
			for unit in view["units"]:
				if int(unit["x"]) == x and int(unit["y"]) == y:
					taken = true
			if not taken:
				return Vector2i(x, y)
	return Vector2i(-1, -1)
