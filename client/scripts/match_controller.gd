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
## Attacking takes two taps on purpose. The first arms the target and puts
## the damage forecast on screen; the second commits. A forecast the player
## cannot read before committing is not worth computing, and an attack is the
## one action here that cannot be undone.
##
## The gesture vocabulary:
##   tap your unit             select it, show move range and attackable enemies
##   tap a highlighted tile    move there
##   tap a highlighted enemy   arm it and show the forecast
##   tap the armed enemy again attack it
##   tap the selected unit     deselect
##   tap your empty factory    open the build menu
##   Capture / Wait            bar buttons, for actions with no target tile

signal selection_changed(unit_id: String)
signal action_refused(reason: String)
## Emitted around an event animation, so the HUD can lock while it plays.
signal animating_changed(animating: bool)

@export var board_path: NodePath = NodePath("../Board")
@export var turn_controller_path: NodePath = NodePath("../TurnController")
@export var action_bar_path: NodePath = NodePath("../UI/ActionBar")
@export var build_menu_path: NodePath = NodePath("../UI/BuildMenu")
@export var hud_path: NodePath = NodePath("../UI/Hud")

var _board: Board = null
var _turns: TurnController = null
var _bar: Node = null
var _build_menu: Node = null
var _top_bar: Node = null
var _unit_info: Node = null
var _turn_banner: Node = null
var _animator: EventAnimator = null

var _selected_id: String = ""
var _move_range: Dictionary = {}       ## Vector2i -> cost
var _attack_targets: Array = []        ## Vector2i
## The target a confirming tap would hit. Empty means nothing is armed.
var _armed_target_id: String = ""
var _animating := false
## Bumped on every settle, so a run that is overtaken by a newer update knows
## to stand down rather than clearing the flag and redrawing mid-tween.
var _settle_generation := 0
## Whose turn it last was, so a change can be announced exactly once.
var _turn_signature: String = ""


func _ready() -> void:
	_board = get_node_or_null(board_path) as Board
	_turns = get_node_or_null(turn_controller_path) as TurnController
	_bar = get_node_or_null(action_bar_path)
	_build_menu = get_node_or_null(build_menu_path)

	var hud := get_node_or_null(hud_path)
	if hud != null:
		_top_bar = hud.get_node_or_null("TopBar")
		_unit_info = hud.get_node_or_null("UnitInfo")
		_turn_banner = hud.get_node_or_null("TurnBanner")

	if _board == null or _turns == null:
		push_error("MatchController: board or turn controller not found")
		return

	# The animator lives here rather than on the board because it is part of
	# responding to the server, not part of drawing a state.
	_animator = EventAnimator.new()
	_animator.name = "EventAnimator"
	_animator.setup(_board)
	add_child(_animator)

	_board.tile_tapped.connect(tap_tile)
	_turns.action_confirmed.connect(_on_action_settled)
	# A rejoin is answered with a full snapshot rather than an update, so
	# without this the board keeps showing the position from before the drop.
	_turns.state_replaced.connect(refresh)
	Net.opponent_connection_changed.connect(_on_opponent_connection_changed)
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

	if _build_menu != null:
		_build_menu.unit_chosen.connect(_on_build_chosen)


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

	# The tile may have been built on, lost, or the turn may have passed
	# while the menu was open, so re-check rather than trusting it.
	if build_menu_is_open() and not can_build_at(_build_menu.tile()):
		_build_menu.close()

	# The armed target may have died, moved out of range, or slipped back
	# into the fog while the player was deciding.
	if not _armed_target_id.is_empty():
		var armed: Dictionary = current.units.get(_armed_target_id, {})
		if armed.is_empty() or not _attack_targets.has(
				Vector2i(int(armed.get("x", 0)), int(armed.get("y", 0)))):
			_armed_target_id = ""

	if not _selected_id.is_empty() and not _can_command(_selected_id):
		_set_selection("")
	else:
		_recompute_overlays()

	_announce_turn_change(current)
	_refresh_hud()
	_refresh_bar()


## --- input -------------------------------------------------------------

