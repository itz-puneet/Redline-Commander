class_name MatchController
extends Node
## The interaction rules: what a tap on a tile means.
##
## Sits between the board (which only reports *where* you tapped) and
## TurnController (which submits one action and waits). Holds exactly one
## piece of UI state - which unit is selected - and derives everything else
## from the MatchState the server sent. That matters: after any server update
## the selection is re-validated against the new state rather than trusted,
## so a unit that died, moved or was spent while the player was deciding
## cannot leave a stale selection behind.
##
## `tap_tile()` is the public entry point, so the interaction rules can be
## tested by feeding tiles instead of synthesising touch events.
##
## The gesture vocabulary:
##   tap your unit          select it, show move range and attackable enemies
##   tap a highlighted tile move there
##   tap a highlighted enemy attack it
##   tap the selected unit  deselect
##   Capture / Wait         bar buttons, for actions with no target tile

signal selection_changed(unit_id: String)
signal action_refused(reason: String)

@export var board_path: NodePath = NodePath("../Board")
@export var turn_controller_path: NodePath = NodePath("../TurnController")
@export var action_bar_path: NodePath = NodePath("../UI/ActionBar")

var _board: Board = null
var _turns: TurnController = null
var _bar: Node = null

var _selected_id: String = ""
var _move_range: Dictionary = {}       ## Vector2i -> cost
var _attack_targets: Array = []        ## Vector2i


func _ready() -> void:
	_board = get_node_or_null(board_path) as Board
	_turns = get_node_or_null(turn_controller_path) as TurnController
	_bar = get_node_or_null(action_bar_path)

	if _board == null or _turns == null:
		push_error("MatchController: board or turn controller not found")
		return

	_board.tile_tapped.connect(tap_tile)
	_turns.action_confirmed.connect(_on_action_settled)
	_turns.action_refused.connect(_on_action_refused)
	_turns.awaiting_server_changed.connect(_on_awaiting_changed)

	if _bar != null:
		# Tell the camera how much of the screen the HUD eats, so framing a
		# match does not tuck the bottom row of the map behind the bar.
		_board.camera.bottom_inset = _bar.BAR_HEIGHT
		_bar.capture_pressed.connect(_on_capture_pressed)
		_bar.wait_pressed.connect(_on_wait_pressed)
		_bar.cancel_pressed.connect(clear_selection)
		_bar.end_turn_pressed.connect(_on_end_turn_pressed)


func state() -> MatchState:
	return _turns.state if _turns != null else null


func selected_unit_id() -> String:
	return _selected_id


func movement_range() -> Dictionary:
	return _move_range


func attack_targets() -> Array:
	return _attack_targets


## Seed a match without a server, for offline previews and tests. Goes
## through the same path as a server `state` message, so any action left in
## flight is settled rather than blocking every later tap.
func load_view(view: Dictionary) -> void:
	_turns.apply_server_state(view)
	refresh()


## Redraw from the current state and re-validate the selection.
func refresh() -> void:
	var current := state()
	if current == null:
		return

	_board.render(current)
	if not _selected_id.is_empty() and not _can_command(_selected_id):
		_set_selection("")
	else:
		_recompute_overlays()
	_refresh_bar()


## --- input -------------------------------------------------------------

func tap_tile(tile: Vector2i) -> void:
	var current := state()
	if current == null or not _turns.can_act():
		return

	var tapped: Dictionary = current.unit_at(tile.x, tile.y)

	if _selected_id.is_empty():
		if not tapped.is_empty() and _can_command(String(tapped.get("id", ""))):
			_set_selection(String(tapped["id"]))
		return

	# An enemy under the attack overlay is a target, and takes priority: a
	# tile can be both reachable and occupied by something worth shooting.
	if _attack_targets.has(tile) and not tapped.is_empty():
		_turns.attack(_selected_id, String(tapped.get("id", "")))
		return

	var selected: Dictionary = current.units.get(_selected_id, {})
	var origin := Vector2i(int(selected.get("x", 0)), int(selected.get("y", 0)))

	if tile == origin:
		_set_selection("")
		return

	if not bool(selected.get("hasMoved", false)) and _move_range.has(tile) and tapped.is_empty():
		_turns.move_unit(_selected_id, MovementPreview.path_to(current, selected, tile))
		return

	# Tapping another of your own ready units switches to it rather than
	# just dropping the selection.
	if not tapped.is_empty() and _can_command(String(tapped.get("id", ""))):
		_set_selection(String(tapped["id"]))
		return

	_set_selection("")


