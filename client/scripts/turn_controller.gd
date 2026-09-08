class_name TurnController
extends Node
## Drives the local player's turn.
##
## Sends ONE action at a time and waits for the server's answer before the
## next. It deliberately does not queue up a whole turn and submit it as a
## batch: with fog of war the player may not know what is on a tile until
## they move next to it, and damage carries a server-side luck roll, so every
## action after the first in a batch would be a guess. Action-at-a-time also
## means a rejection costs one action, not the whole turn.

signal action_sent(action: Dictionary)
signal action_confirmed(events: Array)
signal action_refused(reason: String)
signal awaiting_server_changed(waiting: bool)

var state: MatchState = null
## Only one action may be in flight; the UI should stay locked until it lands.
var _in_flight: Dictionary = {}


func _ready() -> void:
	Net.update_received.connect(_on_update_received)
	Net.action_rejected.connect(_on_action_rejected)
	Net.state_received.connect(_on_state_received)


func is_awaiting_server() -> bool:
	return not _in_flight.is_empty()


func can_act() -> bool:
	return state != null and state.is_my_turn() and not is_awaiting_server()


func move_unit(unit_id: String, path: Array[Vector2i]) -> void:
	var steps: Array = []
	for step in path:
		steps.append({"x": step.x, "y": step.y})
	_submit({"type": "move", "unitId": unit_id, "path": steps})


func attack(unit_id: String, target_unit_id: String) -> void:
	_submit({"type": "attack", "unitId": unit_id, "targetUnitId": target_unit_id})


func capture(unit_id: String) -> void:
	_submit({"type": "capture", "unitId": unit_id})


func wait_unit(unit_id: String) -> void:
	_submit({"type": "wait", "unitId": unit_id})


func build(unit_type: String, at: Vector2i) -> void:
	_submit({"type": "build", "unitType": unit_type, "at": {"x": at.x, "y": at.y}})


func end_turn() -> void:
	_submit({"type": "endTurn"})


func _submit(action: Dictionary) -> void:
	if not can_act():
		action_refused.emit("not_ready")
		return

	_in_flight = action
	awaiting_server_changed.emit(true)
	action_sent.emit(action)
	Net.send_action(action)


func _on_update_received(events: Array, view: Dictionary) -> void:
	adopt_view(view)
	_clear_in_flight()
	action_confirmed.emit(events)


func _on_action_rejected(reason: String, view: Dictionary) -> void:
	# The server sends a fresh view with every rejection, so a client that had
	# drifted is corrected here rather than left arguing with the server.
	adopt_view(view)
	_clear_in_flight()
	action_refused.emit(reason)


func _on_state_received(view: Dictionary) -> void:
	apply_server_state(view)


## Adopt an authoritative snapshot and settle any action still in flight.
## This is what a `state` message does, and what an offline preview or a test
## seeding a match needs - without it the controller waits forever for a
## reply that is never coming.
func apply_server_state(view: Dictionary) -> void:
	adopt_view(view)
	_clear_in_flight()


## Adopt a server view. Public so tests and offline previews can seed a
## match without a socket; in normal play only the Net signals call it.
func adopt_view(view: Dictionary) -> void:
	if view.is_empty():
		return
	if state == null:
		state = MatchState.from_view(view)
	else:
		state.adopt(view)


func _clear_in_flight() -> void:
	if _in_flight.is_empty():
		return
	_in_flight = {}
	awaiting_server_changed.emit(false)


# TODO: animate the `events` from action_confirmed before adopting the view,
# so a move or a hit plays out rather than snapping. The adopted MatchState
# stays the final word on what is drawn.