func tap_tile(tile: Vector2i) -> void:
	var current := state()
	# Taps during an animation are dropped rather than queued: the board is
	# showing stale positions while it plays, so a tap on what is drawn would
	# mean something different by the time it landed.
	if current == null or not _can_order():
		return

	# A tap on the board while the menu is up dismisses it, and does nothing
	# else - otherwise choosing a tile and cancelling a menu are the same
	# gesture with different outcomes depending on what is open.
	if _build_menu != null and _build_menu.is_open():
		_build_menu.close()
		return

	var tapped: Dictionary = current.unit_at(tile.x, tile.y)

	if _selected_id.is_empty():
		if not tapped.is_empty() and _can_command(String(tapped.get("id", ""))):
			_set_selection(String(tapped["id"]))
		elif tapped.is_empty() and can_build_at(tile):
			_open_build_menu(tile)
		return

	# An enemy under the attack overlay is a target, and takes priority: a
	# tile can be both reachable and occupied by something worth shooting.
	if _attack_targets.has(tile) and not tapped.is_empty():
		var target_id := String(tapped.get("id", ""))
		if _armed_target_id == target_id:
			_turns.attack(_selected_id, target_id)
		else:
			_arm_target(target_id)
		return

	# Any other tap abandons an armed target rather than carrying it along.
	_disarm()

	var selected: Dictionary = current.units.get(_selected_id, {})
	var origin := Vector2i(int(selected.get("x", 0)), int(selected.get("y", 0)))

	if tile == origin:
		_set_selection("")
		return

	if not bool(selected.get("hasMoved", false)) and _move_range.has(tile) and tapped.is_empty():
		var route := MovementPreview.path_to(current, selected, tile)
		# An empty path is a legal no-op to the server: it would mark the unit
		# as moved and silently cost it its turn. If no route was found, the
		# preview and the rules disagree - say so rather than acting on it.
		if route.is_empty():
			push_warning("MatchController: no route to %s for %s" % [tile, _selected_id])
			action_refused.emit("no_route")
			return
		_turns.move_unit(_selected_id, route)
		return

	# Tapping another of your own ready units switches to it rather than
	# just dropping the selection.
	if not tapped.is_empty() and _can_command(String(tapped.get("id", ""))):
		_set_selection(String(tapped["id"]))
		return

	_set_selection("")


func clear_selection() -> void:
	_set_selection("")


## --- targeting ---------------------------------------------------------

func armed_target_id() -> String:
	return _armed_target_id


func _arm_target(target_id: String) -> void:
	_armed_target_id = target_id
	_recompute_overlays()
	_refresh_hud()
	_refresh_bar()


func _disarm() -> void:
	if _armed_target_id.is_empty():
		return
	_armed_target_id = ""
	_recompute_overlays()
	_refresh_hud()
	_refresh_bar()


## --- production --------------------------------------------------------

## Whether the local player could start a build on this tile right now.
## Mirrors what doBuild() in the server engine checks before the funds test -
## affordability is left to the menu, so the player can see what they are
## saving for rather than being shown an empty list.
func can_build_at(tile: Vector2i) -> bool:
	var current := state()
	if current == null or not current.is_my_turn():
		return false
	if not bool(GameData.terrain_stats(current.terrain_at(tile.x, tile.y)).get("builds", false)):
		return false
	if current.tile_owner_at(tile.x, tile.y) != current.you_slot:
		return false
	return current.unit_at(tile.x, tile.y).is_empty()


func build_menu_is_open() -> bool:
	return _build_menu != null and _build_menu.is_open()


func _open_build_menu(tile: Vector2i) -> void:
	if _build_menu == null:
		return
	var current := state()
	_set_selection("")
	_build_menu.open_for(current.terrain_at(tile.x, tile.y), tile, current.my_funds(),
		_my_faction())


func _on_build_chosen(unit_type: String) -> void:
	if not _can_order():
		return
	_turns.build(unit_type, _build_menu.tile())


func _my_faction() -> String:
	var current := state()
	if current == null:
		return ""
	for player in current.players:
		if int(player.get("slot", 0)) == current.you_slot:
			return String(player.get("faction", ""))
	return ""


## --- bar actions -------------------------------------------------------

## Every order goes through this. The animation guard belongs here and not
## just in tap_tile: while a sequence plays the board shows stale positions,
## and a button press means whatever was true before it started.
func _can_order() -> bool:
	return _turns.can_act() and not _animating


func _on_capture_pressed() -> void:
	if _selected_id.is_empty() or not _can_order():
		return
	_turns.capture(_selected_id)


func _on_wait_pressed() -> void:
	if _selected_id.is_empty() or not _can_order():
		return
	_turns.wait_unit(_selected_id)


func _on_end_turn_pressed() -> void:
	if not _can_order():
		return
	_set_selection("")
	_turns.end_turn()


## --- server responses --------------------------------------------------

