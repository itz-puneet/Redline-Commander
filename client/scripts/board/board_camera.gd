class_name BoardCamera
extends Camera2D
## Camera framing and navigation for the board.
##
## Handles *camera* gestures only - drag to pan, wheel or pinch to zoom. Unit
## selection is not here: it belongs to the board's input handling so that a
## tap which selects a unit and a drag which pans the map stay separable.
##
## Uses _unhandled_input so HUD controls get first refusal on every event.

const MIN_ZOOM := 0.5
const MAX_ZOOM := 4.0
## A press that moves further than this is a pan, not a tap.
const DRAG_THRESHOLD := 8.0

var _map_rect := Rect2()
var _dragging := false
var _drag_distance := 0.0
var _touch_points: Dictionary = {}
var _pinch_distance := 0.0


## Frame the whole map with a little margin. Called whenever a new match is
## rendered, so the board is readable before the player touches anything.
func frame_map(width: int, height: int) -> void:
	var size := float(BoardTheme.TILE_SIZE)
	_map_rect = Rect2(0, 0, width * size, height * size)
	position = _map_rect.get_center()

	var viewport := get_viewport_rect().size
	if viewport.x <= 0.0 or viewport.y <= 0.0 or _map_rect.size.x <= 0.0:
		return

	var margin := 1.08
	var fit: float = minf(viewport.x / (_map_rect.size.x * margin),
		viewport.y / (_map_rect.size.y * margin))
	var level := clampf(fit, MIN_ZOOM, MAX_ZOOM)
	zoom = Vector2(level, level)


## True while the player is panning, so the board can ignore the release that
## ends a drag rather than treating it as a tap on a tile.
func is_panning() -> bool:
	return _dragging and _drag_distance > DRAG_THRESHOLD


func _unhandled_input(event: InputEvent) -> void:
	if event is InputEventMouseButton:
		_handle_mouse_button(event)
	elif event is InputEventMouseMotion and _dragging:
		_pan(event.relative)
	elif event is InputEventScreenTouch:
		_handle_touch(event)
	elif event is InputEventScreenDrag:
		_handle_drag(event)


func _handle_mouse_button(event: InputEventMouseButton) -> void:
	match event.button_index:
		MOUSE_BUTTON_LEFT:
			_dragging = event.pressed
			if event.pressed:
				_drag_distance = 0.0
		MOUSE_BUTTON_WHEEL_UP:
			if event.pressed:
				_apply_zoom(1.1)
		MOUSE_BUTTON_WHEEL_DOWN:
			if event.pressed:
				_apply_zoom(1.0 / 1.1)


func _handle_touch(event: InputEventScreenTouch) -> void:
	if event.pressed:
		_touch_points[event.index] = event.position
		if _touch_points.size() == 1:
			_dragging = true
			_drag_distance = 0.0
	else:
		_touch_points.erase(event.index)
		if _touch_points.is_empty():
			_dragging = false
		_pinch_distance = 0.0


func _handle_drag(event: InputEventScreenDrag) -> void:
	_touch_points[event.index] = event.position

	if _touch_points.size() == 1:
		_pan(event.relative)
		return

	# Two fingers: zoom by the change in their separation.
	if _touch_points.size() == 2:
		var points: Array = _touch_points.values()
		var distance: float = (points[0] as Vector2).distance_to(points[1] as Vector2)
		if _pinch_distance > 0.0 and distance > 0.0:
			_apply_zoom(distance / _pinch_distance)
		_pinch_distance = distance


func _pan(relative: Vector2) -> void:
	_drag_distance += relative.length()
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
