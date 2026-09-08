class_name Unit
extends Node2D
## The visual representation of one unit on the board.
##
## Holds no authoritative data of its own: it is bound to an entry from
## MatchState and re-reads it. Stats always come from GameData by unit type,
## never hardcoded here, so rebalancing is a data edit and nothing else.
##
## Everything drawn below is placeholder geometry standing in for sprite art
## (docs/ROADMAP.md Phase 4). Replacing it means swapping _draw() for a
## Sprite2D and an AnimationPlayer; nothing outside this file cares.

var unit_id: String = ""
var unit_type: String = "infantry"
var owner_slot: int = 0
var grid_position := Vector2i.ZERO
var hp: int = 100
var has_moved: bool = false
var has_acted: bool = false
var capture_progress: int = 0
## Enemy units are reported without fuel/ammo - the server does not send what
## the player is not entitled to see.
var fuel: int = -1
var ammo: int = -1


func bind(data: Dictionary) -> void:
	unit_id = String(data.get("id", ""))
	unit_type = String(data.get("unitType", "infantry"))
	owner_slot = int(data.get("ownerSlot", 0))
	grid_position = Vector2i(int(data.get("x", 0)), int(data.get("y", 0)))
	hp = int(data.get("hp", 100))
	has_moved = bool(data.get("hasMoved", false))
	has_acted = bool(data.get("hasActed", false))
	capture_progress = int(data.get("captureProgress", 0))
	fuel = -1 if data.get("fuel") == null else int(data.get("fuel"))
	ammo = -1 if data.get("ammo") == null else int(data.get("ammo"))
	position = Vector2(grid_position) * BoardTheme.TILE_SIZE
	queue_redraw()


func stats() -> Dictionary:
	return GameData.unit_stats(unit_type)


func display_name() -> String:
	return String(stats().get("display_name", unit_type))


func display_hp() -> int:
	return GameData.display_hp(hp)


func is_mine(you_slot: int) -> bool:
	return owner_slot == you_slot


## Whether the local player could still order this unit to do something.
func is_selectable(you_slot: int, my_turn: bool) -> bool:
	return my_turn and is_mine(you_slot) and not has_acted


func can_capture() -> bool:
	return bool(stats().get("can_capture", false))


func _draw() -> void:
	var size := float(BoardTheme.TILE_SIZE)
	var color := BoardTheme.slot_color(owner_slot)
	var body := Rect2(3, 3, size - 6, size - 6)

	draw_rect(body, color.darkened(0.35))
	draw_rect(body.grow(-1.0), color)

	var font := ThemeDB.fallback_font
	draw_string(font, Vector2(0, size * 0.62), BoardTheme.unit_label(unit_type),
		HORIZONTAL_ALIGNMENT_CENTER, size, 9, Color.WHITE)

	# Damaged units show their pip count, the way the player reads health.
	var pips := display_hp()
	if pips < 10:
		var badge := Rect2(size - 11, size - 10, 10, 9)
		draw_rect(badge, Color(0, 0, 0, 0.7))
		draw_string(font, Vector2(size - 11, size - 2.5), str(pips),
			HORIZONTAL_ALIGNMENT_CENTER, 10, 8, Color.WHITE)

	if capture_progress > 0:
		var ratio := clampf(capture_progress / 20.0, 0.0, 1.0)
		draw_rect(Rect2(3, 3, (size - 6) * ratio, 2.5), Color("#ffd766"))

	# A unit that has already acted is greyed out, so "what can still move"
	# is readable without tapping anything.
	if has_acted:
		draw_rect(body, BoardTheme.SPENT_TINT)


# TODO: real sprites per unit_type and faction, move/attack tweens driven by
# the events from Net.update_received, and damage-number popups.
