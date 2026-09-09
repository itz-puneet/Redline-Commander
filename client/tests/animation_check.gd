extends Node
## Checks event animation.
##
## The plan is pure, so its sequencing is asserted directly with no waiting.
## Playback then runs with duration_scale 0, which finishes in a handful of
## frames while still exercising every tween and node lookup - so a crash on
## a missing node or a wrong property name is caught here rather than on a
## phone.
##
##   cd client && godot --headless res://tests/animation_check.tscn

const MATCH_SCENE := preload("res://scenes/match.tscn")

var _failures := 0
## Phases that ran to completion, so a suite that stops early cannot report
## success - see the CLAUDE.md note about await and coroutines.
var _phases := 0
var _match: Node = null
var _controller: MatchController = null
var _board: Board = null


func _ready() -> void:
	_check_plan()
	await _check_playback()
	await _check_render_waits_for_animation()
	await _check_input_is_gated()

	await _check_overlapping_updates()

	_check("every phase ran to completion", _phases == 4, "%d of 4" % _phases)

	if _failures == 0:
		print("\nanimation_check: all checks passed")
	else:
		printerr("\nanimation_check: %d check(s) FAILED" % _failures)
	get_tree().quit(0 if _failures == 0 else 1)


func _check(label: String, condition: bool, detail: String = "") -> void:
	if condition:
		print("ok   %s" % label)
	else:
		_failures += 1
		printerr("FAIL %s%s" % [label, "" if detail.is_empty() else " (%s)" % detail])


func _kinds(steps: Array) -> Array:
	var out: Array = []
	for step in steps:
		out.append(String(step.get("kind", "")))
	return out


## --- the plan ----------------------------------------------------------

func _check_plan() -> void:
	var moved := {"type": "unitMoved", "unitId": "a1",
		"from": {"x": 6, "y": 4}, "to": {"x": 6, "y": 6},
		"path": [{"x": 6, "y": 5}, {"x": 6, "y": 6}], "fuelSpent": 2}

	var steps := EventAnimator.plan([moved])
	_check("a move produces one step", steps.size() == 1)
	_check("and carries the whole path, not just the destination",
		steps[0]["path"] == [Vector2i(6, 5), Vector2i(6, 6)],
		"got %s" % [steps[0]["path"]])

	# A kill is an attack followed by a destruction, in that order.
	var fight := EventAnimator.plan([
		{"type": "unitAttacked", "attackerId": "a1", "defenderId": "b1",
			"damage": 55, "counterDamage": 0},
		{"type": "unitDestroyed", "unitId": "b1", "at": {"x": 7, "y": 4}},
	])
	_check("a kill plans attack then destroy", _kinds(fight) == ["attack", "destroy"],
		"got %s" % [_kinds(fight)])

	# Events that only change state have nothing to animate.
	var quiet := EventAnimator.plan([
		{"type": "turnStarted", "slot": 2, "roundNumber": 3, "income": 5000},
		{"type": "captureProgressed", "unitId": "a2", "progress": 10},
		{"type": "unitBuilt", "unitId": "n1", "unitType": "recon",
			"at": {"x": 2, "y": 0}, "cost": 400},
		{"type": "playerDefeated", "slot": 1, "reason": "hq_captured"},
	])
	_check("state-only events produce no steps", quiet.is_empty(),
		"got %s" % [_kinds(quiet)])

	_check("a capture plans a flash",
		_kinds(EventAnimator.plan([{"type": "tileCaptured", "x": 5, "y": 3, "bySlot": 1}]))
		== ["capture"])

	# A move whose path was entirely out of sight arrives with nothing to walk.
	var empty := EventAnimator.plan([{"type": "unitMoved", "unitId": "b1",
		"from": {"x": 0, "y": 0}, "to": {"x": 0, "y": 0}, "path": [], "fuelSpent": 0}])
	_check("a move with an empty path plans nothing", empty.is_empty())

	_check("plan is pure and repeatable",
		_kinds(EventAnimator.plan([moved])) == _kinds(EventAnimator.plan([moved])))