## The board is deliberately NOT refreshed until the events have played:
## until then the unit nodes still stand where they were, which is what the
## animation moves away from. The refresh afterwards is what makes the
## result exact - the animation is decoration, the adopted state is truth.
func _on_action_settled(events: Array) -> void:
	_settle_generation += 1
	var generation := _settle_generation

	if _animator != null and not EventAnimator.plan(events).is_empty():
		_set_animating(true)
		await _animator.play(events)
		# A newer update arrived while this was playing. It owns the flag and
		# the redraw now; clearing them here would re-render mid-animation.
		if generation != _settle_generation:
			return
		_set_animating(false)

	# The selection survives a move so the player can attack or capture with
	# the same unit; refresh() drops it once the unit has fully acted.
	refresh()


func is_animating() -> bool:
	return _animating


## Instant animations, for tests and for anyone who wants the snap back.
func set_animation_scale(scale: float) -> void:
	if _animator != null:
		_animator.duration_scale = scale


func _set_animating(animating: bool) -> void:
	if _animating == animating:
		return
	_animating = animating
	_refresh_bar()
	animating_changed.emit(animating)


func _on_action_refused(reason: String) -> void:
	# The server attached a corrected view, which TurnController has already
	# adopted - so redraw from it rather than keeping a hopeful overlay up.
	refresh()
	action_refused.emit(reason)


func _on_awaiting_changed(_waiting: bool) -> void:
	_refresh_bar()


## Presence arrives outside a view, because nothing about the board changed -
## so it is recorded here rather than waiting for the next server snapshot.
func _on_opponent_connection_changed(slot: int, connected: bool) -> void:
	var current := state()
	if current == null:
		return
	for player in current.players:
		if int(player.get("slot", 0)) == slot:
			player["connected"] = connected
	_refresh_hud()


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
	# A target armed for the previous unit means nothing for this one.
	_armed_target_id = ""
	_recompute_overlays()
	_refresh_hud()
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

	var armed: Dictionary = current.units.get(_armed_target_id, {})
	if not armed.is_empty():
		_board.show_armed_target(Vector2i(int(armed.get("x", 0)), int(armed.get("y", 0))))


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


## The banner fires on a change of turn or round, and only once per change -
## refresh() runs on every server message, not just the interesting ones.
func _announce_turn_change(current: MatchState) -> void:
	var signature := "%s:%d:%d" % [current.phase, current.current_slot, current.round_number]
	if signature == _turn_signature:
		return

	var first := _turn_signature.is_empty()
	_turn_signature = signature
	if _turn_banner == null or first or current.phase != "active":
		return

	if current.is_my_turn():
		_turn_banner.announce("Your turn", Color("#ffe08a"))
	else:
		_turn_banner.announce("Opponent's turn", Color("#9aa0ac"))


func _refresh_hud() -> void:
	var current := state()
	if _top_bar != null:
		_top_bar.refresh(current)

	if _unit_info == null:
		return
	if current == null:
		_unit_info.clear()
		return

	var armed: Dictionary = current.units.get(_armed_target_id, {})
	var selected: Dictionary = current.units.get(_selected_id, {})

	# With a target armed the question is "what happens if I attack", so the
	# panel switches to the forecast against it.
	if not armed.is_empty() and not selected.is_empty():
		_unit_info.show_forecast(current, selected, armed)
	elif not selected.is_empty():
		_unit_info.show_unit(current, selected)
	else:
		_unit_info.clear()


func _refresh_bar() -> void:
	if _bar == null:
		return
	var current := state()
	var has_selection := not _selected_id.is_empty()
	var busy: bool = _turns.is_awaiting_server() or _animating

	var status := "Connecting..."
	if current != null:
		if current.is_finished():
			status = "Victory" if current.winner_slot == current.you_slot else "Defeat"
		elif _animating:
			status = "..."
		elif busy:
			status = "Sending..."
		elif not current.is_my_turn():
			status = "Opponent's turn"
		elif not _armed_target_id.is_empty():
			status = "Tap the target again to attack"
		elif has_selection:
			var unit: Dictionary = current.units.get(_selected_id, {})
			status = "%s selected" % GameData.unit_stats(
				String(unit.get("unitType", ""))).get("display_name", "Unit")
		else:
			status = "Round %d - your turn (%d funds)" % [current.round_number, current.my_funds()]

	_bar.refresh(status, has_selection and not busy, can_capture_here() and not busy,
		current != null and current.is_my_turn() and not busy)
