extends Node
## Checks the touch plumbing: that a real touch event becomes a tap on the
## right tile, and that a pan or a pinch does not.
##
## This one needs a REAL display server. Under --headless the dummy driver
## never dispatches synthesised input, so the events would silently go
## nowhere and every check would pass vacuously. Run it under xvfb:
##
##   cd client && xvfb-run -a godot --resolution 1280x720 res://tests/gesture_check.tscn
##
## The interaction *rules* are covered headlessly by input_check; this covers
## only the layer beneath them - screen coordinates, and telling a tap from
## a drag.

const BOARD_SCENE := preload("res://scenes/board.tscn")
const PAN_DISTANCE := 80.0

var _failures := 0
var _board: Board = null
var _taps: Array[Vector2i] = []


func _ready() -> void:
	_board = BOARD_SCENE.instantiate()
	add_child(_board)
	_board.render(MatchState.from_view(Fixtures.match_view()))
	_board.tile_tapped.connect(func(tile: Vector2i): _taps.append(tile))

	await get_tree().process_frame
	await get_tree().process_frame

	if not await _check_dispatch_works():
		printerr("gesture_check: input is not being dispatched - run under xvfb, not --headless")
		get_tree().quit(1)
		return

	await _check_taps_hit_the_right_tile()
	await _check_pan_is_not_a_tap()
	await _check_pinch_is_not_a_tap()
	await _check_wheel_zooms()

	if _failures == 0:
		print("\ngesture_check: all checks passed")
	else:
		printerr("\ngesture_check: %d check(s) FAILED" % _failures)
	get_tree().quit(0 if _failures == 0 else 1)


func _check(label: String, condition: bool, detail: String = "") -> void:
	if condition:
		print("ok   %s" % label)
	else:
		_failures += 1
		printerr("FAIL %s%s" % [label, "" if detail.is_empty() else " (%s)" % detail])


## Guard against the whole suite passing vacuously because nothing was
## delivered - the exact failure mode that made this a separate scene.
func _check_dispatch_works() -> bool:
	_taps.clear()
	await _tap_at(_screen_of(Vector2i(5, 3)))
	return not _taps.is_empty()


## Screen position of the CENTRE of a tile. Tile corners sit exactly on a
## boundary, where the float maths through the camera transform can land
## either side; real taps are interior, so the tests are too.
func _screen_of(tile: Vector2i) -> Vector2:
	var half := BoardTheme.TILE_SIZE * 0.5
	var world := Vector2(tile) * BoardTheme.TILE_SIZE + Vector2(half, half)
	return get_viewport().get_canvas_transform() * world


func _touch(position: Vector2, pressed: bool, index: int = 0) -> void:
	var event := InputEventScreenTouch.new()
	event.index = index
	event.position = position
	event.pressed = pressed
	Input.parse_input_event(event)
	Input.flush_buffered_events()


func _drag(position: Vector2, relative: Vector2, index: int = 0) -> void:
	var event := InputEventScreenDrag.new()
	event.index = index
	event.position = position
	event.relative = relative
	Input.parse_input_event(event)
	Input.flush_buffered_events()


func _tap_at(position: Vector2) -> void:
	_touch(position, true)
	_touch(position, false)
	await get_tree().process_frame


func _check_taps_hit_the_right_tile() -> void:
	for tile in [Vector2i(5, 3), Vector2i(9, 6), Vector2i(0, 0), Vector2i(14, 9)]:
		_taps.clear()
		await _tap_at(_screen_of(tile))
		_check("a tap on %s lands on %s" % [tile, tile],
			_taps.size() == 1 and _taps[0] == tile, "got %s" % [_taps])


func _check_pan_is_not_a_tap() -> void:
	var start := _screen_of(Vector2i(5, 3))
	_taps.clear()

	_touch(start, true)
	# Several small drags, the way a real finger arrives.
	for i in 4:
		_drag(start + Vector2(PAN_DISTANCE * (i + 1) / 4.0, 0), Vector2(PAN_DISTANCE / 4.0, 0))
	_touch(start + Vector2(PAN_DISTANCE, 0), false)
	await get_tree().process_frame

	_check("a pan does not register as a tap", _taps.is_empty(), "got %s" % [_taps])

	# ...and the very next tap still works, which is what breaks if the drag
	# distance is reset on release instead of on press.
	_taps.clear()
	await _tap_at(_screen_of(Vector2i(5, 3)))
	_check("a tap straight after a pan still registers", _taps.size() == 1,
		"got %s" % [_taps])


func _check_pinch_is_not_a_tap() -> void:
	var a := _screen_of(Vector2i(4, 3))
	var b := _screen_of(Vector2i(8, 6))
	_taps.clear()

	_touch(a, true, 0)
	_touch(b, true, 1)
	_drag(a + Vector2(-20, 0), Vector2(-20, 0), 0)
	_drag(b + Vector2(20, 0), Vector2(20, 0), 1)
	_touch(a + Vector2(-20, 0), false, 0)
	_touch(b + Vector2(20, 0), false, 1)
	await get_tree().process_frame

	_check("a pinch does not register as a tap", _taps.is_empty(), "got %s" % [_taps])


func _check_wheel_zooms() -> void:
	var before: float = _board.camera.zoom.x

	var event := InputEventMouseButton.new()
	event.button_index = MOUSE_BUTTON_WHEEL_UP
	event.pressed = true
	event.position = get_viewport().get_visible_rect().size * 0.5
	Input.parse_input_event(event)
	Input.flush_buffered_events()
	await get_tree().process_frame

	_check("the wheel zooms the camera in", _board.camera.zoom.x > before,
		"%f -> %f" % [before, _board.camera.zoom.x])
