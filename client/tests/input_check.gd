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
	_check_move()
	_check_attack()
	_check_deselect_and_switch()
	_check_turn_gating()
	_check_capture_availability()
	_check_post_move_state()
	_check_stale_selection_dropped()

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

	_reset()
	_controller.tap_tile(Vector2i(6, 4))
	_controller.tap_tile(Vector2i(6, 6))

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


func _check_attack() -> void:
	_reset()
	_controller.tap_tile(Vector2i(6, 4))
	_controller.tap_tile(Vector2i(7, 4))

	var action := _last()
	_check("tapping a highlighted enemy submits an attack",
		String(action.get("type", "")) == "attack", "got %s" % action.get("type", "nothing"))
	_check("the attack names attacker and target",
		String(action.get("unitId", "")) == "a1" and String(action.get("targetUnitId", "")) == "b1")


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
