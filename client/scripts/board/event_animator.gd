class_name EventAnimator
extends Node
## Plays the server's events out on the board before the new state is adopted.
##
## Ordering is the whole trick. TurnController adopts the new view as soon as
## it arrives, but the board is NOT re-rendered until this has finished - so
## the unit nodes still stand where they were, and there is something to
## animate away from. Render afterwards is what makes the result exact: the
## animation is decoration, the adopted state is the truth.
##
## Split in two on purpose. `plan()` turns events into steps and is pure, so
## the sequencing can be asserted without waiting on a single tween.
## `play()` executes a plan and tolerates anything missing - a unit that was
## hidden by fog a moment ago has no node to animate, and that is normal
## rather than an error.
##
## The events are already fog-filtered by the server (game/view.ts), so this
## can only ever animate things the player is allowed to see.

signal finished()

const MOVE_SECONDS_PER_TILE := 0.09
const MOVE_MINIMUM := 0.14
const LUNGE_SECONDS := 0.11
const DESTROY_SECONDS := 0.26
const CAPTURE_FLASH_SECONDS := 0.45
const DAMAGE_FLOAT_SECONDS := 0.75
## How far into the target's tile an attacker leans, as a fraction of a tile.
const LUNGE_FRACTION := 0.3

## 1.0 for normal play; tests set 0.0 to run a whole sequence in a few frames.
var duration_scale: float = 1.0

var _board: Board = null
var _generation := 0
var _playing := false


func setup(board: Board) -> void:
	_board = board


func is_playing() -> bool:
	return _playing


## Turn server events into animation steps. Pure: no board, no node lookups,
## no side effects. Events with nothing to show produce no step.
static func plan(events: Array) -> Array[Dictionary]:
	var steps: Array[Dictionary] = []

	for event in events:
		var data: Dictionary = event
		match String(data.get("type", "")):
			"unitMoved":
				var path := _to_tiles(data.get("path", []))
				if path.is_empty():
					continue
				steps.append({
					"kind": "move",
					"unit_id": String(data.get("unitId", "")),
					"path": path,
				})
			"unitAttacked":
				steps.append({
					"kind": "attack",
					"attacker_id": String(data.get("attackerId", "")),
					"defender_id": String(data.get("defenderId", "")),
					"damage": int(data.get("damage", 0)),
					"counter_damage": int(data.get("counterDamage", 0)),
				})
			"unitDestroyed":
				steps.append({
					"kind": "destroy",
					"unit_id": String(data.get("unitId", "")),
				})
			"tileCaptured":
				steps.append({
					"kind": "capture",
					"tile": Vector2i(int(data.get("x", 0)), int(data.get("y", 0))),
					"slot": int(data.get("bySlot", 0)),
				})
			_:
				# turnStarted, unitBuilt, captureProgressed, playerDefeated and
				# matchFinished all show up in the state the board renders
				# next; there is nothing to move on the way there.
				pass

	return steps


static func _to_tiles(raw: Array) -> Array[Vector2i]:
	var tiles: Array[Vector2i] = []
	for entry in raw:
		var step: Dictionary = entry
		tiles.append(Vector2i(int(step.get("x", 0)), int(step.get("y", 0))))
	return tiles


## Play the events. Awaitable: the caller renders the new state when this
## returns. A newer batch arriving mid-sequence abandons the current one
## rather than queueing, because the newer state is the one worth showing.
func play(events: Array) -> void:
	if _board == null:
		return

	_generation += 1
	var generation := _generation
	_playing = true

	for step in plan(events):
		if generation != _generation:
			break
		await _play_step(step)

	if generation == _generation:
		_playing = false
		finished.emit()


func _play_step(step: Dictionary) -> void:
	match String(step.get("kind", "")):
		"move":
			await _animate_move(step)
		"attack":
			await _animate_attack(step)
		"destroy":
			await _animate_destroy(step)
		"capture":
			await _animate_capture(step)


func _seconds(base: float) -> float:
	return maxf(base * duration_scale, 0.0)


