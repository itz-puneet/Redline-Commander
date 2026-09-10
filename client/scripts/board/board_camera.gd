class_name BoardCamera
extends Camera2D
## Camera framing and navigation for the board.
##
## Handles *camera* gestures only - drag to pan, wheel or pinch to zoom. Unit
## selection is not here: it belongs to the board, so that a tap which
## selects and a drag which pans stay separable.
##
## The project sets pointing/emulate_touch_from_mouse, so a mouse drag also
## arrives as InputEventScreenDrag. This listens to the touch events ONLY
## (plus the wheel, which has no touch equivalent) - handling both families
## would apply every pan twice on desktop.
##
## Uses _unhandled_input so HUD controls get first refusal on every event.

# Lowered when TILE_SIZE went to 48: the same map is half again as many
# world pixels, so the zoom that frames a large one is proportionally
# smaller and would otherwise hit the floor and crop.
const MIN_ZOOM := 0.35
const MAX_ZOOM := 4.0
## A gesture that travels further than this is a pan, not a tap.
const DRAG_THRESHOLD := 8.0

## Screen-space height at the bottom of the viewport that the HUD covers.
## The camera frames the map into what is left, so the bottom row of the
## board does not end up hidden behind the action bar.
var bottom_inset: float = 0.0

var _map_rect := Rect2()
var _touch_points: Dictionary = {}
var _pinch_distance := 0.0
## Distance travelled by the current or most recently finished gesture. Reset
## on press, not on release, so the board can still tell - on the release
## event itself - whether the gesture that just ended was a drag.
var _gesture_distance := 0.0
var _gesture_was_multi_touch := false


## Frame the whole map with a little margin. Called whenever a new match is
## rendered, so the board is readable before the player touches anything.
func frame_map(width: int, height: int) -> void:
	var size := float(BoardTheme.TILE_SIZE)
	_map_rect = Rect2(0, 0, width * size, height * size)
	position = _map_rect.get_center()

	var viewport := get_viewport_rect().size
	if viewport.x <= 0.0 or viewport.y <= 0.0 or _map_rect.size.x <= 0.0:
		return

	var usable_height: float = maxf(viewport.y - bottom_inset, 1.0)
	var margin := 1.08
	var fit: float = minf(viewport.x / (_map_rect.size.x * margin),
		usable_height / (_map_rect.size.y * margin))
	var level := clampf(fit, MIN_ZOOM, MAX_ZOOM)
	zoom = Vector2(level, level)

	# Look slightly below the map's centre so the map lands in the usable
	# area rather than centred behind the HUD.
	position.y += (bottom_inset * 0.5) / level


## Whether the gesture that just ended was a pan or pinch rather than a tap.
## The board checks this on release to decide if the touch was a tap.
func was_dragged() -> bool:
	return _gesture_was_multi_touch or _gesture_distance > DRAG_THRESHOLD


func _unhandled_input(event: InputEvent) -> void:
	if event is InputEventScreenTouch:
		_handle_touch(event)
	elif event is InputEventScreenDrag:
		_handle_drag(event)
	elif event is InputEventMouseButton:
		_handle_wheel(event)


func _handle_wheel(event: InputEventMouseButton) -> void:
	if not event.pressed:
		return
	if event.button_index == MOUSE_BUTTON_WHEEL_UP:
		_apply_zoom(1.1)
	elif event.button_index == MOUSE_BUTTON_WHEEL_DOWN:
		_apply_zoom(1.0 / 1.1)


func _handle_touch(event: InputEventScreenTouch) -> void:
	if event.pressed:
		# A new gesture starts here, so this is where the travel resets.
		if _touch_points.is_empty():
			_gesture_distance = 0.0
			_gesture_was_multi_touch = false
		_touch_points[event.index] = event.position
		if _touch_points.size() > 1:
			_gesture_was_multi_touch = true
	else:
		_touch_points.erase(event.index)
		_pinch_distance = 0.0


func _handle_drag(event: InputEventScreenDrag) -> void:
	_touch_points[event.index] = event.position

	if _touch_points.size() == 1:
		_pan(event.relative)
		return

	# Two fingers: zoom by the change in their separation.
	if _touch_points.size() == 2:
		_gesture_was_multi_touch = true
		var points: Array = _touch_points.values()
		var distance: float = (points[0] as Vector2).distance_to(points[1] as Vector2)
		if _pinch_distance > 0.0 and distance > 0.0:
			_apply_zoom(distance / _pinch_distance)
		_pinch_distance = distance


func _pan(relative: Vector2) -> void:
	_gesture_distance += relative.length()
	position -= relative / zoom.x
	_clamp_to_map()


func _apply_zoom(factor: float) -> void:
	var level := clampf(zoom.x * factor, MIN_ZOOM, MAX_ZOOM)
	zoom = Vector2(level, level)
	_clamp_to_map()


## Keep the map roughly on screen - panning into empty space is disorienting
## on a phone where there is no scrollbar to tell you where you are.
func _clamp_to_map() -> void:
	if _map_rect.size == Vector2.ZERO:
		return
	var slack := get_viewport_rect().size / zoom.x * 0.5
	position.x = clampf(position.x, _map_rect.position.x - slack.x, _map_rect.end.x + slack.x)
	position.y = clampf(position.y, _map_rect.position.y - slack.y, _map_rect.end.y + slack.y)