func clear_selection() -> void:
	_set_selection("")


## --- bar actions -------------------------------------------------------

func _on_capture_pressed() -> void:
	if _selected_id.is_empty() or not _turns.can_act():
		return
	_turns.capture(_selected_id)


func _on_wait_pressed() -> void:
	if _selected_id.is_empty() or not _turns.can_act():
		return
	_turns.wait_unit(_selected_id)


func _on_end_turn_pressed() -> void:
	if not _turns.can_act():
		return
	_set_selection("")
	_turns.end_turn()


## --- server responses --------------------------------------------------

func _on_action_settled(_events: Array) -> void:
	# The selection survives a move so the player can attack or capture with
	# the same unit; refresh() drops it once the unit has fully acted.
	refresh()


func _on_action_refused(reason: String) -> void:
	# The server attached a corrected view, which TurnController has already
	# adopted - so redraw from it rather than keeping a hopeful overlay up.
	refresh()
	action_refused.emit(reason)


func _on_awaiting_changed(_waiting: bool) -> void:
	_refresh_bar()


## --- internals ---------------------------------------------------------

## A unit the local player may give an order to right now.
func _can_command(unit_id: String) -> bool:
	var current := state()
	if current == null or not current.is_my_turn():
		return false
	var unit: Dictionary = current.units.get(unit_id, {})
	if unit.is_empty():
		return false
	return int(unit.get("ownerSlot", 0)) == current.you_slot \
		and not bool(unit.get("hasActed", false))


func _set_selection(unit_id: String) -> void:
	_selected_id = unit_id
	_recompute_overlays()
	_refresh_bar()
	selection_changed.emit(unit_id)


func _recompute_overlays() -> void:
	_move_range = {}
	_attack_targets = []
	_board.clear_overlays()

	var current := state()
	if current == null or _selected_id.is_empty():
		return

	var unit: Dictionary = current.units.get(_selected_id, {})
	if unit.is_empty():
		return

	# A unit that has already moved keeps its attack options but has no
	# movement left to show - the same rule the server enforces.
	if not bool(unit.get("hasMoved", false)):
		_move_range = MovementPreview.reachable_tiles(current, unit)
		_board.show_movement_range(_move_range.keys())

	_attack_targets = MovementPreview.attackable_tiles(current, unit)
	if not _attack_targets.is_empty():
		_board.show_attack_range(_attack_targets)

	_board.show_selection(Vector2i(int(unit.get("x", 0)), int(unit.get("y", 0))))


## Whether the selected unit is standing on something it could capture.
func can_capture_here() -> bool:
	var current := state()
	if current == null or _selected_id.is_empty():
		return false

	var unit: Dictionary = current.units.get(_selected_id, {})
	if unit.is_empty():
		return false
	if not bool(GameData.unit_stats(String(unit.get("unitType", ""))).get("can_capture", false)):
		return false

	var x := int(unit.get("x", 0))
	var y := int(unit.get("y", 0))
	var terrain := GameData.terrain_stats(current.terrain_at(x, y))
	return bool(terrain.get("capturable", false)) and current.tile_owner_at(x, y) != current.you_slot


func _refresh_bar() -> void:
	if _bar == null:
		return
	var current := state()
	var has_selection := not _selected_id.is_empty()
	var busy: bool = _turns.is_awaiting_server()

	var status := "Connecting..."
	if current != null:
		if current.is_finished():
			status = "Victory" if current.winner_slot == current.you_slot else "Defeat"
		elif busy:
			status = "Sending..."
		elif not current.is_my_turn():
			status = "Opponent's turn"
		elif has_selection:
			var unit: Dictionary = current.units.get(_selected_id, {})
			status = "%s selected" % GameData.unit_stats(
				String(unit.get("unitType", ""))).get("display_name", "Unit")
		else:
			status = "Round %d - your turn (%d funds)" % [current.round_number, current.my_funds()]

	_bar.refresh(status, has_selection and not busy, can_capture_here() and not busy,
		current != null and current.is_my_turn() and not busy)