## Walks the unit along the path it actually took, so a move round a
## mountain reads as going round it rather than sliding through it.
func _animate_move(step: Dictionary) -> void:
	var unit := _board.unit_node(String(step.get("unit_id", "")))
	if unit == null:
		return  # Was hidden by fog until now; render will place it.

	var path: Array = step.get("path", [])
	if path.is_empty():
		return

	var per_tile := _seconds(MOVE_SECONDS_PER_TILE)
	var tween := create_tween()
	for tile in path:
		tween.tween_property(unit, "position", _board.world_at_tile(tile),
			maxf(per_tile, _seconds(MOVE_MINIMUM) / float(path.size())))
	await tween.finished


func _animate_attack(step: Dictionary) -> void:
	var attacker := _board.unit_node(String(step.get("attacker_id", "")))
	var defender := _board.unit_node(String(step.get("defender_id", "")))

	if attacker != null and defender != null:
		await _lunge(attacker, defender)

	if defender != null and int(step.get("damage", 0)) > 0:
		_show_damage(defender.position, int(step["damage"]))
	if attacker != null and int(step.get("counter_damage", 0)) > 0:
		_show_damage(attacker.position, int(step["counter_damage"]))

	# Let the numbers be readable before the next step lands on top of them.
	if duration_scale > 0.0:
		await get_tree().create_timer(_seconds(DAMAGE_FLOAT_SECONDS) * 0.5).timeout


## Adjacent attackers lean into the target. Indirect fire happens from
## several tiles away, where a lunge would look like a charge, so those
## recoil in place instead.
func _lunge(attacker: Unit, defender: Unit) -> void:
	var origin := attacker.position
	var offset := defender.position - origin
	var tiles := offset.length() / float(BoardTheme.TILE_SIZE)

	var target := origin
	if tiles <= 1.5:
		target = origin + offset * LUNGE_FRACTION
	else:
		target = origin - offset.normalized() * (BoardTheme.TILE_SIZE * 0.15)

	var tween := create_tween()
	tween.tween_property(attacker, "position", target, _seconds(LUNGE_SECONDS))
	tween.tween_property(attacker, "position", origin, _seconds(LUNGE_SECONDS))
	await tween.finished


func _animate_destroy(step: Dictionary) -> void:
	var unit := _board.unit_node(String(step.get("unit_id", "")))
	if unit == null:
		return

	var tween := create_tween()
	tween.set_parallel(true)
	tween.tween_property(unit, "modulate:a", 0.0, _seconds(DESTROY_SECONDS))
	tween.tween_property(unit, "scale", Vector2(0.6, 0.6), _seconds(DESTROY_SECONDS))
	await tween.finished
	# The node is not freed here - the render that follows removes it, so
	# there is exactly one place units appear and disappear.


func _animate_capture(step: Dictionary) -> void:
	var tile: Vector2i = step.get("tile", Vector2i.ZERO)
	var flash := ColorRect.new()
	flash.color = BoardTheme.slot_color(int(step.get("slot", 0)))
	flash.position = _board.world_at_tile(tile)
	flash.size = Vector2(BoardTheme.TILE_SIZE, BoardTheme.TILE_SIZE)
	flash.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_board.effects_layer.add_child(flash)

	var tween := create_tween()
	tween.tween_property(flash, "modulate:a", 0.0, _seconds(CAPTURE_FLASH_SECONDS))
	await tween.finished
	flash.queue_free()


func _show_damage(at: Vector2, amount: int) -> void:
	var label := Label.new()
	label.text = "-%d" % GameData.display_hp(amount)
	label.position = at + Vector2(0, -6)
	label.size = Vector2(BoardTheme.TILE_SIZE, 16)
	label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	label.add_theme_color_override("font_color", Color("#ffe08a"))
	label.add_theme_font_size_override("font_size", 12)
	label.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_board.effects_layer.add_child(label)

	var tween := create_tween()
	tween.set_parallel(true)
	tween.tween_property(label, "position", label.position + Vector2(0, -18),
		_seconds(DAMAGE_FLOAT_SECONDS))
	tween.tween_property(label, "modulate:a", 0.0, _seconds(DAMAGE_FLOAT_SECONDS))
	tween.chain().tween_callback(label.queue_free)