## --- playback ----------------------------------------------------------

func _build() -> void:
	if _match != null:
		_match.queue_free()
		await get_tree().process_frame

	_match = MATCH_SCENE.instantiate()
	add_child(_match)
	_controller = _match.get_node("MatchController")
	_board = _match.get_node("Board")
	_controller.set_animation_scale(0.0)
	_controller.load_view(Fixtures.match_view())
	await get_tree().process_frame


func _check_playback() -> void:
	await _build()
	var animator: EventAnimator = _controller.get_node("EventAnimator")

	var tank := _board.unit_node("a1")
	_check("the unit starts where the state put it",
		tank.position == _board.world_at_tile(Vector2i(6, 4)), "at %s" % tank.position)

	await animator.play([{"type": "unitMoved", "unitId": "a1",
		"from": {"x": 6, "y": 4}, "to": {"x": 6, "y": 6},
		"path": [{"x": 6, "y": 5}, {"x": 6, "y": 6}], "fuelSpent": 2}])
	_check("playing a move leaves the unit at the destination",
		tank.position == _board.world_at_tile(Vector2i(6, 6)), "at %s" % tank.position)

	# A unit revealed by this very update has no node yet. That is ordinary,
	# not an error - the render that follows will place it.
	await animator.play([{"type": "unitMoved", "unitId": "ghost",
		"from": {"x": 0, "y": 0}, "to": {"x": 1, "y": 0},
		"path": [{"x": 1, "y": 0}], "fuelSpent": 1}])
	_check("animating a unit with no node is survivable", true)

	# Combat: damage numbers appear, and the destroyed node is left for the
	# render to remove rather than freed here.
	var effects_before := _board.effects_layer.get_child_count()
	await animator.play([
		{"type": "unitAttacked", "attackerId": "a1", "defenderId": "b1",
			"damage": 55, "counterDamage": 20},
		{"type": "unitDestroyed", "unitId": "b1", "at": {"x": 7, "y": 4}},
	])
	_check("combat spawns damage numbers",
		_board.effects_layer.get_child_count() > effects_before,
		"%d -> %d" % [effects_before, _board.effects_layer.get_child_count()])
	_check("a destroyed unit's node is faded, not freed",
		_board.unit_node("b1") != null and _board.unit_node("b1").modulate.a < 0.01)

	_check("the attacker returns to its own tile after lunging",
		_board.unit_node("a1").position == _board.world_at_tile(Vector2i(6, 6)),
		"at %s" % _board.unit_node("a1").position)

	# An abandoned animation must not leave a unit permanently ghosted.
	var ghosted := _board.unit_node("a1")
	ghosted.modulate.a = 0.0
	ghosted.scale = Vector2(0.6, 0.6)
	ghosted.bind(_controller.state().units["a1"])
	_check("re-binding a unit restores it from a half-played animation",
		ghosted.modulate.a == 1.0 and ghosted.scale == Vector2.ONE,
		"alpha %f scale %s" % [ghosted.modulate.a, ghosted.scale])

	await animator.play([{"type": "tileCaptured", "x": 5, "y": 3, "bySlot": 1}])
	_check("a capture flash cleans itself up",
		_board.effects_layer.get_child_count() < 20,
		"%d leftover effects" % _board.effects_layer.get_child_count())
	_phases += 1


