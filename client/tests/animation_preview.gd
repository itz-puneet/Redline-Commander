extends Node
## Captures the animation mid-flight, so it can be looked at rather than only
## asserted on.
##
## Plays a move, then an attack that kills, and screenshots partway through
## the combat - when the lunge has landed and the damage numbers are still
## floating. Frames go to user://anim_<n>.png.
##
##   cd client && xvfb-run -a godot --resolution 1280x720 res://tests/animation_preview.tscn

const MATCH_SCENE := preload("res://scenes/match.tscn")

var _board: Board = null
var _frame := 0


func _ready() -> void:
	var match_scene := MATCH_SCENE.instantiate()
	add_child(match_scene)

	var controller: MatchController = match_scene.get_node("MatchController")
	_board = match_scene.get_node("Board")
	controller.load_view(Fixtures.match_view())
	controller.tap_tile(Vector2i(6, 4))

	# Burn the start-up frames first. Shader compilation on the first frames
	# eats enough wall time that a timer set before it fires late, and the
	# capture lands after the animation instead of during it.
	for _i in 30:
		await get_tree().process_frame

	var animator: EventAnimator = controller.get_node("EventAnimator")

	# Mid-move.
	animator.play([{"type": "unitMoved", "unitId": "a4",
		"from": {"x": 3, "y": 2}, "to": {"x": 6, "y": 2},
		"path": [{"x": 4, "y": 2}, {"x": 5, "y": 2}, {"x": 6, "y": 2}], "fuelSpent": 3}])
	await get_tree().create_timer(0.13).timeout
	await _capture()

	# Mid-combat: lunge done, damage numbers up.
	animator.play([
		{"type": "unitAttacked", "attackerId": "a1", "defenderId": "b1",
			"damage": 62, "counterDamage": 18},
		{"type": "unitDestroyed", "unitId": "b1", "at": {"x": 7, "y": 4}},
	])
	await get_tree().create_timer(0.28).timeout
	await _capture()

	print("animation_preview: wrote %d frames to %s" % [_frame,
		ProjectSettings.globalize_path("user://")])
	get_tree().quit(0)


func _capture() -> void:
	await RenderingServer.frame_post_draw
	var image := get_viewport().get_texture().get_image()
	_frame += 1
	image.save_png("user://anim_%d.png" % _frame)
