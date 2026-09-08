class_name Unit
extends Node2D
## The visual representation of one unit on the board.
##
## Holds no authoritative data of its own: it is bound to an entry from
## MatchState and re-reads it. Stats always come from GameData by unit type,
## never hardcoded here, so rebalancing is a data edit and nothing else.

const TILE_SIZE := 32

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
	position = Vector2(grid_position) * TILE_SIZE


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


# TODO: sprite/animation per unit_type and faction colour (original art - see
# docs/ROADMAP.md Phase 3), damage-number popups, and the move/attack tweens
# driven by the events in Net.update_received.