## The render must come after the animation, or there is nothing to move.
func _check_render_waits_for_animation() -> void:
	await _build()

	var moved := Fixtures.match_view()
	for unit in moved["units"]:
		if String(unit["id"]) == "a1":
			unit["x"] = 6
			unit["y"] = 6
			unit["hasMoved"] = true

	var events := [{"type": "unitMoved", "unitId": "a1",
		"from": {"x": 6, "y": 4}, "to": {"x": 6, "y": 6},
		"path": [{"x": 6, "y": 5}, {"x": 6, "y": 6}], "fuelSpent": 2}]

	# Exactly what the network path does: adopt the view, then report events.
	var turns: TurnController = _match.get_node("TurnController")
	turns.adopt_view(moved)
	turns.action_confirmed.emit(events)

	_check("the controller reports it is animating", _controller.is_animating())
	_check("the board still shows the old position while it plays",
		_board.unit_node("a1").position == _board.world_at_tile(Vector2i(6, 4)),
		"at %s" % _board.unit_node("a1").position)

	for _i in 20:
		await get_tree().process_frame
		if not _controller.is_animating():
			break

	_check("animating finishes", not _controller.is_animating())
	_check("and the board ends on the adopted state",
		_board.unit_node("a1").position == _board.world_at_tile(Vector2i(6, 6)),
		"at %s" % _board.unit_node("a1").position)
	_phases += 1


## A tap while the board shows stale positions would mean something else by
## the time it landed, so taps are dropped rather than queued.
## An update arriving mid-animation used to leave the first settle to finish:
## it would clear the animating flag and re-render while the second sequence
## was still playing, which is the one thing rule 6 forbids.
func _check_overlapping_updates() -> void:
	await _build()
	_controller.set_animation_scale(1.0)

	var turns: TurnController = _match.get_node("TurnController")
	var first := [{"type": "unitMoved", "unitId": "a1",
		"from": {"x": 6, "y": 4}, "to": {"x": 6, "y": 5},
		"path": [{"x": 6, "y": 5}], "fuelSpent": 1}]
	var second := [{"type": "unitMoved", "unitId": "a4",
		"from": {"x": 3, "y": 2}, "to": {"x": 4, "y": 2},
		"path": [{"x": 4, "y": 2}], "fuelSpent": 1}]

	turns.action_confirmed.emit(first)
	await get_tree().process_frame
	_check("the first animation is running", _controller.is_animating())

	turns.action_confirmed.emit(second)
	await get_tree().process_frame
	_check("a second update keeps the board locked", _controller.is_animating(),
		"the first run cleared the flag out from under the second")

	_controller.set_animation_scale(0.0)
	for _i in 120:
		await get_tree().process_frame
		if not _controller.is_animating():
			break
	_check("and both eventually finish", not _controller.is_animating())
	_phases += 1


func _check_input_is_gated() -> void:
	await _build()
	_controller.set_animation_scale(1.0)

	var sent: Array = []
	var turns: TurnController = _match.get_node("TurnController")
	turns.action_sent.connect(func(action: Dictionary): sent.append(action))

	turns.action_confirmed.emit([{"type": "unitMoved", "unitId": "a1",
		"from": {"x": 6, "y": 4}, "to": {"x": 6, "y": 5},
		"path": [{"x": 6, "y": 5}], "fuelSpent": 1}])
	await get_tree().process_frame

	_check("an animation is running", _controller.is_animating())
	_controller.tap_tile(Vector2i(3, 2))
	_check("taps are ignored while animating", _controller.selected_unit_id().is_empty())
	_check("and nothing is submitted", sent.is_empty())

	# The bar buttons had no animation guard, only tap_tile did - and unlike a
	# tap, End Turn cannot be taken back.
	var bar := _match.get_node("UI/ActionBar")
	bar.wait_pressed.emit()
	bar.end_turn_pressed.emit()
	_check("bar buttons are ignored while animating too", sent.is_empty(),
		"submitted %s" % [sent])

	_controller.set_animation_scale(0.0)
	for _i in 60:
		await get_tree().process_frame
		if not _controller.is_animating():
			break
	_check("input returns once the animation ends", not _controller.is_animating())

	_controller.tap_tile(Vector2i(3, 2))
	_check("and a tap works again", _controller.selected_unit_id() == "a4",
		"selected '%s'" % _controller.selected_unit_id())
	_phases += 1